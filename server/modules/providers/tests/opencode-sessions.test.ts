import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';
import {
  createOpenCodeV2Database,
  insertOpenCodeMessage,
  insertOpenCodeProject,
  insertOpenCodeSession,
} from '@/modules/providers/tests/fixtures/opencode-v2-db.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const createOpenCodeDatabase = async (homeDir: string, workspacePath: string): Promise<void> => {
  const db = createOpenCodeV2Database(homeDir);
  try {
    insertOpenCodeProject(db, 'project-1', workspacePath);
    insertOpenCodeSession(db, {
      id: 'open-session-1',
      directory: workspacePath,
      title: 'OpenCode indexed title',
      model: { id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'default' },
      tokens: { input: 10, output: 20, reasoning: 7, cacheRead: 3, cacheWrite: 2 },
      timeCreated: 1_700_000_000_000,
      timeUpdated: 1_700_000_004_000,
    });
    insertOpenCodeSession(db, {
      id: 'open-child-session-1',
      parentId: 'open-session-1',
      directory: workspacePath,
      title: 'OpenCode child session',
      tokens: { input: 5, output: 10, reasoning: 2, cacheRead: 1, cacheWrite: 1 },
      timeCreated: 1_700_000_002_000,
      timeUpdated: 1_700_000_005_000,
    });

    insertOpenCodeMessage(db, {
      id: 'message-user',
      sessionId: 'open-session-1',
      type: 'user',
      seq: 1,
      timeCreated: 1_700_000_001_000,
      data: { time: { created: 1_700_000_001_000 }, text: JSON.stringify('Build the OpenCode integration.'), files: [] },
    });
    insertOpenCodeMessage(db, {
      id: 'message-assistant',
      sessionId: 'open-session-1',
      type: 'assistant',
      seq: 2,
      timeCreated: 1_700_000_002_000,
      data: {
        time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
        agent: 'build',
        model: { id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'default' },
        content: [
          { type: 'reasoning', text: 'I will inspect the provider shape first.' },
          { type: 'text', text: 'The provider is wired.' },
          {
            type: 'tool',
            id: 'tool-call-1',
            name: 'shell',
            state: {
              status: 'completed',
              input: { command: 'npm test', description: 'Run tests' },
              content: [{ type: 'text', text: 'ok' }],
              metadata: { exit: 0 },
            },
          },
        ],
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 3, write: 2 } },
        finish: 'stop',
      },
    });
    insertOpenCodeMessage(db, {
      id: 'message-assistant-latest',
      sessionId: 'open-session-1',
      type: 'assistant',
      seq: 3,
      timeCreated: 1_700_000_003_500,
      data: {
        content: [],
        tokens: { input: 100, output: 6, reasoning: 50, cache: { read: 20, write: 5 } },
        finish: 'stop',
      },
    });
    insertOpenCodeMessage(db, {
      id: 'message-assistant-empty',
      sessionId: 'open-session-1',
      type: 'assistant',
      seq: 4,
      timeCreated: 1_700_000_003_750,
      data: {
        content: [],
        tokens: { input: 0, output: 0, reasoning: 10, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
    });
    // Neither of these is a transcript row.
    insertOpenCodeMessage(db, {
      id: 'message-idle',
      sessionId: 'open-session-1',
      type: 'idle',
      seq: 5,
      data: { outcome: 'succeeded' },
    });
    insertOpenCodeMessage(db, {
      id: 'message-system',
      sessionId: 'open-session-1',
      type: 'system',
      seq: 6,
      data: { text: 'The available skills have changed.' },
    });
  } finally {
    db.close();
  }
};

test('OpenCode session synchronizer indexes sqlite sessions without deletable transcript paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-child-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-child-session-1', 'open-child-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = synchronizer.synchronize();

      return Promise.resolve(processed).then(async (count) => {
        assert.equal(count, 1);
        const indexed = sessionsDb.getSessionById('open-session-1');
        assert.equal(indexed?.provider, 'opencode');
        assert.equal(indexed?.project_path, workspacePath);
        assert.equal(indexed?.custom_name, 'OpenCode indexed title');
        assert.equal(indexed?.jsonl_path, null);
        assert.equal(sessionsDb.getSessionById('app-child-session-1'), null);
        assert.equal(sessionsDb.getSessionByProviderSessionId('open-child-session-1'), null);

        sessionsDb.createAppSession('app-child-session-2', 'opencode', workspacePath);
        sessionsDb.assignProviderSessionId('app-child-session-2', 'open-child-session-1');
        await synchronizer.synchronize(new Date(1_700_000_004_500));
        assert.equal(
          sessionsDb.getSessionById('app-child-session-2')?.provider_session_id,
          'open-child-session-1',
        );
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-session-1', 'open-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-1');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-1')?.provider_session_id, 'open-session-1');
        assert.equal(sessionsDb.getSessionById('open-child-session-1'), null);
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-race', 'opencode', workspacePath);

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-race');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-race')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider strips <images_input> from user turns and exposes attachments', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-images-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    // Rewrite the user text part with the tagged prompt the runtime sends.
    const taggedPrompt = appendImagesInputTag('Look at this screenshot.', [
      { path: 'C:/Users/x/.bowcode/assets/shot.png' },
    ]);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(
        JSON.stringify({ text: taggedPrompt, files: [] }),
        'message-user',
      );
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');
    const userMessage = history.messages.find((message) => message.kind === 'text' && message.role === 'user');

    assert.equal(userMessage?.content, 'Look at this screenshot.');
    assert.deepEqual(userMessage?.images, [{ path: 'C:/Users/x/.bowcode/assets/shot.png' }]);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// The OpenCode runtime forwards each finished assistant content item in this shape.
const normalizeLiveEvent = (event: Record<string, unknown>) =>
  new OpenCodeSessionsProvider().normalizeMessage(event, 'app-session');

const liveContent = (item: Record<string, unknown>, ordinal?: number) => normalizeLiveEvent({
  type: 'opencode.v2.content',
  sessionID: 'ses_1',
  messageID: 'msg_1',
  ordinal,
  timestamp: 1_700_000_000_000,
  item,
});

test('OpenCode sessions provider shows live text and reasoning items as assistant rows', () => {
  const [text] = liveContent({ type: 'text', text: 'Checking.' }, 0);
  const [reasoning] = liveContent({ type: 'reasoning', text: 'multiplying first' }, 1);
  const empty = liveContent({ type: 'text', text: '   ' }, 2);

  assert.deepEqual([text?.kind, text?.role, text?.id, text?.content], ['text', 'assistant', 'msg_1_0', 'Checking.']);
  assert.deepEqual([reasoning?.kind, reasoning?.id, reasoning?.content], ['thinking', 'msg_1_1', 'multiplying first']);
  assert.deepEqual(empty, []);
});

test('OpenCode sessions provider maps a finished live shell call onto Bash with its output', () => {
  const [message] = liveContent({
    type: 'tool',
    id: 'call_1',
    name: 'shell',
    state: {
      status: 'completed',
      input: { command: 'echo hi', workdir: '/tmp' },
      content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'there' }],
    },
  }, 3);

  assert.equal(message?.kind, 'tool_use');
  assert.equal(message?.id, 'msg_1_call_1');
  assert.equal(message?.toolName, 'Bash');
  assert.equal(message?.toolId, 'call_1');
  assert.deepEqual(message?.toolInput, { command: 'echo hi', workdir: '/tmp', description: undefined });
  assert.deepEqual(message?.toolResult, { content: 'hi\nthere', isError: false });
});

test('OpenCode sessions provider reports a failed live tool with its error message', () => {
  const [message] = liveContent({
    type: 'tool',
    id: 'call_2',
    name: 'read',
    state: { status: 'error', input: { path: '/tmp/x' }, error: { type: 'tool.execution', message: 'File not found: /tmp/x' } },
  });

  assert.equal(message?.toolName, 'Read');
  assert.equal((message?.toolInput as Record<string, unknown> | undefined)?.file_path, '/tmp/x');
  assert.deepEqual(message?.toolResult, { content: 'File not found: /tmp/x', isError: true });
});

test('OpenCode sessions provider maps v2 tool inputs onto the keys the chat renders', () => {
  const toolCall = (name: string, input: Record<string, unknown>) => liveContent({
    type: 'tool',
    id: `call_${name}`,
    name,
    state: { status: 'completed', input, content: [] },
  })[0];

  const edit = toolCall('edit', { path: 'a.ts', oldString: 'a', newString: 'b' });
  assert.equal(edit?.toolName, 'Edit');
  assert.deepEqual(edit?.toolInput, {
    path: 'a.ts', oldString: 'a', newString: 'b', file_path: 'a.ts', old_string: 'a', new_string: 'b',
  });

  const write = toolCall('write', { path: 'b.ts', content: 'x' });
  assert.equal(write?.toolName, 'Write');
  assert.deepEqual(write?.toolInput, { path: 'b.ts', content: 'x', file_path: 'b.ts' });

  const grep = toolCall('grep', { pattern: 'foo', path: '/repo', include: '*.ts' });
  assert.equal(grep?.toolName, 'Grep');
  assert.deepEqual(grep?.toolInput, { pattern: 'foo', path: '/repo', include: '*.ts', glob: '*.ts' });

  assert.equal(toolCall('glob', { pattern: '**/*.md' })?.toolName, 'Glob');
  assert.equal(toolCall('webfetch', { url: 'https://x' })?.toolName, 'WebFetch');
  assert.equal(toolCall('websearch', { query: 'q' })?.toolName, 'WebSearch');
  assert.equal(toolCall('skill', { id: 'x' })?.toolName, 'skill');
});

test('OpenCode sessions provider ends the stream on a step end and shows error events', () => {
  const [end] = normalizeLiveEvent({ type: 'opencode.v2.step_end', sessionID: 'ses_1', messageID: 'msg_1', timestamp: 1 });
  const [error] = normalizeLiveEvent({ type: 'error', message: 'Rate limit exceeded' });
  const [errorObject] = normalizeLiveEvent({ type: 'error', error: { type: 'provider.auth', message: 'Bad key' } });

  assert.equal(end?.kind, 'stream_end');
  assert.equal(error?.kind, 'error');
  assert.equal(error?.content, 'Rate limit exceeded');
  assert.equal(errorObject?.content, 'Bad key');
  assert.deepEqual(normalizeLiveEvent({ type: 'session.renamed' }), []);
});

test('OpenCode sessions provider reads sqlite history with the ids live events get, and token usage', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    assert.equal(history.total, 4);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build the OpenCode integration.');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[1]?.id, 'message-assistant_0');
    assert.equal(history.messages[2]?.content, 'The provider is wired.');
    assert.equal(history.messages[2]?.id, 'message-assistant_1');
    assert.equal(history.messages[3]?.kind, 'tool_use');
    assert.equal(history.messages[3]?.id, 'message-assistant_tool-call-1');
    assert.equal(history.messages[3]?.toolName, 'Bash');
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.deepEqual(history.tokenUsage, {
      used: 131,
      inputTokens: 125,
      outputTokens: 6,
      breakdown: {
        input: 125,
        output: 6,
      },
    });

    // A live event for the same item gets the same id, so a reload does not duplicate it.
    const [live] = new OpenCodeSessionsProvider().normalizeMessage({
      type: 'opencode.v2.content',
      sessionID: 'open-session-1',
      messageID: 'message-assistant',
      ordinal: 1,
      item: { type: 'text', text: 'The provider is wired.' },
    }, 'open-session-1');
    assert.equal(live?.id, history.messages[2]?.id);

    const paged = await provider.fetchHistory('open-session-1', { limit: 2, offset: 0 });
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.messages[0]?.content, 'The provider is wired.');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const QUESTION_TOOL_STATE = {
  status: 'completed',
  input: {
    questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] },
      {
        question: 'Which sizes?',
        header: 'Sizes',
        multiple: true,
        options: [{ label: 'Small', description: '' }, { label: 'Large, wide', description: '' }],
      },
    ],
  },
  content: [{ type: 'text', text: 'User has answered your questions: "Which color?"="Red", "Which sizes?"="Small, Large, wide".' }],
  // OpenCode keeps the picked labels as one list per question.
  metadata: { answers: [['Red'], ['Small', 'Large, wide']], truncated: false },
};

test('OpenCode sessions provider shows a live question call as the question card with its answers', () => {
  const [message] = liveContent({ type: 'tool', id: 'call_q', name: 'question', state: QUESTION_TOOL_STATE });

  assert.equal(message?.toolName, 'AskUserQuestion');
  const input = message?.toolInput as { questions: Array<{ multiSelect?: boolean }>; answers?: unknown } | undefined;
  assert.equal(input?.questions[1]?.multiSelect, true);
  assert.deepEqual(input?.answers, { 'Which color?': 'Red', 'Which sizes?': 'Small, Large, wide' });
  assert.equal(message?.toolResult?.isError, false);
});

test('OpenCode history hides the error of a stopped turn, shows question cards and compactions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-stopped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      // Stopping a turn interrupts the session, which stores this on the step it interrupted.
      insertOpenCodeMessage(db, {
        id: 'message-stopped',
        sessionId: 'open-session-1',
        type: 'assistant',
        seq: 10,
        data: { content: [], finish: 'error', error: { type: 'aborted', message: 'Step interrupted' } },
      });
      insertOpenCodeMessage(db, {
        id: 'message-failed',
        sessionId: 'open-session-1',
        type: 'assistant',
        seq: 11,
        data: {
          content: [{ type: 'tool', id: 'call_q', name: 'question', state: QUESTION_TOOL_STATE }],
          finish: 'error',
          error: { type: 'provider.invalid-request', message: 'Rate limit exceeded' },
        },
      });
      insertOpenCodeMessage(db, {
        id: 'message-compaction',
        sessionId: 'open-session-1',
        type: 'compaction',
        seq: 12,
        data: { status: 'completed', reason: 'manual', summary: '## Objective' },
      });
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('open-session-1');
    const errors = history.messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1, 'only the real failure shows as an error');
    assert.match(String(errors[0]?.content), /Rate limit exceeded/);

    const card = history.messages.find((message) => message.toolId === 'call_q');
    assert.equal(card?.toolName, 'AskUserQuestion');
    const cardInput = card?.toolInput as { answers?: unknown } | undefined;
    assert.deepEqual(cardInput?.answers, { 'Which color?': 'Red', 'Which sizes?': 'Small, Large, wide' });

    const compaction = history.messages.at(-1);
    assert.equal(compaction?.kind, 'text');
    assert.deepEqual(compaction?.compact, { phase: 'done', trigger: 'manual' });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Seeds a single OpenCode session with a controllable stored title and first
 * user message, so the derived name is unambiguous.
 */
const seedOpenCodeSession = async (
  homeDir: string,
  workspacePath: string,
  options: { sessionId: string; title: string | null; firstUserText: string },
): Promise<void> => {
  const db = createOpenCodeV2Database(homeDir);
  try {
    insertOpenCodeProject(db, 'project-1', workspacePath);
    insertOpenCodeSession(db, {
      id: options.sessionId,
      directory: workspacePath,
      title: options.title,
      timeCreated: 1_700_000_000_000,
      timeUpdated: 1_700_000_001_000,
    });
    insertOpenCodeMessage(db, {
      id: 'message-user',
      sessionId: options.sessionId,
      type: 'user',
      seq: 1,
      // OpenCode can persist the prompt as a JSON string literal inside the
      // text field, so double-encode it here to exercise the unwrap on read.
      data: { text: JSON.stringify(options.firstUserText), files: [] },
    });
  } finally {
    db.close();
  }
};

test('OpenCode synchronizer preserves the title assigned when Bowcode creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Both provider-owned values differ from the Bowcode title so either one
    // leaking through would change the assertion below.
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-app-1',
      title: 'OpenCode generated title',
      firstUserText: 'OpenCode first user prompt',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the checkout crash');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-indexed-1',
      title: 'OpenCode generated title',
      firstUserText: 'This prompt should be ignored',
    });
    await withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('oc-indexed-1')?.custom_name, 'OpenCode generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
