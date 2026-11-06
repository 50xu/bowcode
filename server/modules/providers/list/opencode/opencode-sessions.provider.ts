import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { isOpenCodeSessionActive } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  readJsonRecord,
  readObjectRecord,
  readOpenCodeContextTokenUsage,
  readOptionalString,
  sliceTailPage,
  truncateSubagentActivity,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

/** OpenCode v2's tool for spawning a subagent; it runs in a child session of the caller. */
const SUBAGENT_TOOL_NAME = 'subagent';

/** OpenCode's ask-the-user tool. */
const QUESTION_TOOL_NAME = 'question';

/** Upper bound on how much of a subagent's timeline is sent to the client, as for Claude and Codex. */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

/** One `session_message` row of OpenCode v2's database. */
type OpenCodeMessageRow = {
  id: string;
  type: string;
  time_created: number | null;
  data: string | null;
};

/** The child-session columns a subagent container reads. */
type OpenCodeChildSessionRow = {
  model: string | null;
  idle_outcome: string | null;
  time_busy: number | null;
  time_idle: number | null;
};

/**
 * How a background subagent finished, as the `synthetic` message OpenCode
 * delivers to the parent session reports it (`metadata.state` + the wrapped answer).
 */
type OpenCodeSubagentCompletion = {
  state: string | undefined;
  text: string;
};

/** Context a tool row needs beyond its own content item. */
type OpenCodeToolContext = {
  db: Database.Database | null;
  runIsLive: boolean;
  /** Background subagent completions by child session id (history only). */
  subagentCompletions?: Map<string, OpenCodeSubagentCompletion>;
};

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

/** Opens the shared database for a live event, or null when it cannot be read right now. */
const openOpenCodeDatabaseForLiveEvent = (): Database.Database | null => {
  try {
    return openOpenCodeDatabase();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[OpenCodeProvider] Failed to open opencode.db for a live event:', reason);
    return null;
  }
};

const formatUnknown = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/** Reads a v2 error object (`{ type, message }`) as display text. */
const readErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'string') {
    return error.trim() ? error : undefined;
  }

  const record = readObjectRecord(error);
  if (!record) {
    return undefined;
  }

  return readOptionalString(record.message)
    ?? readOptionalString(readObjectRecord(record.data)?.message)
    ?? (readOptionalString(record.type) ?? readOptionalString(record.name))
    ?? (formatUnknown(record) || undefined);
};

/**
 * Whether an error only records that a turn or tool was stopped. Stopping a
 * turn interrupts the OpenCode session, which stores an `aborted` error on the
 * step it interrupted; the live chat never shows it as a failure, so the
 * history does not either.
 */
const isInterruptionError = (error: unknown): boolean =>
  readOptionalString(readObjectRecord(error)?.type) === 'aborted';

/** Joins the text blocks of a v2 tool result. */
const readToolContentText = (state: AnyRecord): string => {
  if (!Array.isArray(state.content)) {
    return '';
  }

  return state.content
    .map((block) => readOptionalString(readObjectRecord(block)?.text) ?? '')
    .filter((text) => text.length > 0)
    .join('\n');
};

/** A finished tool's result, or undefined while it has not finished. */
const readToolResult = (state: AnyRecord): { content: string; isError: boolean } | undefined => {
  const status = readOptionalString(state.status);
  if (status === 'completed') {
    return { content: readToolContentText(state), isError: false };
  }

  if (status === 'error') {
    return { content: readErrorMessage(state.error) ?? readToolContentText(state), isError: true };
  }

  return undefined;
};

/**
 * Maps an OpenCode v2 tool call onto the tool names and input keys the chat
 * already renders for Claude (`Bash`, `Read`, `Edit`, ...). The original input
 * keys are kept, so nothing OpenCode recorded is lost; the mapped keys are
 * added on top. Unknown tools keep their OpenCode name and input. Shared by the
 * live normalizer, the history reader and the subagent timeline, so all three
 * render one call the same way.
 */
const mapOpenCodeToolCall = (name: string, rawInput: unknown): { toolName: string; toolInput: unknown } => {
  const input = readObjectRecord(rawInput);
  if (!input) {
    return { toolName: name, toolInput: rawInput ?? {} };
  }

  switch (name) {
    case 'shell':
      return {
        toolName: 'Bash',
        toolInput: { ...input, command: input.command, description: input.description },
      };
    case 'read':
      return {
        toolName: 'Read',
        toolInput: { ...input, file_path: input.path ?? input.filePath, offset: input.offset, limit: input.limit },
      };
    case 'edit':
      return {
        toolName: 'Edit',
        toolInput: {
          ...input,
          file_path: input.path ?? input.filePath,
          old_string: input.oldString,
          new_string: input.newString,
          ...(input.replaceAll !== undefined ? { replace_all: input.replaceAll } : {}),
        },
      };
    case 'write':
      return {
        toolName: 'Write',
        toolInput: { ...input, file_path: input.path ?? input.filePath, content: input.content },
      };
    case 'grep':
      return {
        toolName: 'Grep',
        toolInput: { ...input, ...(input.include !== undefined ? { glob: input.include } : {}) },
      };
    case 'glob':
      return { toolName: 'Glob', toolInput: { ...input } };
    case 'webfetch':
      return { toolName: 'WebFetch', toolInput: { ...input, url: input.url } };
    case 'websearch':
      return { toolName: 'WebSearch', toolInput: { ...input, query: input.query } };
    case SUBAGENT_TOOL_NAME:
      return {
        toolName: 'Task',
        toolInput: {
          ...input,
          subagent_type: input.agent,
          description: input.description,
          prompt: input.prompt,
        },
      };
    default:
      return { toolName: name, toolInput: input };
  }
};

/**
 * Rewrites a `question` call onto the AskUserQuestion card the chat already
 * renders for Claude's and Codex's questions: OpenCode's `multiple` becomes
 * `multiSelect`, and the labels the user picked, which OpenCode keeps in
 * `metadata.answers` as one list per question, are folded into the input
 * keyed by question text, the shape the card reads.
 */
const toAskUserQuestionCall = (toolMessage: NormalizedMessage, toolState: AnyRecord): void => {
  toolMessage.toolName = 'AskUserQuestion';
  const input = readObjectRecord(toolState.input);
  if (!input || !Array.isArray(input.questions)) {
    return;
  }

  const answerLists = readObjectRecord(toolState.metadata)?.answers;
  const answers: Record<string, string> = {};
  const questions = input.questions.map((entry: unknown, index: number) => {
    const question = readObjectRecord(entry);
    if (!question) {
      return entry;
    }

    const text = readOptionalString(question.question);
    const picked = Array.isArray(answerLists) && Array.isArray(answerLists[index])
      ? (answerLists[index] as unknown[]).filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
      : [];
    if (text && picked.length > 0) {
      answers[text] = picked.join(', ');
    }

    const { multiple, ...rest } = question;
    return { ...rest, multiSelect: multiple === true };
  });

  toolMessage.toolInput = Object.keys(answers).length > 0
    ? { ...input, questions, answers }
    : { ...input, questions };
};

/**
 * Flattens the child session a `subagent` call spawned into the shared
 * subagent timeline. OpenCode keeps it in the same database as the parent;
 * only the child's assistant content is activity (its user prompt is the
 * call's own input).
 */
const readOpenCodeSubagentActivity = (
  db: Database.Database,
  childSessionId: string,
): SubagentActivity[] => {
  const rows = db.prepare(`
    SELECT time_created, data
    FROM session_message
    WHERE session_id = ?
      AND type = 'assistant'
    ORDER BY seq
  `).all(childSessionId) as { time_created: number | null; data: string | null }[];

  const activity: SubagentActivity[] = [];
  for (const row of rows) {
    const data = readJsonRecord(row.data) ?? {};
    const timestamp = normalizeProviderTimestamp(row.time_created);
    const content = Array.isArray(data.content) ? data.content : [];

    for (const entry of content) {
      const item = readObjectRecord(entry);
      const itemType = readOptionalString(item?.type);
      if (!item || !itemType) {
        continue;
      }

      if (itemType === 'tool') {
        const state = readObjectRecord(item.state) ?? {};
        const { toolName, toolInput } = mapOpenCodeToolCall(readOptionalString(item.name) ?? 'Tool', state.input);
        activity.push({
          kind: 'tool',
          toolId: readOptionalString(item.id),
          toolName,
          toolInput,
          toolResult: readToolResult(state) ?? null,
          timestamp,
        });
        continue;
      }

      if (itemType === 'text' || itemType === 'reasoning') {
        const text = readOptionalString(item.text) ?? '';
        if (text.trim()) {
          activity.push({ kind: itemType === 'text' ? 'text' : 'thinking', content: text, timestamp });
        }
      }
    }
  }

  return activity;
};

// Subagent answers come wrapped as `<subagent sessionID="…" state="…">…</subagent>`.
const SUBAGENT_OUTPUT_PATTERN = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/;

const unwrapSubagentOutput = (content: string): string => {
  const match = SUBAGENT_OUTPUT_PATTERN.exec(content);
  return match ? match[1] : content;
};

const readChildSession = (db: Database.Database, childSessionId: string): OpenCodeChildSessionRow | undefined =>
  db.prepare(`
    SELECT model, idle_outcome, time_busy, time_idle
    FROM session_v2
    WHERE id = ?
  `).get(childSessionId) as OpenCodeChildSessionRow | undefined;

/** Maps a background subagent's reported state (synthetic message or idle outcome) to a status. */
const toSubagentStatus = (state: string | null | undefined): SubagentInfo['status'] | undefined => {
  switch (state) {
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
      return 'stopped';
    default:
      return undefined;
  }
};

/**
 * Turns a `subagent` tool row into a subagent container, the way Claude's
 * `Agent` rows are: identity from the call, timeline from the child session.
 *
 * A foreground subagent's call finishes with its answer. A background one
 * (`metadata.status: 'running'`) returns at once; its outcome arrives later as
 * a `synthetic` message in the parent (history passes those in) or shows on
 * the child session row. `runIsLive` says whether a run of this session is
 * still in progress: an unfinished call outside one was stopped.
 */
const attachOpenCodeSubagent = (
  message: NormalizedMessage,
  state: AnyRecord,
  context: OpenCodeToolContext,
): void => {
  const input = readObjectRecord(state.input) ?? {};
  const metadata = readObjectRecord(state.metadata) ?? {};
  const childSessionId = readOptionalString(metadata.sessionID) ?? readOptionalString(input.sessionID);
  const toolStatus = readOptionalString(state.status);
  const { db, runIsLive } = context;

  let childSession: OpenCodeChildSessionRow | undefined;
  if (db && childSessionId) {
    try {
      childSession = readChildSession(db, childSessionId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to read subagent session ${childSessionId}:`, reason);
    }
  }

  let status: SubagentInfo['status'] = runIsLive ? 'running' : 'stopped';
  if (toolStatus === 'error') {
    status = isInterruptionError(state.error) ? 'stopped' : 'failed';
  } else if (toolStatus === 'completed') {
    const metadataStatus = readOptionalString(metadata.status);
    if (metadataStatus === 'running') {
      const completion = childSessionId ? context.subagentCompletions?.get(childSessionId) : undefined;
      const childBusy = childSession?.time_busy != null
        && (childSession.time_idle == null || childSession.time_busy > childSession.time_idle);
      if (completion) {
        status = toSubagentStatus(completion.state) ?? 'completed';
        message.toolResult = { content: completion.text, isError: status === 'failed' };
      } else if (childBusy) {
        status = 'running';
      } else {
        status = toSubagentStatus(childSession?.idle_outcome) ?? status;
      }
    } else {
      status = toSubagentStatus(metadataStatus) ?? 'completed';
    }
  }

  if (message.toolResult?.content) {
    message.toolResult.content = unwrapSubagentOutput(message.toolResult.content);
  }

  const subagent: SubagentInfo = {
    id: childSessionId ?? message.toolId ?? message.id,
    type: readOptionalString(input.agent),
    description: readOptionalString(input.description),
    status,
  };
  const model = readOptionalString(readJsonRecord(childSession?.model)?.id);
  if (model) {
    subagent.model = model;
  }

  if (db && childSessionId) {
    try {
      const activity = readOpenCodeSubagentActivity(db, childSessionId);
      if (activity.length > 0) {
        // Keep the latest steps: the timeline says the missing ones are the earlier ones.
        message.subagentTools = activity
          .slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity);
        subagent.activityCount = activity.length;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to read subagent session ${childSessionId}:`, reason);
    }
  }

  message.subagent = subagent;
};

/**
 * Normalizes one item of an assistant message's `content` (text, reasoning or
 * tool). Live events and the history reader both go through here, with the
 * same ids: `${messageID}_${ordinal}` for text and reasoning, where the ordinal
 * is the item's index in the content array, and `${messageID}_${toolCallId}`
 * for tools.
 */
const normalizeContentItem = (
  item: AnyRecord,
  messageId: string,
  ordinal: number | undefined,
  sessionId: string,
  timestamp: string,
  context: OpenCodeToolContext,
): NormalizedMessage[] => {
  const itemType = readOptionalString(item.type);
  const ordinalId = ordinal === undefined ? generateMessageId('opencode') : `${messageId}_${ordinal}`;

  if (itemType === 'text' || itemType === 'reasoning') {
    const content = unwrapJsonStringLiteral(readOptionalString(item.text) ?? '');
    if (!content.trim()) {
      return [];
    }

    return [createNormalizedMessage({
      id: ordinalId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: itemType === 'text' ? 'text' : 'thinking',
      ...(itemType === 'text' ? { role: 'assistant' as const } : {}),
      content,
    })];
  }

  if (itemType !== 'tool') {
    return [];
  }

  const state = readObjectRecord(item.state) ?? {};
  const rawName = readOptionalString(item.name) ?? 'Tool';
  const toolCallId = readOptionalString(item.id);
  const { toolName, toolInput } = mapOpenCodeToolCall(rawName, state.input);
  const toolMessage = createNormalizedMessage({
    id: toolCallId ? `${messageId}_${toolCallId}` : ordinalId,
    sessionId,
    timestamp,
    provider: PROVIDER,
    kind: 'tool_use',
    toolName,
    toolInput,
    toolId: toolCallId ?? ordinalId,
  });

  const toolResult = readToolResult(state);
  if (toolResult) {
    toolMessage.toolResult = toolResult;
  }

  if (rawName === QUESTION_TOOL_NAME) {
    toAskUserQuestionCall(toolMessage, state);
  }

  if (rawName === SUBAGENT_TOOL_NAME) {
    attachOpenCodeSubagent(toolMessage, state, context);
  }

  return [toolMessage];
};

/** Collects how each background subagent finished, from the parent's `synthetic` messages. */
const collectSubagentCompletions = (rows: OpenCodeMessageRow[]): Map<string, OpenCodeSubagentCompletion> => {
  const completions = new Map<string, OpenCodeSubagentCompletion>();
  for (const row of rows) {
    if (row.type !== 'synthetic') {
      continue;
    }

    const data = readJsonRecord(row.data);
    const metadata = readObjectRecord(data?.metadata);
    const childId = readOptionalString(metadata?.childID);
    if (readOptionalString(metadata?.source) !== 'subagent' || !childId) {
      continue;
    }

    completions.set(childId, {
      state: readOptionalString(metadata?.state),
      text: readOptionalString(data?.text) ?? '',
    });
  }

  return completions;
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live OpenCode v2 events, as the OpenCode runtime forwards them:
   * `opencode.v2.content` (one finished assistant content item),
   * `opencode.v2.step_end` (a step finished) and `error`.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type);
    const eventSessionId = readOptionalString(raw.sessionID) ?? sessionId ?? '';
    const timestamp = normalizeProviderTimestamp(raw.timestamp ?? raw.time);
    const messageId = readOptionalString(raw.messageID);

    if (type === 'opencode.v2.content') {
      const item = readObjectRecord(raw.item);
      if (!item) {
        return [];
      }

      const ordinal = typeof raw.ordinal === 'number' ? raw.ordinal : undefined;
      const isSubagent = readOptionalString(item.type) === 'tool'
        && readOptionalString(item.name) === SUBAGENT_TOOL_NAME;
      // A subagent call is forwarded once it has finished, so its child
      // session is in the database by now.
      const db = isSubagent ? openOpenCodeDatabaseForLiveEvent() : null;
      try {
        return normalizeContentItem(
          item,
          messageId ?? generateMessageId('opencode'),
          messageId ? ordinal : undefined,
          eventSessionId,
          timestamp,
          { db, runIsLive: true },
        );
      } finally {
        db?.close();
      }
    }

    if (type === 'opencode.v2.step_end') {
      return [createNormalizedMessage({
        id: messageId ? `${messageId}_end` : generateMessageId('opencode'),
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: generateMessageId('opencode'),
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readErrorMessage(raw.message) ?? readErrorMessage(raw.error) ?? 'Unknown OpenCode error',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite database (`session_message`).
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = db.prepare(`
        SELECT id, type, time_created, data
        FROM session_message
        WHERE session_id = ?
        ORDER BY seq
      `).all(providerSessionId) as OpenCodeMessageRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId, db);
      const tokenUsage = readOpenCodeContextTokenUsage(providerSessionId) ?? undefined;

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(
    rows: OpenCodeMessageRow[],
    sessionId: string,
    db: Database.Database,
  ): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const context: OpenCodeToolContext = {
      db,
      runIsLive: isOpenCodeSessionActive(sessionId),
      subagentCompletions: collectSubagentCompletions(rows),
    };

    for (const row of rows) {
      const data = readJsonRecord(row.data);
      if (!data) {
        continue;
      }

      const timestamp = normalizeProviderTimestamp(row.time_created);

      if (row.type === 'user') {
        const rawContent = unwrapJsonStringLiteral(readOptionalString(data.text) ?? '');
        // Prompts sent with attachments carry <images_input>/<files_input>
        // path lists; strip them for display and surface the paths.
        const parsedImages = parseImagesInputTag(rawContent);
        const parsedFiles = parseFilesInputTag(parsedImages.text);
        if (
          parsedFiles.text.trim()
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: row.id,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
        continue;
      }

      if (row.type === 'assistant') {
        const content = Array.isArray(data.content) ? data.content : [];
        content.forEach((entry, ordinal) => {
          const item = readObjectRecord(entry);
          if (item) {
            normalized.push(...normalizeContentItem(item, row.id, ordinal, sessionId, timestamp, context));
          }
        });

        if (data.error != null && !isInterruptionError(data.error)) {
          normalized.push(createNormalizedMessage({
            id: `${row.id}_error`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'error',
            content: readErrorMessage(data.error) ?? 'Unknown OpenCode error',
          }));
        }
        continue;
      }

      if (row.type === 'compaction' && readOptionalString(data.status) === 'completed') {
        const trigger = readOptionalString(data.reason) === 'manual' ? 'manual' : 'auto';
        normalized.push(createNormalizedMessage({
          id: `${row.id}_compact`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: `Compacted · ${trigger}`,
          compact: { phase: 'done', trigger },
        }));
      }
    }

    return normalized;
  }
}
