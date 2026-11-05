import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findExternalClaudeCliSession,
  findOwnedClaudeCliSessions,
  listExternalClaudeCliSessions,
  terminateExternalClaudeCliSession,
  terminateOwnedClaudeCliSession,
} from '@/modules/providers/services/claude-cli-liveness.service.js';

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

test('a leftover server-owned process holding a session is found and stopped; external ones are not touched by it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-leftover-'));
  try {
    await writeFile(path.join(directory, '201.json'), JSON.stringify({
      pid: 201, sessionId: 'dup', entrypoint: 'claudecodeui', status: 'busy', procStart: '123',
    }));
    await writeFile(path.join(directory, '202.json'), JSON.stringify({
      pid: 202, sessionId: 'dup', entrypoint: 'cli', status: 'idle', procStart: '123',
    }));
    const signalled: Array<[number, NodeJS.Signals | 0]> = [];
    const alive = new Set([201, 202]);
    const options = {
      registryDirectory: directory,
      // 201 is this server's child; 202 belongs to someone else.
      readProcStat: async (pid: number) => stat(pid === 201 ? process.pid : 1),
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        signalled.push([pid, signal]);
        if (signal === 'SIGTERM') alive.delete(pid);
        if (signal === 0 && !alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    };
    const leftovers = await findOwnedClaudeCliSessions('dup', options);
    assert.deepEqual(leftovers.map((session) => session.pid), [201]);
    await terminateOwnedClaudeCliSession(leftovers[0], options);
    assert.ok(signalled.some(([pid, signal]) => pid === 201 && signal === 'SIGTERM'));
    assert.equal(signalled.some(([pid, signal]) => pid === 202 && signal !== 0), false);

    const external = await findExternalClaudeCliSession('dup', options);
    assert.ok(external);
    await assert.rejects(terminateOwnedClaudeCliSession(external, options));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
