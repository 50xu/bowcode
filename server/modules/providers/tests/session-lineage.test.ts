import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { backfillSessionLineage, indexLineageJsonl, indexOpenCodeLineage, lineageFingerprints, normalizeLineageText, resolveSessionLineage,
  retryUnresolvedLineage, setNativeSessionLineage } from '@/modules/providers/services/session-lineage.service.js';

const PROMPT = 'Implement the session lineage matcher across provider stores, including the incremental transcript index and timestamp safeguards for child sessions.';

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-lineage-'));
  const original = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try { await run(directory); } finally {
    closeConnection();
    if (original === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
}

async function transcript(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function child(provider: 'claude' | 'opencode', id: string, prompt: string, started: number): void {
  sessionsDb.createSession(id, provider, '/fixture/child');
  getConnection().prepare('INSERT INTO session_lineage_prompts VALUES (?, ?, ?, ?)').run(provider, id, prompt, started);
}

function tool(timestamp: number, input: string, sessionId = 'wrong-sidecar-id'): unknown {
  return { type: 'assistant', sessionId, timestamp: new Date(timestamp).toISOString(), message: {
    content: [{ type: 'tool_use', id: `tool-${timestamp}`, name: 'Bash', input: { command: input } }],
  } };
}

test('normalization decodes common escapes and winnowing is stable and deduplicated', () => {
  assert.equal(normalizeLineageText('  `Hi\\n\\t\\"A\\\'\\\\\\u0062`  '), 'hi ab');
  const normalized = normalizeLineageText(PROMPT);
  assert.deepEqual(lineageFingerprints(normalized), lineageFingerprints(normalized));
  assert.ok(lineageFingerprints(normalized).size >= 5);
  assert.equal(lineageFingerprints('short').size, 0);
});

test('Claude sidecar owner wins across projects/providers and later call cannot win', async () => {
  await fixture(async (root) => {
    const now = Date.now() - 30_000;
    const sidecar = path.join(root, 'project-a', 'real-parent', 'subagents', 'agent-42.jsonl');
    const command = `scope: read only\\nproxy-claude -p \\"${PROMPT}\\"`;
    await transcript(sidecar, [tool(now - 2_000, command)]);
    await indexLineageJsonl('claude', sidecar);
    assert.ok((getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count > 0);
    const late = path.join(root, 'project-b', 'late-parent.jsonl');
    await transcript(late, [tool(now + 700, PROMPT, 'late-parent')]);
    await indexLineageJsonl('claude', late);
    child('opencode', 'child', PROMPT, now);
    assert.equal(resolveSessionLineage('opencode', 'child'), true);
    const row = sessionsDb.getSessionByProviderSessionId('child', 'opencode');
    assert.equal(row?.parent_provider, 'claude');
    assert.equal(row?.parent_provider_session_id, 'real-parent');
    assert.equal(row?.parent_agent_id, '42');
    assert.equal(row?.lineage_source, 'prompt-match');
  });
});

test('low similarity stays unlinked and retry resolves child created before parent file', async () => {
  await fixture(async (root) => {
    const now = Date.now() - 10_000;
    child('claude', 'low', 'An unrelated long request about apples oranges and pears and a distant topic not resembling this tool call', now);
    const file = path.join(root, 'parent.jsonl');
    await transcript(file, [tool(now - 1_000, PROMPT, 'parent')]);
    await indexLineageJsonl('claude', file);
    assert.equal(resolveSessionLineage('claude', 'low'), false);
    child('claude', 'retry', PROMPT, now);
    retryUnresolvedLineage();
    assert.equal(sessionsDb.getSessionByProviderSessionId('retry', 'claude')?.parent_provider_session_id, 'parent');
  });
});

test('native lineage replaces a prompt link but neither native links nor cycles are overwritten', async () => {
  await fixture(async () => {
    child('claude', 'native-child', PROMPT, Date.now() - 1_000);
    assert.equal(setNativeSessionLineage('claude', 'native-child', 'native-parent'), true);
    assert.equal(setNativeSessionLineage('claude', 'native-child', 'other-parent'), false);
    assert.equal(sessionsDb.getSessionByProviderSessionId('native-child', 'claude')?.parent_provider_session_id, 'native-parent');
  });
});

test('incremental JSONL indexing waits for a complete appended line', async () => {
  await fixture(async (root) => {
    const file = path.join(root, 'parent.jsonl');
    const row = JSON.stringify(tool(Date.now() - 1_000, PROMPT, 'parent'));
    await writeFile(file, row.slice(0, 50));
    await indexLineageJsonl('claude', file);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, 0);
    await appendFile(file, row.slice(50) + '\n');
    await indexLineageJsonl('claude', file);
    const count = (getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count;
    assert.ok(count > 0);
    await indexLineageJsonl('claude', file);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, count);
  });
});

test('OpenCode reads tool parts incrementally even when timestamps go backwards', async () => {
  await fixture(async (root) => {
    const source = new Database(path.join(root, 'parts.db'));
    try {
      source.exec(`CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE session_part (message_id TEXT, session_id TEXT, call_id TEXT, time_created INTEGER, type TEXT, data TEXT);`);
      const now = Date.now() - 10_000;
      source.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
        .run('user-1', 'opencode-child', 'user', now, JSON.stringify({ text: JSON.stringify(PROMPT) }));
      const insert = source.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('tool-1', 'parent', 'call-1', now - 1_000, 'tool', JSON.stringify({ state: { input: { command: PROMPT } } }));
      indexOpenCodeLineage(source);
      sessionsDb.createSession('opencode-child', 'opencode', '/fixture/child');
      assert.equal(resolveSessionLineage('opencode', 'opencode-child'), true);
      const first = (getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count;
      indexOpenCodeLineage(source);
      assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, first);
      insert.run('tool-2', 'parent', 'call-2', now - 2_000, 'tool', JSON.stringify({ state: { input: { command: PROMPT } } }));
      indexOpenCodeLineage(source);
      assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, first * 2);
    } finally { source.close(); }
  });
});

test('live insertion and retry prune expired calls and their fingerprints', async () => {
  await fixture(async (root) => {
    const file = path.join(root, 'parent.jsonl');
    await transcript(file, [tool(Date.now() - 31 * 60_000, PROMPT, 'old'), tool(Date.now() - 1_000, PROMPT, 'new')]);
    await indexLineageJsonl('claude', file);
    const db = getConnection();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM session_tool_calls').get() as { count: number }).count, 1);
    db.prepare('UPDATE session_tool_calls SET called_at = ?').run(Date.now() - 31 * 60_000);
    retryUnresolvedLineage();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM session_tool_calls').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, 0);
  });
});

test('backfill links historical calls without writing fingerprints or calls', async () => {
  await fixture(async (root) => {
    const home = path.join(root, 'home');
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const now = Date.now() - 60 * 60_000;
      const file = path.join(home, '.claude/projects/project/parent.jsonl');
      await transcript(file, [tool(now - 1_000, PROMPT, 'parent')]);
      child('opencode', 'historical-child', PROMPT, now);
      await backfillSessionLineage();
      assert.equal(sessionsDb.getSessionByProviderSessionId('historical-child', 'opencode')?.parent_provider_session_id, 'parent');
      const db = getConnection();
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM session_tool_fingerprints').get() as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM session_tool_calls').get() as { count: number }).count, 0);
      assert.ok((db.prepare('SELECT byte_offset FROM session_lineage_progress WHERE source = ?')
        .get(`claude:${file}`) as { byte_offset: number }).byte_offset > 0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});

test('cycle prevention rejects a candidate pointing back through an existing parent', async () => {
  await fixture(async (root) => {
    const now = Date.now() - 10_000;
    child('claude', 'a', PROMPT, now);
    child('claude', 'b', PROMPT, now);
    getConnection().prepare(`UPDATE sessions SET parent_provider = 'claude', parent_provider_session_id = 'a', lineage_source = 'native'
      WHERE provider_session_id = 'b'`).run();
    const file = path.join(root, 'b.jsonl');
    await transcript(file, [tool(now - 1_000, PROMPT, 'b')]);
    await indexLineageJsonl('claude', file);
    assert.equal(resolveSessionLineage('claude', 'a'), false);
    assert.equal(sessionsDb.getSessionByProviderSessionId('a', 'claude')?.parent_provider_session_id, null);
  });
});
