import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findExternalClaudeCliSession, listExternalClaudeCliSessions, terminateExternalClaudeCliSession } from '@/modules/providers/services/claude-cli-liveness.service.js';

const stat = (ppid: number, start = '123') => `42 (claude cli) S ${ppid} ${Array(17).fill('0').join(' ')} ${start} 0`;

test('external CLI includes idle entries and excludes only direct server-owned SDK children', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-registry-'));
  try {
    for (const [pid, entrypoint, status] of [
      [101, 'claudecodeui', 'idle'], [102, 'cli', 'idle'], [103, 'claudecodeui', 'busy'],
    ] as const) {
      await writeFile(path.join(directory, `${pid}.json`), JSON.stringify({
        pid, sessionId: `session-${pid}`, entrypoint, status, procStart: '123', cwd: '/work', startedAt: 10,
      }));
    }
    const options = {
      registryDirectory: directory,
      readProcStat: async (pid: number) => stat(pid === 103 ? process.pid + 1 : process.pid),
      kill: (_pid: number, _signal: NodeJS.Signals | 0) => {},
    };
    const sessions = await listExternalClaudeCliSessions(options);
    assert.deepEqual(sessions.map((session) => session.pid), [102, 103]);
    assert.equal(sessions[0].status, 'idle');
    assert.equal((await findExternalClaudeCliSession('session-102', options))?.cwd, '/work');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('takeover signals only a still-matching recorded process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-takeover-'));
  try {
    await writeFile(path.join(directory, '104.json'), JSON.stringify({
      pid: 104, sessionId: 'held', entrypoint: 'cli', status: 'idle', procStart: '123',
    }));
    const signals: Array<NodeJS.Signals | 0> = [];
    let running = true;
    const options = {
      registryDirectory: directory,
      readProcStat: async () => stat(1),
      kill: (_pid: number, signal: NodeJS.Signals | 0) => {
        signals.push(signal);
        if (signal === 'SIGTERM') running = false;
        if (signal === 0 && !running) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    };
    const holder = await findExternalClaudeCliSession('held', options);
    assert.ok(holder);
    await terminateExternalClaudeCliSession(holder, options);
    assert.ok(signals.includes('SIGTERM'));
    assert.equal(signals.includes('SIGKILL'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
