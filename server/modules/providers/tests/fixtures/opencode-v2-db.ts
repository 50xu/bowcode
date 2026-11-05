import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

/**
 * Test fixture for OpenCode v2's shared `opencode.db`: the `project`,
 * `session_v2`, `session_message` and `credential` tables with the columns the
 * OpenCode CLI 2.x creates, plus insert helpers with sensible defaults.
 */

/** Creates (or opens) `<homeDir>/.local/share/opencode/opencode.db` with the v2 schema. */
export function createOpenCodeV2Database(homeDir: string): Database.Database {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      sandboxes TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT,
      version TEXT NOT NULL,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_idle INTEGER,
      idle_outcome TEXT,
      time_archived INTEGER,
      time_busy INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential (
      id TEXT PRIMARY KEY,
      integration_id TEXT,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      connector_id TEXT,
      method_id TEXT,
      active INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `);
  return db;
}

export function insertOpenCodeProject(db: Database.Database, id: string, worktree: string): void {
  db.prepare(`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES (?, ?, 1700000000000, 1700000000000, '[]')
  `).run(id, worktree);
}

export type OpenCodeSessionFixture = {
  id: string;
  projectId?: string;
  parentId?: string | null;
  directory?: string;
  title?: string | null;
  model?: Record<string, unknown> | null;
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  timeCreated?: number;
  timeUpdated?: number;
  timeArchived?: number | null;
  timeBusy?: number | null;
  timeIdle?: number | null;
  idleOutcome?: string | null;
};

export function insertOpenCodeSession(db: Database.Database, session: OpenCodeSessionFixture): void {
  const tokens = session.tokens ?? {};
  db.prepare(`
    INSERT INTO session_v2 (
      id, project_id, parent_id, slug, directory, title, version, model,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated, time_archived, time_busy, time_idle, idle_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, '2.2.5', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.projectId ?? 'project-1',
    session.parentId ?? null,
    session.id,
    session.directory ?? '',
    session.title ?? null,
    session.model ? JSON.stringify(session.model) : null,
    tokens.input ?? 0,
    tokens.output ?? 0,
    tokens.reasoning ?? 0,
    tokens.cacheRead ?? 0,
    tokens.cacheWrite ?? 0,
    session.timeCreated ?? 1_700_000_000_000,
    session.timeUpdated ?? session.timeCreated ?? 1_700_000_000_000,
    session.timeArchived ?? null,
    session.timeBusy ?? null,
    session.timeIdle ?? null,
    session.idleOutcome ?? null,
  );
}

export type OpenCodeMessageFixture = {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  timeCreated?: number;
  data: Record<string, unknown>;
};

export function insertOpenCodeMessage(db: Database.Database, message: OpenCodeMessageFixture): void {
  const timeCreated = message.timeCreated ?? 1_700_000_000_000 + message.seq;
  db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(message.id, message.sessionId, message.type, message.seq, timeCreated, timeCreated, JSON.stringify(message.data));
}

export function insertOpenCodeCredential(
  db: Database.Database,
  credential: { id: string; integrationId: string | null; label: string; active?: number | null },
): void {
  db.prepare(`
    INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
    VALUES (?, ?, ?, '{"type":"api","key":"secret"}', ?, 1700000000000, 1700000000000)
  `).run(credential.id, credential.integrationId, credential.label, credential.active === undefined ? 1 : credential.active);
}
