/**
 * OpenCode v2 Integration
 * =======================
 *
 * Runs OpenCode chat turns against OpenCode 2's HTTP API through the official
 * `@opencode/client`.
 *
 * Every turn gets its own `opencode serve`, started by this runtime and stopped
 * when the turn ends. The client then creates or resumes the session, sends
 * the prompt, follows the server's event stream and answers the two requests
 * OpenCode makes of its user while a turn runs:
 *
 * - `permission.asked` — a tool call the user's permission rules mark `ask`
 *   (for example reading an uploaded attachment, which lives outside the
 *   project). It reaches the chat as a `permission_request`, and the chat's
 *   decision goes back as OpenCode's `once`, `always` or `reject`.
 * - `form.created` — a form the agent wants filled in, which is how OpenCode 2
 *   delivers its `question` tool. It reaches the chat as an AskUserQuestion
 *   prompt; the picked labels go back as the form's answer, and Dismiss
 *   cancels the form.
 *
 * A server per turn, rather than OpenCode's shared background service, is
 * deliberate: the turn's server reads the current config, credentials and MCP
 * servers when it starts, it is private to its turn so every request it raises
 * is the turn's, and stopping it is the reliable way to end a stopped turn.
 *
 * Only OpenCode 2 is supported: OpenCode 1's API, events and database are
 * different, and a 1.x server is refused before any prompt is sent.
 *
 * ## Usage
 *
 * - opencodeRuntime.run(command, options, writer, context) - Run one turn
 * - opencodeRuntime.abort(sessionId) - Stop the turn running for a session
 * - opencodeRuntime.permissions - Answer or list the prompts a turn is waiting on
 */

import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import spawn from 'cross-spawn';
import { OpenCode } from '@opencode/client';
import type {
  FormInfo,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionRequest as OpenCodePermissionRequest,
  TokenUsageInfo,
} from '@opencode/client';

// eslint-disable-next-line boundaries/no-unknown -- Shared configuration helper is not classified by the legacy boundary map.
import { readEnv } from '@/shared/env.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  readObjectRecord,
} from '@/shared/utils.js';
import type {
  AnyRecord,
  ProviderModelsDefinition,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`,
// `sessionId = null`) infer as the only accepted types; these state the shapes
// callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;
const reportRunStopped = notifyRunStopped as (input: AnyRecord) => void;
const reportRunFailed = notifyRunFailed as (input: AnyRecord) => void;

const PROVIDER = 'opencode';

const NOT_INSTALLED_MESSAGE = 'OpenCode CLI is not installed. Install OpenCode 2 or newer from https://opencode.ai/docs/';

/** Oldest OpenCode major version whose API this runtime speaks. */
const MIN_OPENCODE_MAJOR_VERSION = 2;

/**
 * How long `opencode serve` may take to print its address. A first start
 * (database migration, plugin install) or a busy machine can take a while.
 */
const SERVER_START_TIMEOUT_MS = 60_000;

/**
 * How long the event stream may take to confirm it is connected. The first
 * request for a project waits while OpenCode opens it (config, plugins, MCP
 * servers), which a project with slow plugins can stretch well past a few
 * seconds, so it gets the same budget as the server start.
 */
const EVENT_STREAM_CONNECT_TIMEOUT_MS = SERVER_START_TIMEOUT_MS;

/**
 * Names, in each turn server's environment, the Bowcode process that started
 * it, so a later Bowcode can tell the servers of a process that died without
 * stopping them.
 */
const OWNER_PID_ENV = 'BOWCODE_OPENCODE_OWNER_PID';

/** How long stopping a turn waits for OpenCode's interrupt before stopping the server anyway. */
const SESSION_ABORT_TIMEOUT_MS = 5_000;

/** How long a stopped server may take to exit before it is killed. */
const SERVER_STOP_GRACE_MS = 3_000;

/** Line `opencode serve` prints once it accepts connections. */
const SERVER_LISTENING_PATTERN = /listening on\s+(https?:\/\/\S+)/i;

/**
 * Told to the agent when nobody can answer its question (bypassPermissions,
 * /api/agent runs), so it carries on instead of waiting.
 */
const UNANSWERED_QUESTION_MESSAGE = 'The user is not available to answer questions right now. Continue with your best judgment.';

const readTimeoutFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(name.startsWith('BOWCODE_') ? readEnv(name as `BOWCODE_${string}`) ?? '' : process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Unanswered permission prompts are rejected after this long (0 waits), the
 * same default the Claude runtime uses, so a run nobody watches does not hold
 * its server forever.
 */
const TOOL_APPROVAL_TIMEOUT_MS = readTimeoutFromEnv('OPENCODE_TOOL_APPROVAL_TIMEOUT_MS', 55_000);

/**
 * Unanswered questions are dismissed after this long (0 waits). Longer than
 * for permissions: a question usually needs thought, not just a yes or no.
 */
const QUESTION_TIMEOUT_MS = readTimeoutFromEnv('OPENCODE_QUESTION_TIMEOUT_MS', 30 * 60_000);

/**
 * Upper bound on how many chats keep their "Always allow" approvals in memory.
 * The least recently approving chat is forgotten first.
 */
const MAX_REMEMBERED_APPROVAL_SESSIONS = 500;

/** Permission actions acceptEdits approves without asking: OpenCode's file-changing tools. */
const OPENCODE_EDIT_ACTIONS = new Set(['edit', 'write', 'patch', 'apply_patch']);

/** How a chat's decision reaches OpenCode's permission API. */
type OpenCodePermissionReply = 'once' | 'always' | 'reject';

/** A running `opencode serve` owned by one turn. */
type OpenCodeServer = { url: string; close(): void };

/** One running turn, keyed in `activeTurns` by the session it runs for. */
type OpenCodeTurn = {
  key: string;
  /** Ends the event stream and stops a server that is still starting. */
  abortController: AbortController;
  server: OpenCodeServer | null;
  client: OpenCodeClient | null;
  providerSessionId: string | null;
  aborted: boolean;
  /** Settles once a requested stop has finished (session interrupted, server stopped). */
  abortFinished: Promise<void> | null;
  /** Wakes a turn that is waiting for OpenCode to finish. */
  finish(): void;
};

/** A permission or question the turn is waiting on the chat to answer. */
type PendingOpenCodePrompt = {
  requestId: string;
  /** Session the chat knows the prompt by: the app session id when there is one. */
  sessionId: string | null;
  toolName: string;
  input: unknown;
  context: AnyRecord;
  receivedAt: Date;
  timer: ReturnType<typeof setTimeout> | undefined;
  answer(decision: ProviderPermissionDecision): void;
  /** Drops the prompt from the chat; `reason` marks a withdrawal (timeout, stop). */
  settle(reason?: string): void;
};

/** A rule an "Always allow" approved: OpenCode action plus one of its `save` patterns. */
type RememberedApproval = {
  permission: string;
  pattern: string;
};

const activeTurns = new Map<string, OpenCodeTurn>();
const pendingPrompts = new Map<string, PendingOpenCodePrompt>();
// "Always allow" is remembered by OpenCode per project only when it saves the
// rule, and the chat cannot tell whether it did. The approved patterns are
// kept here per chat as well (in memory, never persisted), so a later turn in
// the same chat is not asked again for what the user already allowed always.
const rememberedApprovals = new Map<string, RememberedApproval[]>();

// ---------------------------------------------------------------------------
// Permission modes and model options
// ---------------------------------------------------------------------------

/**
 * Picks the OpenCode reply a permission request gets without asking the user,
 * or null when the chat has to ask.
 *
 * - bypassPermissions → `once` for everything, like `opencode run --auto`.
 * - acceptEdits       → `once` for file edits and writes; everything else is asked.
 * - plan / default    → asked (plan's own agent already denies edits).
 *
 * Only `ask` rules produce a request at all: what the user's OpenCode config
 * allows never gets here, and what it denies is denied by OpenCode itself.
 *
 * Exported for tests only.
 */
export function resolveAutomaticPermissionReply(
  permissionMode: unknown,
  permission: string,
): OpenCodePermissionReply | null {
  if (permissionMode === 'bypassPermissions') {
    return 'once';
  }

  if (permissionMode === 'acceptEdits' && OPENCODE_EDIT_ACTIONS.has(permission)) {
    return 'once';
  }

  return null;
}

/**
 * Maps a chat decision onto OpenCode's permission reply. The chat asks for a
 * remembered approval with `rememberEntry`; for OpenCode that is its own
 * `always`, whose patterns come from the request, not from the client. A
 * denial is a plain `reject`, which ends the turn like OpenCode's own Reject.
 *
 * Exported for tests only.
 */
export function toOpenCodePermissionReply(decision: ProviderPermissionDecision): OpenCodePermissionReply {
  if (!decision.allow) {
    return 'reject';
  }

  return decision.rememberEntry ? 'always' : 'once';
}

function resolveOpenCodeEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition | null,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Splits a `provider/model` id the way `opencode run --model` does: at the first
 * slash, so model ids that contain slashes themselves stay whole. The effort
 * the chat picked rides along as OpenCode's model variant.
 */
function parseOpenCodeModel(
  model: string | undefined,
  variant: string | undefined,
): { providerID: string; id: string; variant?: string } | undefined {
  if (!model) {
    return undefined;
  }

  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    return undefined;
  }

  return {
    providerID: model.slice(0, separator),
    id: model.slice(separator + 1),
    ...(variant ? { variant } : {}),
  };
}


// ---------------------------------------------------------------------------
// Permission rules and "Always allow" memory
// ---------------------------------------------------------------------------

/**
 * OpenCode's own wildcard matcher (`Wildcard.match` in its core package): `*`
 * matches anything, `?` one character, and a trailing ` *` also matches the
 * bare command, so `git status *` covers `git status`.
 */
function matchesOpenCodeWildcard(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll('\\', '/');
  let expression = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  if (expression.endsWith(' .*')) {
    expression = `${expression.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'si' : 's').test(normalizedInput);
}

/**
 * Whether an earlier "Always allow" in this chat already covers a request:
 * every one of its patterns has to match an approved rule, the same test
 * OpenCode applies to its own approvals.
 *
 * Exported for tests only.
 */
export function isCoveredByApprovals(
  approvals: RememberedApproval[] | undefined,
  permission: string,
  patterns: string[],
): boolean {
  if (!approvals?.length || patterns.length === 0) {
    return false;
  }

  return patterns.every((pattern) => approvals.some((rule) =>
    matchesOpenCodeWildcard(permission, rule.permission) && matchesOpenCodeWildcard(pattern, rule.pattern)));
}

function rememberApprovals(chatKey: string, permission: string, patterns: string[]): void {
  if (patterns.length === 0) {
    return;
  }

  const approvals = rememberedApprovals.get(chatKey) ?? [];
  for (const pattern of patterns) {
    if (!approvals.some((rule) => rule.permission === permission && rule.pattern === pattern)) {
      approvals.push({ permission, pattern });
    }
  }

  // Re-inserting moves the chat to the newest end of the map's order.
  rememberedApprovals.delete(chatKey);
  rememberedApprovals.set(chatKey, approvals);
  while (rememberedApprovals.size > MAX_REMEMBERED_APPROVAL_SESSIONS) {
    const oldestKey = rememberedApprovals.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    rememberedApprovals.delete(oldestKey);
  }
}

// ---------------------------------------------------------------------------
// Questions (forms)
// ---------------------------------------------------------------------------

/** The fields of a form the chat can show as questions: everything but external links. */
function readQuestionFields(form: FormInfo) {
  return form.fields.filter((field) => field.type !== 'external' && !('hidden' in field && field.hidden));
}

/**
 * Shapes an OpenCode form as the input of the chat's AskUserQuestion panel.
 * OpenCode's `question` tool turns each question into one field: the header
 * becomes the field title and the question its description. A `multiselect`
 * field is Claude's `multiSelect`; `custom: false` hides the typed answer.
 */
function toAskUserQuestionInput(form: FormInfo): AnyRecord {
  return {
    questions: readQuestionFields(form).map((field) => {
      const options = 'options' in field && Array.isArray(field.options) ? field.options : [];
      return {
        question: field.description || field.title || form.title,
        header: field.title ?? '',
        options: options.map((option) => ({ label: option.label ?? String(option.value), description: option.description ?? '' })),
        multiSelect: field.type === 'multiselect',
        ...('custom' in field && field.custom === false ? { custom: false } : {}),
      };
    }),
  };
}

/**
 * Reads the answers the chat sent for a question request: one list of labels
 * per question, in question order. Answers keyed by question text (the shape
 * Claude's panel uses) are accepted as one label each.
 *
 * Exported for tests only.
 */
export function readQuestionAnswers(
  updatedInput: unknown,
  questions: Array<{ question: string }>,
): string[][] {
  const answers = readObjectRecord(updatedInput)?.answers;
  const toLabels = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((label): label is string => typeof label === 'string' && label.trim().length > 0);
    }
    return typeof value === 'string' && value.trim() ? [value] : [];
  };

  if (Array.isArray(answers)) {
    return questions.map((_, index) => toLabels(answers[index]));
  }

  const keyedAnswers = readObjectRecord(answers);
  return questions.map((question) => toLabels(keyedAnswers?.[question.question]));
}

/**
 * Builds a form answer from the labels the chat picked, one list per shown
 * field. A picked label goes back as its option's value (a typed answer as
 * itself); a multiselect field takes the whole list, any other field the first
 * label, and a boolean field `true` for a yes-like label.
 *
 * Exported for tests only.
 */
export function toFormAnswer(
  form: FormInfo,
  labelLists: string[][],
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  readQuestionFields(form).forEach((field, index) => {
    const options = 'options' in field && Array.isArray(field.options) ? field.options : [];
    const values = (labelLists[index] ?? []).map((label) => {
      const option = options.find((candidate) => candidate.label === label || String(candidate.value) === label);
      return option ? String(option.value) : label;
    });
    if (values.length === 0) {
      return;
    }

    if (field.type === 'multiselect') {
      answer[field.key] = values;
    } else if (field.type === 'boolean') {
      answer[field.key] = /^(true|yes|y|1|ok)$/i.test(values[0].trim());
    } else if (field.type === 'number' || field.type === 'integer') {
      const parsed = Number(values[0]);
      answer[field.key] = Number.isFinite(parsed) ? parsed : values[0];
    } else {
      answer[field.key] = values[0];
    }
  });
  return answer;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/**
 * Turns OpenCode's running session totals (`session.usage.updated`) into the
 * chat's token budget. Cache reads count as input, the way the history reader
 * reports them.
 */
function toTokenBudget(tokens: TokenUsageInfo | null) {
  if (!tokens) {
    return null;
  }

  const inputTokens = (tokens.input || 0) + (tokens.cache?.read || 0);
  const outputTokens = tokens.output || 0;
  const used = (tokens.input || 0)
    + outputTokens
    + (tokens.reasoning || 0)
    + (tokens.cache?.read || 0)
    + (tokens.cache?.write || 0);
  if (used <= 0) {
    return null;
  }

  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

// ---------------------------------------------------------------------------
// Server lifetime
// ---------------------------------------------------------------------------

let exitHookInstalled = false;

/**
 * Stops the servers of turns still running when Bowcode exits. The shutdown
 * handlers end with `process.exit`, which runs this synchronously.
 */
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }

  exitHookInstalled = true;
  process.on('exit', () => {
    for (const turn of activeTurns.values()) {
      turn.abortController.abort();
      turn.server?.close();
    }
  });
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Stops turn servers that a Bowcode process started and never stopped because
 * it was killed (SIGKILL, the OOM killer) before its exit hook could run. Such a
 * server never exits by itself.
 *
 * A process is only stopped when its environment names a Bowcode owner that
 * is gone and its arguments are a turn server's (`serve --hostname=127.0.0.1
 * --port=…`), so commands the agent left running in the background are never
 * touched. The owner pid only means something inside the PID namespace that
 * issued it: a Bowcode on the host also sees a container's processes in
 * /proc, and their owner pid would look dead from out here, so processes of
 * another (or an unreadable) namespace are skipped. Linux only: the
 * environment is read from /proc, which tests point at a fake tree.
 *
 * Used by the server entrypoint once at startup, through the providers module.
 */
export async function reapOrphanedOpenCodeServers(procRoot = '/proc'): Promise<number> {
  if (process.platform !== 'linux') {
    return 0;
  }

  const ownNamespace = await readlink(path.join(procRoot, 'self', 'ns', 'pid')).catch(() => null);
  if (!ownNamespace) {
    return 0;
  }

  let reaped = 0;
  const entries = await readdir(procRoot).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }

    const pid = Number(entry);
    // Other users' processes are unreadable and skipped.
    const [environ, cmdline, namespace] = await Promise.all([
      readFile(path.join(procRoot, entry, 'environ'), 'utf8').catch(() => ''),
      readFile(path.join(procRoot, entry, 'cmdline'), 'utf8').catch(() => ''),
      readlink(path.join(procRoot, entry, 'ns', 'pid')).catch(() => null),
    ]);
    const owner = environ.split('\0').find((variable) => variable.startsWith(`${OWNER_PID_ENV}=`));
    const ownerPid = Number(owner?.slice(OWNER_PID_ENV.length + 1));
    const args = cmdline.split('\0');
    const isTurnServer = args.includes('serve')
      && args.includes('--hostname=127.0.0.1')
      && args.some((arg) => arg.startsWith('--port='));
    if (
      !isTurnServer
      || namespace !== ownNamespace
      || !Number.isInteger(ownerPid)
      || ownerPid <= 0
      || isProcessAlive(ownerPid)
    ) {
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
      reaped += 1;
    } catch {
      // Gone already.
    }
  }

  return reaped;
}

/**
 * Reserves a free loopback port for a turn's server.
 *
 * Every turn's server gets a port of its own: consecutive turns on the same
 * address would let Node's fetch reuse a kept-alive connection to the previous
 * turn's server, which has just been stopped, and the new turn's first
 * request would fail.
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('No free port for the OpenCode server.'))));
    });
  });
}

/** Stops a turn server: SIGTERM first, SIGKILL if it has not exited after a grace period. */
function stopServerProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }, SERVER_STOP_GRACE_MS);
  forceKill.unref();
  child.once('exit', () => clearTimeout(forceKill));
}

/**
 * Starts a private `opencode serve` for one turn.
 *
 * The server listens on loopback only, and a random Basic-auth password
 * (`OPENCODE_SERVER_PASSWORD`) keeps other local processes and web pages from
 * driving it. Resolves once the server prints the address it listens on.
 */
async function startOpenCodeServer(signal: AbortSignal): Promise<{ server: OpenCodeServer; password: string }> {
  const port = await reserveFreePort();
  const password = crypto.randomBytes(24).toString('base64url');
  const child = spawn('opencode', ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: 'opencode',
      [OWNER_PID_ENV]: String(process.pid),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error: Error | null, address?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      if (error) {
        stopServerProcess(child);
        reject(error);
      } else {
        resolve(address!);
      }
    };
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-8_192);
      const match = SERVER_LISTENING_PATTERN.exec(output);
      if (match) {
        finish(null, match[1].replace(/\/+$/, ''));
      }
    };
    const onAbort = () => finish(new Error('aborted'));
    const timer = setTimeout(
      () => finish(new Error(`The OpenCode server did not start within ${SERVER_START_TIMEOUT_MS / 1000} s.`)),
      SERVER_START_TIMEOUT_MS,
    );

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => finish(error));
    child.once('exit', (code, exitSignal) => {
      const lastLines = output.trim().split(/\r?\n/).slice(-5).join('\n');
      finish(new Error(
        `The OpenCode server exited before it started (${exitSignal ?? `code ${code}`})${lastLines ? `: ${lastLines}` : '.'}`,
      ));
    });
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  // Keep draining the pipes so a chatty server never blocks on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();

  return { server: { url, close: () => stopServerProcess(child) }, password };
}

/**
 * Whether a failed start is worth one more try: two servers migrating the
 * shared database at once can make one of them fail with `database is locked`,
 * and another process can take the reserved port before the server binds it.
 */
function isRetryableStartFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|EADDRINUSE|address already in use/i.test(message);
}

function readErrorMessage(error: unknown): string {
  const record = readObjectRecord(error);
  if (typeof record?.message === 'string' && record.message) {
    return record.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof record?._tag === 'string' && record._tag) {
    return record._tag;
  }
  return String(error);
}

/** Whether a client call failed because OpenCode no longer knows the request (already settled). */
function isNotFoundError(error: unknown): boolean {
  const record = readObjectRecord(error);
  const cause = readObjectRecord(error instanceof Error ? error.cause : undefined);
  return cause?.status === 404 || (typeof record?._tag === 'string' && /NotFound/i.test(record._tag));
}

/** Refuses an OpenCode older than 2, whose API this runtime does not speak. */
async function assertSupportedOpenCode(client: OpenCodeClient): Promise<void> {
  const upgradeHint = 'Update it, for example with `opencode upgrade`.';
  let version: string | undefined;
  try {
    version = (await client.server.info()).version;
  } catch (error) {
    throw new Error(
      `Bowcode needs OpenCode ${MIN_OPENCODE_MAJOR_VERSION} or newer, and this OpenCode did not report its version `
      + `(${readErrorMessage(error)}). ${upgradeHint}`,
    );
  }

  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  // Snapshot and development builds (`0.0.0-…`) and unparsable versions are let through.
  if (Number.isInteger(major) && major > 0 && major < MIN_OPENCODE_MAJOR_VERSION) {
    throw new Error(`OpenCode ${version} is too old for Bowcode, which needs ${MIN_OPENCODE_MAJOR_VERSION} or newer. ${upgradeHint}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Lets microtasks queued by the caller (the abort handler's terminal `complete`) run first. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

/** What the runtime remembers of a tool call until it finishes. */
type PendingToolCall = { name: string; input: AnyRecord };

/**
 * Runs one OpenCode turn. Resolves when the turn completed, rejects when it
 * failed; an aborted turn resolves once its stop has finished, so the abort
 * handler's terminal `complete` is the one the chat receives.
 */
async function runOpenCodeTurn(
  command: string,
  options: AnyRecord = {},
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    files,
    permissionMode,
  } = options;
  const appSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  // Callers pass the stable app session id; OpenCode resumes with the
  // provider-native id recorded on the session row.
  const resumeSessionId = context.resolveProviderSessionId(appSessionId);
  const workingDir: string = cwd || projectPath || process.cwd();
  const userId = writer?.userId ?? null;

  let turnDone!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    turnDone = resolve;
  });
  const turn: OpenCodeTurn = {
    key: appSessionId ?? resumeSessionId ?? `opencode-${Date.now()}`,
    abortController: new AbortController(),
    server: null,
    client: null,
    providerSessionId: resumeSessionId,
    aborted: false,
    abortFinished: null,
    finish: () => turnDone(),
  };
  activeTurns.set(turn.key, turn);
  installExitHook();

  const turnSessionId = () => appSessionId ?? turn.providerSessionId ?? turn.key;
  // "Always allow" is remembered per chat; direct callers without an app id
  // fall back to the OpenCode session.
  const approvalsKey = () => appSessionId ?? turn.providerSessionId ?? turn.key;
  const send = (message: unknown) => writer.send(message);
  const sentErrors = new Set<string>();
  const sendError = (content: string) => {
    // OpenCode can report one failure more than once; the chat shows it once.
    if (sentErrors.has(content)) {
      return;
    }
    sentErrors.add(content);
    send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: turnSessionId(),
      provider: PROVIDER,
    }));
  };
  const notify = (event: AnyRecord) => notifyUserIfEnabled({ userId, event: notificationEvent(event) });

  const turnPromptIds = new Set<string>();
  const toolCalls = new Map<string, PendingToolCall>();
  let latestTokens: TokenUsageInfo | null = null;
  let promptSent = false;
  let turnEnded = false;
  let turnError: string | null = null;

  const failTurn = (message: string) => {
    sendError(message);
    turnError ??= message;
    turnDone();
  };

  const registerProviderSession = (providerSessionId: string) => {
    turn.providerSessionId = providerSessionId;
    // Direct callers without an app session id find the turn by the
    // provider-native id from now on.
    if (!appSessionId && turn.key !== providerSessionId) {
      if (activeTurns.get(turn.key) === turn) {
        activeTurns.delete(turn.key);
      }
      turn.key = providerSessionId;
      activeTurns.set(turn.key, turn);
    }

    writer.setSessionId?.(providerSessionId);
    send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: providerSessionId,
      sessionId: providerSessionId,
      provider: PROVIDER,
    }));
  };

  const replyToPermission = async (request: OpenCodePermissionRequest, reply: OpenCodePermissionReply) => {
    try {
      await turn.client!.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: reply });
    } catch (error) {
      // Already settled by OpenCode itself (its cascade after another reply).
      if (isNotFoundError(error) || turn.aborted || turnEnded) {
        return;
      }
      failTurn(`OpenCode did not accept the permission reply: ${readErrorMessage(error)}`);
    }
  };

  const replyToForm = async (form: FormInfo, labelLists: string[][] | null, cancelMessage?: string) => {
    try {
      if (labelLists) {
        await turn.client!.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer: toFormAnswer(form, labelLists) });
      } else {
        await turn.client!.session.form.cancel({ sessionID: form.sessionID, formID: form.id, message: cancelMessage });
      }
    } catch (error) {
      if (isNotFoundError(error) || turn.aborted || turnEnded) {
        return;
      }
      failTurn(`OpenCode did not accept the answer: ${readErrorMessage(error)}`);
    }
  };

  /** Shows a request in the chat and holds it until it is answered or times out. */
  const askChat = (prompt: {
    requestId: string;
    toolName: string;
    input: unknown;
    context: AnyRecord;
    timeoutMs: number;
    onAnswer(decision: ProviderPermissionDecision): void;
    onTimeout(): void;
  }) => {
    const pending: PendingOpenCodePrompt = {
      requestId: prompt.requestId,
      // Keyed by the app session id so `chat.subscribe` can find it after a refresh.
      sessionId: appSessionId ?? turn.providerSessionId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      receivedAt: new Date(),
      timer: undefined,
      answer: (decision) => {
        if (pendingPrompts.get(prompt.requestId) !== pending) {
          return;
        }
        // Announced on the run stream so the replay buffer and every other
        // tab watching the run drop the prompt as well.
        pending.settle();
        prompt.onAnswer(decision);
      },
      settle: (reason) => {
        if (pendingPrompts.get(prompt.requestId) !== pending) {
          return;
        }
        clearTimeout(pending.timer);
        pendingPrompts.delete(prompt.requestId);
        turnPromptIds.delete(prompt.requestId);
        send(createNormalizedMessage({
          kind: reason ? 'permission_cancelled' : 'permission_resolved',
          requestId: prompt.requestId,
          ...(reason ? { reason } : {}),
          sessionId: turnSessionId(),
          provider: PROVIDER,
        }));
      },
    };

    pendingPrompts.set(prompt.requestId, pending);
    turnPromptIds.add(prompt.requestId);
    if (prompt.timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        pending.settle('timeout');
        prompt.onTimeout();
      }, prompt.timeoutMs);
    }

    send(createNormalizedMessage({
      kind: 'permission_request',
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId: turnSessionId(),
      provider: PROVIDER,
    }));
  };

  const handlePermissionAsked = (request: OpenCodePermissionRequest) => {
    // A stopping or finished turn asks nobody; its server is about to go.
    // The server is private to the turn, so its subagents' requests are the
    // turn's too and are asked in the same chat.
    if (turn.aborted || turnEnded) {
      return;
    }
    const resources = request.resources ?? [];
    const save = request.save ?? [];
    const automaticReply = resolveAutomaticPermissionReply(permissionMode, request.action)
      ?? (isCoveredByApprovals(rememberedApprovals.get(approvalsKey()), request.action, resources) ? 'once' : null);
    if (automaticReply) {
      void replyToPermission(request, automaticReply);
      return;
    }

    askChat({
      requestId: request.id,
      toolName: request.action,
      input: { ...request.metadata, patterns: resources, ...(request.message ? { message: request.message } : {}) },
      // `always` is what "Always allow" approves; the chat shows it beside the button.
      context: { patterns: resources, always: save },
      timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
      onAnswer: (decision) => {
        const reply = toOpenCodePermissionReply(decision);
        if (reply === 'always') {
          rememberApprovals(approvalsKey(), request.action, save.length > 0 ? save : resources);
        }
        void replyToPermission(request, reply);
      },
      onTimeout: () => void replyToPermission(request, 'reject'),
    });

    notify({
      provider: PROVIDER,
      sessionId: turnSessionId(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName: request.action, sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:permission:${turnSessionId()}:${request.id}`,
    });
  };

  const handleFormCreated = (form: FormInfo) => {
    if (turn.aborted || turnEnded) {
      return;
    }
    const questions = readQuestionFields(form);
    // Nobody is asked in bypassPermissions (also how /api/agent runs): the
    // agent is told the questions went unanswered and carries on.
    if (permissionMode === 'bypassPermissions' || questions.length === 0) {
      void replyToForm(form, null, UNANSWERED_QUESTION_MESSAGE);
      return;
    }

    const input = toAskUserQuestionInput(form);
    askChat({
      requestId: form.id,
      toolName: 'AskUserQuestion',
      input,
      // Tells the panel to answer with one label list per question and to
      // offer Dismiss, which cancels the form in OpenCode.
      context: { answerFormat: 'label-lists' },
      timeoutMs: QUESTION_TIMEOUT_MS,
      onAnswer: (decision) => {
        void replyToForm(
          form,
          decision.allow ? readQuestionAnswers(decision.updatedInput, input.questions as Array<{ question: string }>) : null,
          decision.allow ? undefined : 'The user dismissed the question.',
        );
      },
      onTimeout: () => void replyToForm(form, null, 'The user did not answer in time.'),
    });

    notify({
      provider: PROVIDER,
      sessionId: turnSessionId(),
      kind: 'action_required',
      code: 'agent.notification',
      meta: { message: (input.questions as AnyRecord[])[0]?.question || 'OpenCode has a question for you', sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:question:${turnSessionId()}:${form.id}`,
    });
  };

  /**
   * Hands one finished piece of the chat's own session to the shared
   * normalizer in the shape the history reader sees it in (an assistant
   * message content item), so a live turn and a reload render the same rows.
   * Subagent sessions are left out: their work shows inside the subagent call.
   */
  const forward = (raw: AnyRecord) => {
    for (const message of context.normalizeMessage(
      { timestamp: Date.now(), sessionID: turn.providerSessionId, ...raw },
      turnSessionId(),
    )) {
      send(message);
    }
  };

  const forwardToolResult = (
    assistantMessageID: string,
    toolId: string,
    state: { status: 'completed' | 'error'; content?: unknown; error?: unknown; metadata?: unknown },
  ) => {
    const call = toolCalls.get(toolId);
    toolCalls.delete(toolId);
    forward({
      type: 'opencode.v2.content',
      messageID: assistantMessageID,
      item: {
        type: 'tool',
        id: toolId,
        name: call?.name ?? 'tool',
        state: { input: call?.input ?? {}, ...state },
      },
    });
  };

  const handleEvent = (event: OpenCodeEvent) => {
    const data = readObjectRecord((event as { data?: unknown }).data) ?? {};

    switch (event.type) {
      case 'permission.asked': {
        handlePermissionAsked(data as unknown as OpenCodePermissionRequest);
        return;
      }
      case 'form.created': {
        const form = readObjectRecord(data.form);
        if (form) {
          handleFormCreated(form as unknown as FormInfo);
        }
        return;
      }
      case 'permission.replied': {
        // Settled without the chat: OpenCode answers the rest of a session's
        // prompts itself after an Always allow or a Deny.
        pendingPrompts.get(String(data.requestID))?.settle();
        return;
      }
      case 'form.replied':
      case 'form.cancelled': {
        pendingPrompts.get(String(data.id))?.settle();
        return;
      }
      default:
        break;
    }

    // Everything below concerns the chat's own session only.
    if (!turn.providerSessionId || data.sessionID !== turn.providerSessionId) {
      return;
    }

    switch (event.type) {
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        forward({
          type: 'opencode.v2.content',
          messageID: data.assistantMessageID,
          ordinal: data.ordinal,
          item: { type: event.type === 'session.text.ended' ? 'text' : 'reasoning', text: data.text },
        });
        return;
      }
      case 'session.tool.input.started': {
        toolCalls.set(String(data.id), { name: String(data.name ?? 'tool'), input: {} });
        return;
      }
      case 'session.tool.called': {
        const call = toolCalls.get(String(data.id));
        toolCalls.set(String(data.id), { name: call?.name ?? 'tool', input: readObjectRecord(data.input) ?? {} });
        return;
      }
      case 'session.tool.success': {
        forwardToolResult(String(data.assistantMessageID), String(data.id), {
          status: 'completed',
          content: data.content,
          metadata: data.metadata,
        });
        return;
      }
      case 'session.tool.failed': {
        forwardToolResult(String(data.assistantMessageID), String(data.id), {
          status: 'error',
          content: data.content,
          error: data.error,
          metadata: data.metadata,
        });
        return;
      }
      case 'session.step.ended': {
        forward({ type: 'opencode.v2.step_end', messageID: data.assistantMessageID });
        return;
      }
      case 'session.usage.updated': {
        latestTokens = (readObjectRecord(data.tokens) as TokenUsageInfo | null) ?? latestTokens;
        return;
      }
      case 'session.execution.succeeded':
      case 'session.execution.interrupted': {
        if (promptSent) {
          turnDone();
        }
        return;
      }
      case 'session.execution.failed': {
        if (!promptSent || turnEnded) {
          return;
        }
        if (!turn.aborted) {
          const message = readErrorMessage(data.error) || 'OpenCode run failed';
          sendError(message);
          turnError ??= message;
        }
        turnDone();
        return;
      }
      default:
        return;
    }
  };

  let connected!: () => void;
  const eventStreamConnected = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let eventLoop: Promise<void> = Promise.resolve();
  let completedNormally = false;

  try {
    const hasAttachments =
      normalizeAttachmentDescriptors(images).length > 0
      || normalizeAttachmentDescriptors(files).length > 0;
    const promptText = typeof command === 'string' ? command.trim() : '';
    if (!promptText && !hasAttachments) {
      throw new Error('OpenCode needs a message to run.');
    }
    // Attachments ride along as path lists appended to the prompt; the agent
    // reads them with its own tools and the history reader strips the tags.
    const promptWithAttachments = appendFilesInputTag(appendImagesInputTag(promptText, images), files);

    const resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, model);
    let effortModels: ProviderModelsDefinition | null = null;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
    }
    const modelRef = parseOpenCodeModel(resolvedModel, resolveOpenCodeEffort(resolvedModel, effort, effortModels));

    if (turn.aborted) {
      throw new Error('aborted');
    }
    let started: Awaited<ReturnType<typeof startOpenCodeServer>>;
    try {
      started = await startOpenCodeServer(turn.abortController.signal);
    } catch (error) {
      if (turn.aborted || !isRetryableStartFailure(error)) {
        throw error;
      }
      started = await startOpenCodeServer(turn.abortController.signal);
    }
    turn.server = started.server;
    if (turn.aborted) {
      throw new Error('aborted');
    }

    const client = OpenCode.make({
      baseUrl: started.server.url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${started.password}`).toString('base64')}` },
    });
    turn.client = client;
    await assertSupportedOpenCode(client);

    // Subscribe before anything is sent, so no event of the turn is missed.
    // A private server that drops the stream has stopped.
    let streamError: unknown = null;
    const stream = client.event.subscribe({ signal: turn.abortController.signal });
    eventLoop = (async () => {
      try {
        for await (const event of stream) {
          if (event.type === 'server.connected') {
            connected();
            continue;
          }
          try {
            handleEvent(event);
          } catch (error) {
            // One event that cannot be handled must not end the turn.
            console.error('[OpenCode] Failed to handle an event:', event.type, readErrorMessage(error));
          }
        }
      } catch (error) {
        streamError ??= error;
      }
      if (!turn.aborted && !turnEnded) {
        failTurn(streamError
          ? `Lost the connection to the OpenCode server: ${readErrorMessage(streamError)}`
          : 'The OpenCode server stopped unexpectedly.');
      }
    })();

    await Promise.race([
      withTimeout(eventStreamConnected, EVENT_STREAM_CONNECT_TIMEOUT_MS, 'The OpenCode event stream did not connect.'),
      turnFinished.then(() => {
        throw new Error(turnError ?? 'The OpenCode event stream ended before it connected.');
      }),
    ]);

    // Plan mode runs OpenCode's read-only plan agent; leaving it switches a
    // session back to the default agent.
    const wantsPlanAgent = permissionMode === 'plan';
    if (turn.providerSessionId) {
      const existing = await client.session.get({ sessionID: turn.providerSessionId });
      if (wantsPlanAgent && existing.agent !== 'plan') {
        await client.session.switchAgent({ sessionID: turn.providerSessionId, agent: 'plan' });
      } else if (!wantsPlanAgent && existing.agent === 'plan') {
        // Config sources come in load order, so the last one naming a default agent wins.
        const configEntries = await client.config.get().catch(() => []);
        const defaultAgent = configEntries.map((entry) => ('info' in entry ? entry.info?.default_agent : undefined)).filter(Boolean).at(-1);
        await client.session.switchAgent({
          sessionID: turn.providerSessionId,
          agent: defaultAgent && defaultAgent !== 'plan' ? defaultAgent : 'build',
        });
      }
      const current = existing.model;
      if (modelRef && (
        current?.providerID !== modelRef.providerID
        || current?.id !== modelRef.id
        || (modelRef.variant !== undefined && current?.variant !== modelRef.variant)
      )) {
        await client.session.switchModel({ sessionID: turn.providerSessionId, model: modelRef });
      }
    } else {
      const created = await client.session.create({
        location: { directory: workingDir },
        ...(modelRef ? { model: modelRef } : {}),
        ...(wantsPlanAgent ? { agent: 'plan' } : {}),
      });
      if (!created?.id) {
        throw new Error('OpenCode did not create a session.');
      }
      registerProviderSession(created.id);
    }

    if (turn.aborted) {
      throw new Error('aborted');
    }
    promptSent = true;
    await client.session.prompt({
      sessionID: turn.providerSessionId!,
      text: promptWithAttachments,
    });

    await turnFinished;
    completedNormally = !turnError;
  } catch (error) {
    if (!turn.aborted) {
      let message = readErrorMessage(error);
      if (!turn.server && !(await context.isProviderInstalled())) {
        message = NOT_INSTALLED_MESSAGE;
      }
      sendError(message);
      turnError ??= message;
    }
  } finally {
    turnEnded = true;
    // Whatever is still open was asked of a turn that has ended.
    for (const requestId of Array.from(turnPromptIds)) {
      pendingPrompts.get(requestId)?.settle('cancelled');
    }

    if (turn.aborted) {
      await turn.abortFinished;
    }
    connected();
    turn.abortController.abort();
    turn.server?.close();
    await eventLoop;
    for (const requestId of Array.from(turnPromptIds)) {
      pendingPrompts.get(requestId)?.settle('cancelled');
    }
    if (activeTurns.get(turn.key) === turn) {
      activeTurns.delete(turn.key);
    }
  }

  const finalSessionId = turnSessionId();
  if (turn.aborted) {
    // The abort handler sends the terminal `complete` (aborted: true) on this
    // turn's behalf. Settling only after the stop has finished — including a
    // stop that landed while the stream was draining — keeps the chat's
    // safety-net `complete` from arriving first.
    await turn.abortFinished;
    await nextMacrotask();
    return;
  }

  const tokenBudget = toTokenBudget(latestTokens);
  if (tokenBudget) {
    send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: finalSessionId,
      provider: PROVIDER,
    }));
  }

  send(createCompleteMessage({ provider: PROVIDER, sessionId: finalSessionId, exitCode: completedNormally ? 0 : 1 }));

  if (completedNormally) {
    reportRunStopped({
      userId,
      provider: PROVIDER,
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      stopReason: 'completed',
    });
    return;
  }

  reportRunFailed({
    userId,
    provider: PROVIDER,
    sessionId: finalSessionId,
    sessionName: sessionSummary,
    error: turnError ?? 'OpenCode run failed',
  });
  throw new Error(turnError ?? 'OpenCode run failed');
}

/**
 * Stops the turn running for a session: withdraws its open prompts, interrupts
 * the OpenCode session so a running tool command ends too, then stops the
 * server. The caller sends the terminal `complete` (aborted: true) once this
 * returns.
 */
async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const turn = activeTurns.get(sessionId);
  if (!turn) {
    return false;
  }

  // A second stop (Stop pressed twice, Esc twice) waits for the first one, so
  // the run is reported stopped only once the turn really has been.
  if (turn.aborted) {
    await turn.abortFinished;
    return true;
  }

  // Flagged synchronously so the turn emits no `complete` of its own.
  turn.aborted = true;
  turn.abortFinished = (async () => {
    for (const prompt of Array.from(pendingPrompts.values())) {
      if (prompt.sessionId === sessionId || prompt.sessionId === turn.providerSessionId) {
        prompt.settle('cancelled');
      }
    }

    if (turn.client && turn.providerSessionId) {
      try {
        await withTimeout(
          turn.client.session.interrupt({ sessionID: turn.providerSessionId }),
          SESSION_ABORT_TIMEOUT_MS,
          'OpenCode did not confirm the interrupt in time.',
        );
      } catch (error) {
        console.warn('[OpenCode] Session interrupt failed, stopping the server:', readErrorMessage(error));
      }
    }

    turn.abortController.abort();
    turn.server?.close();
  })();
  turn.finish();

  await turn.abortFinished;
  return true;
}

/**
 * Applies the chat's answer to a pending OpenCode permission or question.
 * Called for every provider's requests, so unknown ids are ignored.
 */
function resolveOpenCodePrompt(requestId: string, decision: ProviderPermissionDecision): void {
  pendingPrompts.get(requestId)?.answer(decision);
}

/**
 * Pending prompts of a session, replayed to a client that subscribes after a
 * refresh. Same shape as the Claude runtime's pending approvals.
 */
function getPendingOpenCodePrompts(sessionId: string) {
  return Array.from(pendingPrompts.values())
    .filter((prompt) => prompt.sessionId === sessionId)
    .map((prompt) => ({
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId,
      receivedAt: prompt.receivedAt,
    }));
}

/**
 * Whether a turn is running for a session. Used by the OpenCode sessions
 * provider, which treats subagents of a running turn as still in progress.
 */
export function isOpenCodeSessionActive(sessionId: string): boolean {
  return activeTurns.has(sessionId);
}

/**
 * The OpenCode runtime facet. Used by the OpenCode provider wrapper, through
 * which providerRuntimeService runs chat turns, scheduled messages and
 * /api/agent runs, and routes the chat's permission answers.
 */
export const opencodeRuntime = {
  run: runOpenCodeTurn,
  abort: abortOpenCodeSession,
  permissions: {
    resolve: resolveOpenCodePrompt,
    listPending: getPendingOpenCodePrompts,
  },
};
