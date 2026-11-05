import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { scheduledMessagesDb } from '@/modules/database/repositories/scheduled-messages.db.js';
import { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-inactive-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

const PROJECT = '/workspace/retention-project';
const STARRED_PROJECT = '/workspace/starred-project';
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-05-30T00:00:00.000Z';
const CUTOFF = new Date('2026-05-01T00:00:00.000Z');

function query(overrides: Partial<Parameters<typeof sessionsDb.findInactiveSessions>[0]> = {}) {
  return sessionsDb.findInactiveSessions({
    cutoff: CUTOFF,
    includeArchived: false,
    skipStarredProjects: true,
    excludeSessionIds: [],
    limit: 50,
    ...overrides,
  });
}

test('findInactiveSessions selects only sessions older than the cutoff, oldest first', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('older', 'claude', PROJECT, 'Older', OLD, '2025-12-01T00:00:00.000Z');
    sessionsDb.createSession('old', 'codex', PROJECT, 'Old', OLD, OLD);
    sessionsDb.createSession('recent', 'claude', PROJECT, 'Recent', OLD, RECENT);

    const result = query();
    assert.deepEqual(result.sessions.map((row) => row.session_id), ['older', 'old']);
    assert.equal(result.total, 2);
    assert.equal(result.sessions[1]?.last_activity, OLD);
  });
});

test('findInactiveSessions skips archived rows unless asked, and honours limit and exclusions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('a', 'claude', PROJECT, 'A', OLD, OLD);
    sessionsDb.createSession('b', 'claude', PROJECT, 'B', OLD, OLD);
    sessionsDb.createSession('archived', 'claude', PROJECT, 'Archived', OLD, OLD);
    sessionsDb.updateSessionIsArchived('archived', true);

    assert.deepEqual(query().sessions.map((row) => row.session_id).sort(), ['a', 'b']);
    assert.equal(query({ includeArchived: true }).total, 3);
    assert.deepEqual(query({ excludeSessionIds: ['a'] }).sessions.map((row) => row.session_id), ['b']);

    const limited = query({ includeArchived: true, limit: 1 });
    assert.equal(limited.sessions.length, 1);
    assert.equal(limited.total, 3);
  });
});

test('findInactiveSessions protects starred projects, pending work, cursor rows and unreadable timestamps', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('starred', 'claude', STARRED_PROJECT, 'Starred', OLD, OLD);
    projectsDb.updateProjectIsStarred(STARRED_PROJECT, true);
    sessionsDb.createSession('scheduled', 'claude', PROJECT, 'Scheduled', OLD, OLD);
    sessionsDb.createSession('queued', 'claude', PROJECT, 'Queued', OLD, OLD);
    sessionsDb.createSession('cursor', 'cursor', PROJECT, 'Cursor', OLD, OLD);
    sessionsDb.createSession('garbled', 'claude', PROJECT, 'Garbled', OLD, OLD);
    sessionsDb.createSession('plain', 'claude', PROJECT, 'Plain', OLD, OLD);
    getConnection()
      .prepare("UPDATE sessions SET updated_at = 'not a date', created_at = 'not a date' WHERE session_id = 'garbled'")
      .run();

    const userId = Number(userDb.createUser('retention-user', 'hash').id);
    scheduledMessagesDb.create({
      userId, sessionId: 'scheduled', content: 'later', options: {}, scheduledFor: new Date('2027-01-01T00:00:00.000Z'),
    });
    sessionDraftsDb.appendQueuedMessage(userId, 'queued', { content: 'next', attachments: [] });

    assert.deepEqual(query().sessions.map((row) => row.session_id), ['plain']);
    assert.deepEqual(
      query({ skipStarredProjects: false }).sessions.map((row) => row.session_id).sort(),
      ['plain', 'starred'],
    );
  });
});
