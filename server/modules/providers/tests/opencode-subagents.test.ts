import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type Database from 'better-sqlite3';

import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import {
  createOpenCodeV2Database,
  insertOpenCodeMessage,
  insertOpenCodeProject,
  insertOpenCodeSession,
  type OpenCodeSessionFixture,
} from '@/modules/providers/tests/fixtures/opencode-v2-db.js';

type SubagentStatus = 'running' | 'completed' | 'error' | 'streaming';

// A `subagent` call as OpenCode 2 stores it: the child session id lives in `state.metadata`.
const subagentItem = (
  status: SubagentStatus,
  options: { metadata?: Record<string, unknown>; content?: string; error?: Record<string, unknown> } = {},
) => ({
  type: 'tool',
  id: 'call_task',
  name: 'subagent',
  state: {
    status,
    input: { agent: 'general', description: 'Count Markdown files', prompt: 'Count the .md files.' },
    ...(status === 'completed'
      ? {
          content: [{
            type: 'text',
            text: options.content ?? '<subagent sessionID="ses_child" state="completed">\n**3** files\n</subagent>',
          }],
        }
      : {}),
    ...(status === 'error' ? { error: options.error ?? { type: 'tool.execution', message: 'boom' } } : {}),
    metadata: { sessionID: 'ses_child', status: 'completed', truncated: false, ...options.metadata },
  },
});

type SetUp = {
  child?: Partial<OpenCodeSessionFixture>;
  extraChildSteps?: number;
  seed?: (db: Database.Database) => void;
};

async function withOpenCodeDatabase(
  parentItem: Record<string, unknown>,
  runTest: (provider: OpenCodeSessionsProvider, dataDir: string) => Promise<void>,
  setUp: SetUp = {},
): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-subagents-'));
  const originalHomedir = os.homedir;
  (os as any).homedir = () => homeDir;

  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  const db = createOpenCodeV2Database(homeDir);
  try {
    insertOpenCodeProject(db, 'project-1', homeDir);
    insertOpenCodeSession(db, { id: 'ses_parent', directory: homeDir });
    insertOpenCodeSession(db, {
      id: 'ses_child',
      parentId: 'ses_parent',
      directory: homeDir,
      model: { id: 'gpt-6-luna', providerID: 'openai' },
      idleOutcome: 'succeeded',
      ...setUp.child,
    });

    insertOpenCodeMessage(db, { id: 'msg_p1', sessionId: 'ses_parent', type: 'user', seq: 1, data: { text: 'use a subagent' } });
    insertOpenCodeMessage(db, {
      id: 'msg_p2',
      sessionId: 'ses_parent',
      type: 'assistant',
      seq: 2,
      data: {
        content: [
          parentItem,
          { type: 'tool', id: 'call_parent_glob', name: 'glob', state: { status: 'completed', input: {}, content: [] } },
        ],
      },
    });

    // The child's own prompt is a user message: it is the call's input, not activity.
    insertOpenCodeMessage(db, { id: 'msg_c1', sessionId: 'ses_child', type: 'user', seq: 1, data: { text: 'Count the .md files.' } });
    const childContent: Record<string, unknown>[] = [
      { type: 'reasoning', text: 'Globbing.' },
      {
        type: 'tool',
        id: 'call_glob',
        name: 'glob',
        state: { status: 'completed', input: { pattern: '**/*.md' }, content: [{ type: 'text', text: 'a.md\nb.md\nc.md' }] },
      },
      { type: 'tool', id: 'call_read', name: 'read', state: { status: 'running', input: { path: 'a.md' } } },
      { type: 'text', text: '3' },
    ];
    for (let step = 0; step < (setUp.extraChildSteps ?? 0); step += 1) {
      childContent.push({
        type: 'tool', id: `call_x${step}`, name: 'read', state: { status: 'completed', input: {}, content: [] },
      });
    }
    insertOpenCodeMessage(db, {
      id: 'msg_c2',
      sessionId: 'ses_child',
      type: 'assistant',
      seq: 2,
      data: { content: childContent },
    });
    setUp.seed?.(db);
  } finally {
    db.close();
  }

  try {
    await runTest(new OpenCodeSessionsProvider(), dataDir);
  } finally {
    (os as any).homedir = originalHomedir;
    await rm(homeDir, { recursive: true, force: true });
  }
}

const readTask = async (provider: OpenCodeSessionsProvider) => {
  const history = await provider.fetchHistory('app-session', { providerSessionId: 'ses_parent' });
  return { history, task: history.messages.find((message) => message.toolName === 'Task') };
};

test('a subagent call in history becomes a subagent container with the child session timeline', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('completed'), async (provider) => {
    const { history, task } = await readTask(provider);

    assert.equal(task?.id, 'msg_p2_call_task');
    assert.deepEqual(task?.subagent, {
      id: 'ses_child',
      type: 'general',
      description: 'Count Markdown files',
      status: 'completed',
      model: 'gpt-6-luna',
      activityCount: 4,
    });
    assert.equal((task?.toolInput as Record<string, unknown> | undefined)?.subagent_type, 'general');
    assert.deepEqual(
      task?.subagentTools?.map((entry) => [entry.kind, entry.toolName ?? entry.content, entry.toolResult?.content ?? null]),
      [
        ['thinking', 'Globbing.', null],
        ['tool', 'Glob', 'a.md\nb.md\nc.md'],
        ['tool', 'Read', null],
        ['text', '3', null],
      ],
    );
    // The answer is shown without the tool's own wrapper, so it renders as markdown.
    assert.equal(task?.toolResult?.content, '**3** files');

    const otherTool = history.messages.find((message) => message.toolName === 'Glob');
    assert.equal(otherTool?.subagent, undefined);
  });
});

test('a subagent left unfinished with no live run is shown as stopped, with what it did so far', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('streaming'), async (provider) => {
    const { task } = await readTask(provider);

    assert.equal(task?.subagent?.status, 'stopped');
    assert.equal(task?.toolResult, undefined);
    assert.equal(task?.subagentTools?.length, 4);
  });
});

test('a subagent the user interrupted is shown as stopped, not failed', { concurrency: false }, async () => {
  await withOpenCodeDatabase(
    subagentItem('error', { error: { type: 'aborted', message: 'Tool execution interrupted' } }),
    async (provider) => {
      const { task } = await readTask(provider);

      assert.equal(task?.subagent?.status, 'stopped');
    },
  );
});

test('a failed subagent is reported as a failed subagent', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('error'), async (provider) => {
    const { task } = await readTask(provider);

    assert.equal(task?.subagent?.status, 'failed');
    assert.equal(task?.toolResult?.isError, true);
    assert.equal(task?.toolResult?.content, 'boom');
  });
});

test('a background subagent takes its outcome and answer from the synthetic message', { concurrency: false }, async () => {
  const background = subagentItem('completed', {
    metadata: { status: 'running' },
    content: 'The subagent is working in the background (sessionID: ses_child).',
  });
  await withOpenCodeDatabase(background, async (provider) => {
    const { task } = await readTask(provider);

    assert.equal(task?.subagent?.status, 'failed');
    assert.deepEqual(task?.toolResult, { content: 'quota exceeded', isError: true });
  }, {
    seed: (db) => insertOpenCodeMessage(db, {
      id: 'msg_p3',
      sessionId: 'ses_parent',
      type: 'synthetic',
      seq: 3,
      data: {
        metadata: { source: 'subagent', childID: 'ses_child', agent: 'General', state: 'error' },
        text: '<subagent sessionID="ses_child" state="error" description="Count Markdown files">\nquota exceeded\n</subagent>',
      },
    }),
  });
});

test('a background subagent without a report follows its child session', { concurrency: false }, async () => {
  const background = subagentItem('completed', { metadata: { status: 'running' }, content: 'working' });

  await withOpenCodeDatabase(background, async (provider) => {
    assert.equal((await readTask(provider)).task?.subagent?.status, 'running');
  }, { child: { idleOutcome: null, timeBusy: 10, timeIdle: null } });

  await withOpenCodeDatabase(background, async (provider) => {
    assert.equal((await readTask(provider)).task?.subagent?.status, 'stopped');
  }, { child: { idleOutcome: 'interrupted', timeBusy: 10, timeIdle: 20 } });

  await withOpenCodeDatabase(background, async (provider) => {
    assert.equal((await readTask(provider)).task?.subagent?.status, 'completed');
  });
});

test('a long subagent keeps its latest steps and reports the full count', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('completed'), async (provider) => {
    const { task } = await readTask(provider);

    assert.equal(task?.subagent?.activityCount, 254);
    assert.equal(task?.subagentTools?.length, 200);
    assert.equal(task?.subagentTools?.at(-1)?.toolId, 'call_x249');
  }, { extraChildSteps: 250 });
});

const liveSubagentEvent = (item: Record<string, unknown>) => ({
  type: 'opencode.v2.content',
  sessionID: 'ses_parent',
  messageID: 'msg_p2',
  ordinal: 0,
  item,
});

test('the live subagent event carries the subagent and its timeline', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('completed'), async (provider) => {
    const [message] = provider.normalizeMessage(liveSubagentEvent(subagentItem('completed')), 'app-session');

    assert.equal(message?.id, 'msg_p2_call_task');
    assert.equal(message?.toolName, 'Task');
    assert.equal(message?.subagent?.type, 'general');
    assert.equal(message?.subagent?.status, 'completed');
    assert.equal(message?.subagentTools?.length, 4);
    assert.equal(message?.toolResult?.content, '**3** files');
  });
});

test('a live background subagent is shown running while its child session works', { concurrency: false }, async () => {
  const background = subagentItem('completed', { metadata: { status: 'running' }, content: 'working' });
  await withOpenCodeDatabase(background, async (provider) => {
    const [message] = provider.normalizeMessage(liveSubagentEvent(background), 'app-session');

    assert.equal(message?.subagent?.status, 'running');
  }, { child: { idleOutcome: null } });
});

test('a live subagent still renders as a subagent when the database cannot be opened', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('completed'), async (provider, dataDir) => {
    const dbPath = path.join(dataDir, 'opencode.db');
    await rm(dbPath);
    await mkdir(dbPath);

    const [message] = provider.normalizeMessage(liveSubagentEvent(subagentItem('completed')), 'app-session');

    assert.equal(message?.subagent?.status, 'completed');
    assert.equal(message?.subagentTools, undefined);
  });
});

test('a subagent whose child session is missing still renders as a subagent, without a timeline', { concurrency: false }, async () => {
  await withOpenCodeDatabase(subagentItem('completed'), async (provider) => {
    const [message] = provider.normalizeMessage(
      liveSubagentEvent(subagentItem('completed', { metadata: { sessionID: 'ses_gone' } })),
      'app-session',
    );

    assert.equal(message?.subagent?.id, 'ses_gone');
    assert.equal(message?.subagentTools, undefined);
  });
});
