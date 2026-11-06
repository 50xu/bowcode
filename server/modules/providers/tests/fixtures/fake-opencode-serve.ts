/**
 * A stand-in for OpenCode 2's `opencode serve`, used by the OpenCode runtime
 * tests in place of the real binary. The runtime spawns it exactly like
 * OpenCode (`opencode serve --hostname=… --port=…`) and waits for the same
 * "listening on" line; it then talks to it through `@opencode/client`.
 *
 * It implements just the `/api` routes the runtime uses, with OpenCode 2's
 * semantics where they matter: Basic auth from OPENCODE_SERVER_PASSWORD, an
 * SSE event stream that opens with `server.connected`, a prompt that answers at
 * once while the turn runs, permission requests and question forms that wait
 * for their reply, and an interrupt that ends the turn as interrupted.
 *
 * The turn is scripted through FAKE_OPENCODE_SCENARIO (JSON, see `Scenario`);
 * every request is appended to FAKE_OPENCODE_LOG as one JSON line.
 */
import fs from 'node:fs';
import http from 'node:http';

type QuestionInput = {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type Step =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
    type: 'permission';
    id: string;
    action: string;
    resources: string[];
    save: string[];
    metadata?: Record<string, unknown>;
    /** Session the request belongs to; defaults to the turn's own (a subagent's differs). */
    sessionID?: string;
  }
  /** The agent's `question` tool, which OpenCode 2 asks through a form. */
  | { type: 'question'; id: string; questions: QuestionInput[] }
  /** Several requests asked at once; a reject of one rejects the rest, as OpenCode does. */
  | { type: 'parallel-permissions'; requests: Array<{ id: string; action: string; resources: string[]; save: string[] }> }
  /** The turn fails with this error. */
  | { type: 'error'; errorType: string; message: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'crash' }
  | { type: 'hang' };

type Scenario = {
  /** Id given to a session created through POST /api/session. */
  newSessionId?: string;
  /** Sessions GET /api/session/:id knows; any other id answers 404. */
  sessions?: Record<string, { agent?: string; model?: { providerID: string; id: string; variant?: string } }>;
  defaultAgent?: string;
  /** Answered with a status instead of 200, as OpenCode does for a bad prompt. */
  promptStatus?: number;
  /** Version /api/info reports; null makes the route missing, as on OpenCode 1. */
  version?: string | null;
  /** How long POST /api/session/:id/interrupt takes to answer. */
  abortDelayMs?: number;
  /**
   * Requests OpenCode has already settled by the time the chat's reply lands
   * (a cascade raced it): the reply gets the 404 OpenCode sends, and the
   * request is settled as rejected.
   */
  replyNotFound?: string[];
  /** A question form OpenCode raises while the interrupt is being handled. */
  askOnAbort?: { id: string; questions: QuestionInput[] };
  steps: Step[];
};

const args = process.argv.slice(2);
const readFlag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const scenario = JSON.parse(process.env.FAKE_OPENCODE_SCENARIO || '{"steps":[]}') as Scenario;
const logPath = process.env.FAKE_OPENCODE_LOG;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';

const log = (entry: Record<string, unknown>) => {
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
};

if (args[0] !== 'serve') {
  console.error(`fake opencode: unsupported command ${args.join(' ')}`);
  process.exit(2);
}

type SessionState = { agent?: string; model?: { providerID: string; id: string; variant?: string }; directory?: string };

const streams = new Set<http.ServerResponse>();
const sessions = new Map<string, SessionState>(Object.entries(scenario.sessions ?? {}));
const waiting = new Map<string, (value: unknown) => void>();
let eventCounter = 0;
let turnAborted: (() => void) | null = null;

const emit = (type: string, data: Record<string, unknown>) => {
  const event = JSON.stringify({ id: `evt_${++eventCounter}`, created: Date.now(), type, data });
  for (const stream of streams) {
    stream.write(`data: ${event}\n\n`);
  }
};

/** The form OpenCode 2's `question` tool creates: one field per question. */
const toForm = (id: string, sessionID: string, questions: QuestionInput[]) => ({
  id,
  sessionID,
  title: 'Questions',
  metadata: { kind: 'question' },
  fields: questions.map((question, index) => ({
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiple ? 'multiselect' : 'string',
    options: (question.options ?? []).map((option) => ({ value: option.label, label: option.label, description: option.description })),
    custom: question.custom ?? true,
  })),
});

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sendEmpty = (res: http.ServerResponse) => {
  res.writeHead(204);
  res.end();
};

const readBody = (req: http.IncomingMessage) => new Promise<unknown>((resolve) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : undefined);
    } catch {
      resolve(raw);
    }
  });
});

const sessionInfo = (id: string) => {
  const session = sessions.get(id) ?? {};
  return {
    id,
    projectID: 'prj_fake',
    agent: session.agent,
    model: session.model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
    location: { directory: session.directory ?? '/' },
  };
};

/** Runs the scripted turn the way OpenCode 2's session loop reports it. */
async function runTurn(sessionID: string): Promise<void> {
  const aborted = new Promise<'aborted'>((resolve) => {
    turnAborted = () => resolve('aborted');
  });
  const assistantMessageID = 'msg_assistant';
  let ordinal = 0;
  let stepTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  emit('session.execution.started', { sessionID });
  emit('session.step.started', { sessionID, assistantMessageID, agent: sessions.get(sessionID)?.agent ?? 'build' });

  const toolCall = (id: string, name: string, input: Record<string, unknown>) => {
    emit('session.tool.input.started', { sessionID, assistantMessageID, id, name });
    emit('session.tool.called', { sessionID, assistantMessageID, id, input, executed: false });
  };

  for (const step of scenario.steps) {
    if (step.type === 'crash') {
      process.exit(1);
    }

    if (step.type === 'error') {
      emit('session.execution.failed', { sessionID, error: { type: step.errorType, message: step.message } });
      return;
    }

    if (step.type === 'hang') {
      await aborted;
      emit('session.execution.interrupted', { sessionID });
      return;
    }

    if (step.type === 'usage') {
      stepTokens = { input: step.input, output: step.output, reasoning: 0, cache: { read: 0, write: 0 } };
      emit('session.usage.updated', {
        sessionID,
        cost: 0,
        tokens: { input: 900_000_000, output: 100_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      continue;
    }

    if (step.type === 'text' || step.type === 'reasoning') {
      emit(`session.${step.type}.started`, { sessionID, assistantMessageID, ordinal });
      emit(`session.${step.type}.ended`, { sessionID, assistantMessageID, ordinal, text: step.text });
      ordinal += 1;
      continue;
    }

    if (step.type === 'permission') {
      const callId = `call_${step.id}`;
      toolCall(callId, step.action, step.metadata ?? {});
      const answer = new Promise<unknown>((resolve) => waiting.set(step.id, resolve));
      emit('permission.asked', {
        id: step.id,
        sessionID: step.sessionID ?? sessionID,
        action: step.action,
        resources: step.resources,
        save: step.save,
        metadata: step.metadata ?? {},
        source: { type: 'tool', messageID: assistantMessageID, id: callId },
      });
      const outcome = await Promise.race([answer, aborted]);
      if (outcome === 'aborted') {
        emit('session.execution.interrupted', { sessionID });
        return;
      }
      if (outcome === 'reject') {
        emit('session.tool.failed', {
          sessionID,
          assistantMessageID,
          id: callId,
          error: { type: 'permission.rejected', message: 'The user rejected permission to use this specific tool call.' },
          executed: false,
        });
        break;
      }
      emit('session.tool.success', {
        sessionID,
        assistantMessageID,
        id: callId,
        content: [{ type: 'text', text: `ran ${step.resources.join(' ')}` }],
        executed: false,
      });
      continue;
    }

    if (step.type === 'parallel-permissions') {
      const answers = step.requests.map((request) => {
        const answer = new Promise<unknown>((resolve) => waiting.set(request.id, resolve));
        emit('permission.asked', { ...request, sessionID, metadata: {} });
        return answer;
      });
      const first = await Promise.race([Promise.race(answers), aborted]);
      if (first === 'aborted') {
        emit('session.execution.interrupted', { sessionID });
        return;
      }
      if (first === 'reject') {
        // OpenCode rejects every other pending request of the session too.
        for (const request of step.requests) {
          const resolve = waiting.get(request.id);
          if (resolve) {
            waiting.delete(request.id);
            emit('permission.replied', { sessionID, requestID: request.id, reply: 'reject' });
            resolve('reject');
          }
        }
        break;
      }
      await Promise.all(answers);
      continue;
    }

    if (step.type === 'question') {
      const callId = `call_${step.id}`;
      toolCall(callId, 'question', { questions: step.questions });
      const answer = new Promise<unknown>((resolve) => waiting.set(step.id, resolve));
      emit('form.created', { form: toForm(step.id, sessionID, step.questions) });
      const outcome = await Promise.race([answer, aborted]);
      if (outcome === 'aborted') {
        emit('session.execution.interrupted', { sessionID });
        return;
      }
      const reply = outcome as { cancelled: true } | { answer: Record<string, unknown> };
      if ('cancelled' in reply) {
        emit('session.tool.failed', {
          sessionID,
          assistantMessageID,
          id: callId,
          error: { type: 'form.cancelled', message: 'The user dismissed this question' },
          executed: false,
        });
        break;
      }
      const answers = step.questions.map((_, index) => {
        const value = reply.answer[`q${index}`];
        return Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
      });
      emit('session.tool.success', {
        sessionID,
        assistantMessageID,
        id: callId,
        content: [{ type: 'text', text: 'User has answered your questions' }],
        metadata: { answers },
        executed: false,
      });
    }
  }

  emit('session.step.ended', {
    sessionID,
    assistantMessageID,
    finish: 'stop',
    cost: 0,
    tokens: stepTokens,
  });
  emit('session.execution.succeeded', { sessionID });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  const body = req.method === 'GET' ? undefined : await readBody(req);
  const authorization = req.headers.authorization ?? null;
  log({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization, body });

  if (password && authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) {
    sendJson(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
    return;
  }

  const path = url.pathname;
  let match: RegExpExecArray | null;

  if (req.method === 'GET' && path === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    streams.add(res);
    res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
    req.on('close', () => streams.delete(res));
    return;
  }

  if (req.method === 'GET' && path === '/api/info') {
    if (scenario.version === null) {
      sendJson(res, 404, { _tag: 'NotFoundError', message: 'No route' });
      return;
    }
    sendJson(res, 200, { version: scenario.version ?? '2.2.5', pid: process.pid, urls: [], paths: { tmp: '/tmp' } });
    return;
  }

  if (req.method === 'GET' && path === '/api/config') {
    sendJson(res, 200, [{ type: 'document', info: scenario.defaultAgent ? { default_agent: scenario.defaultAgent } : {} }]);
    return;
  }

  if (req.method === 'POST' && path === '/api/session') {
    const id = scenario.newSessionId ?? 'ses_fake_new';
    const input = (body ?? {}) as { agent?: string; model?: SessionState['model']; location?: { directory?: string } };
    sessions.set(id, { agent: input.agent ?? 'build', model: input.model, directory: input.location?.directory });
    sendJson(res, 200, { data: sessionInfo(id) });
    return;
  }

  if ((match = /^\/api\/session\/([^/]+)(?:\/(agent|model|prompt|interrupt))?$/.exec(path))) {
    const [, sessionID, action] = match;
    if (!sessions.has(sessionID)) {
      sendJson(res, 404, { _tag: 'SessionNotFoundError', message: `Session not found: ${sessionID}` });
      return;
    }
    const session = sessions.get(sessionID)!;

    if (req.method === 'GET' && !action) {
      sendJson(res, 200, { data: sessionInfo(sessionID) });
      return;
    }

    if (req.method === 'POST' && action === 'agent') {
      session.agent = (body as { agent?: string } | undefined)?.agent;
      sendEmpty(res);
      return;
    }

    if (req.method === 'POST' && action === 'model') {
      session.model = (body as { model?: SessionState['model'] } | undefined)?.model;
      sendEmpty(res);
      return;
    }

    if (req.method === 'POST' && action === 'prompt') {
      if (scenario.promptStatus) {
        sendJson(res, scenario.promptStatus, { _tag: 'BadRequest', message: 'The prompt was refused' });
        return;
      }
      sendJson(res, 200, {
        data: { id: 'msg_user', sessionID, time: { created: Date.now() }, type: 'user', payload: { text: (body as { text?: string })?.text ?? '' }, delivery: 'steer' },
      });
      void runTurn(sessionID);
      return;
    }

    if (req.method === 'POST' && action === 'interrupt') {
      if (scenario.askOnAbort) {
        emit('form.created', { form: toForm(scenario.askOnAbort.id, sessionID, scenario.askOnAbort.questions) });
      }
      if (scenario.abortDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, scenario.abortDelayMs));
      }
      turnAborted?.();
      sendJson(res, 200, { interrupted: true });
      return;
    }
  }

  if ((match = /^\/api\/session\/([^/]+)\/(permission|form)\/([^/]+)(\/reply)?$/.exec(path))) {
    const [, sessionID, kind, requestID, reply] = match;
    const resolve = waiting.get(requestID);
    const notFound = kind === 'permission'
      ? { _tag: 'PermissionNotFoundError', message: `Permission request not found: ${requestID}` }
      : { _tag: 'FormNotFoundError', message: `Form not found: ${requestID}` };
    if (!resolve) {
      sendJson(res, 404, notFound);
      return;
    }
    if (scenario.replyNotFound?.includes(requestID)) {
      waiting.delete(requestID);
      emit('permission.replied', { sessionID, requestID, reply: 'reject' });
      resolve('reject');
      sendJson(res, 404, notFound);
      return;
    }

    if (kind === 'permission' && req.method === 'POST' && reply) {
      waiting.delete(requestID);
      const decision = (body as { decision?: string } | undefined)?.decision;
      emit('permission.replied', { sessionID, requestID, reply: decision });
      resolve(decision);
      sendEmpty(res);
      return;
    }

    if (kind === 'form' && req.method === 'POST' && reply) {
      waiting.delete(requestID);
      const answer = (body as { answer?: Record<string, unknown> } | undefined)?.answer ?? {};
      emit('form.replied', { id: requestID, sessionID, answer });
      resolve({ answer });
      sendEmpty(res);
      return;
    }

    if (kind === 'form' && req.method === 'DELETE') {
      waiting.delete(requestID);
      emit('form.cancelled', { id: requestID, sessionID });
      resolve({ cancelled: true });
      sendEmpty(res);
      return;
    }
  }

  sendJson(res, 404, { _tag: 'NotFoundError', message: `No route for ${req.method} ${path}` });
});

server.listen(Number(readFlag('port') ?? 0), readFlag('hostname') ?? '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  log({ started: true, pid: process.pid, port, args, passwordSet: Boolean(password) });
  console.log(`server listening on http://${readFlag('hostname') ?? '127.0.0.1'}:${port}`);
});
