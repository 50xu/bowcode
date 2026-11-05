import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ScheduleKind, ScheduleRunStatus } from '@/shared/types.js';

/** One row of the `schedules` table, as stored. */
export type ScheduleRow = {
  id: string;
  user_id: number;
  name: string;
  project_path: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permission_mode: string;
  prompt: string;
  kind: ScheduleKind;
  cron_expression: string | null;
  run_at: string | null;
  timezone: string;
  max_duration_minutes: number;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: ScheduleRunStatus | null;
  created_at: string;
  updated_at: string;
};

/** A schedule the poll claimed, with the fire time it was claimed for. */
export type ClaimedScheduleFire = {
  schedule: ScheduleRow;
  /** The `next_run_at` the row had when it was claimed (UTC ISO). */
  firedAt: string;
};

/** The columns a create writes; `next_run_at` is computed by the caller. */
type ScheduleInsert = {
  userId: number;
  name: string;
  projectPath: string;
  provider: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  prompt: string;
  kind: ScheduleKind;
  cronExpression: string | null;
  runAt: string | null;
  timezone: string;
  maxDurationMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
};

const COLUMNS = `id, user_id, name, project_path, provider, model, effort, permission_mode, prompt, kind,
  cron_expression, run_at, timezone, max_duration_minutes, enabled, next_run_at, last_run_at, last_status,
  created_at, updated_at`;

/** Used by the schedules module to persist recurring and one-off prompt schedules. */
export const schedulesDb = {
  create(input: ScheduleInsert): ScheduleRow {
    const db = getConnection();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO schedules (id, user_id, name, project_path, provider, model, effort, permission_mode, prompt,
         kind, cron_expression, run_at, timezone, max_duration_minutes, enabled, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.userId,
      input.name,
      input.projectPath,
      input.provider,
      input.model,
      input.effort,
      input.permissionMode,
      input.prompt,
      input.kind,
      input.cronExpression,
      input.runAt,
      input.timezone,
      input.maxDurationMinutes,
      input.enabled ? 1 : 0,
      input.nextRunAt,
    );
    return schedulesDb.getById(id) as ScheduleRow;
  },

  getById(id: string): ScheduleRow | null {
    return (getConnection().prepare(`SELECT ${COLUMNS} FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined)
      ?? null;
  },

  /** A schedule only when it belongs to this user. */
  getForUser(userId: number, id: string): ScheduleRow | null {
    return (getConnection()
      .prepare(`SELECT ${COLUMNS} FROM schedules WHERE id = ? AND user_id = ?`)
      .get(id, userId) as ScheduleRow | undefined) ?? null;
  },

  /** The user's schedules, optionally limited to one project path, oldest first. */
  listForUser(userId: number, projectPath?: string | null): ScheduleRow[] {
    const db = getConnection();
    if (projectPath) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM schedules WHERE user_id = ? AND project_path = ? ORDER BY created_at ASC, id ASC`)
        .all(userId, projectPath) as ScheduleRow[];
    }
    return db
      .prepare(`SELECT ${COLUMNS} FROM schedules WHERE user_id = ? ORDER BY created_at ASC, id ASC`)
      .all(userId) as ScheduleRow[];
  },

  /** Rewrites every user-editable column of one schedule. */
  update(id: string, input: Omit<ScheduleInsert, 'userId'>): ScheduleRow | null {
    getConnection().prepare(
      `UPDATE schedules SET name = ?, project_path = ?, provider = ?, model = ?, effort = ?, permission_mode = ?,
         prompt = ?, kind = ?, cron_expression = ?, run_at = ?, timezone = ?, max_duration_minutes = ?, enabled = ?,
         next_run_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      input.name,
      input.projectPath,
      input.provider,
      input.model,
      input.effort,
      input.permissionMode,
      input.prompt,
      input.kind,
      input.cronExpression,
      input.runAt,
      input.timezone,
      input.maxDurationMinutes,
      input.enabled ? 1 : 0,
      input.nextRunAt,
      id,
    );
    return schedulesDb.getById(id);
  },

  /** Pauses or resumes a schedule, recording the next fire it should wait for. */
  setEnabled(id: string, enabled: boolean, nextRunAt: string | null): void {
    getConnection()
      .prepare('UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(enabled ? 1 : 0, nextRunAt, id);
  },

  /** Deletes one of the user's schedules with its run history. Returns false when it was not theirs. */
  delete(userId: number, id: string): boolean {
    const db = getConnection();
    return db.transaction(() => {
      // Explicit, so history goes even on a connection without foreign keys on.
      db.prepare('DELETE FROM schedule_runs WHERE schedule_id IN (SELECT id FROM schedules WHERE id = ? AND user_id = ?)')
        .run(id, userId);
      return db.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    })();
  },

  /**
   * Claims every enabled schedule whose `next_run_at` has passed, advancing
   * each to its next fire in the same transaction.
   *
   * Advancing inside the claim is what stops two overlapping polls (or a slow
   * run) from firing the same occurrence twice. `computeNextRunAt` returns the
   * first fire strictly after `now`, so occurrences missed while the server
   * was down collapse into one claim instead of a burst; null ends the
   * schedule (a one-off), which is then disabled.
   */
  claimDue(now: Date, computeNextRunAt: (schedule: ScheduleRow, after: Date) => string | null): ClaimedScheduleFire[] {
    const db = getConnection();
    const nowIso = now.toISOString();

    return db.transaction(() => {
      const due = db
        .prepare(
          `SELECT ${COLUMNS} FROM schedules
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at ASC`
        )
        .all(nowIso) as ScheduleRow[];

      const claimed: ClaimedScheduleFire[] = [];
      for (const schedule of due) {
        let nextRunAt: string | null = null;
        try {
          nextRunAt = computeNextRunAt(schedule, now);
        } catch {
          // A row whose expression no longer parses must not be claimed
          // forever; it is fired this once and then waits for an edit.
          nextRunAt = null;
        }
        db.prepare(
          `UPDATE schedules
           SET next_run_at = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(nextRunAt, nextRunAt ? 1 : 0, schedule.id);
        claimed.push({ schedule, firedAt: schedule.next_run_at as string });
      }
      return claimed;
    })();
  },

  /** Records how the latest run of a schedule went, for the list view. */
  recordLastRun(id: string, status: ScheduleRunStatus, at: string): void {
    getConnection()
      .prepare('UPDATE schedules SET last_run_at = ?, last_status = ? WHERE id = ?')
      .run(at, status, id);
  },
};
