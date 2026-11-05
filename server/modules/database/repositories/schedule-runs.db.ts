import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ScheduleRunStatus, ScheduleRunTrigger } from '@/shared/types.js';

/** One row of the `schedule_runs` table, as stored. */
export type ScheduleRunRow = {
  id: string;
  schedule_id: string;
  session_id: string | null;
  trigger: ScheduleRunTrigger;
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  status: ScheduleRunStatus;
  error: string | null;
};

const COLUMNS = 'id, schedule_id, session_id, trigger, scheduled_for, started_at, finished_at, status, error';

/** Longest error kept on a run; provider errors can carry whole stack traces. */
const MAX_ERROR_LENGTH = 2000;

/** Used by the schedules module to keep each schedule's run history. */
export const scheduleRunsDb = {
  /**
   * Inserts one run. A run created as `skipped` is finished on insert, since
   * nothing ran.
   */
  create(input: {
    scheduleId: string;
    trigger: ScheduleRunTrigger;
    scheduledFor: string | null;
    status: ScheduleRunStatus;
    error?: string | null;
    startedAt?: Date;
  }): ScheduleRunRow {
    const db = getConnection();
    const id = randomUUID();
    const startedAt = (input.startedAt ?? new Date()).toISOString();
    const finishedAt = input.status === 'running' ? null : startedAt;
    db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, session_id, trigger, scheduled_for, started_at, finished_at, status, error)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.scheduleId,
      input.trigger,
      input.scheduledFor,
      startedAt,
      finishedAt,
      input.status,
      input.error ? input.error.slice(0, MAX_ERROR_LENGTH) : null,
    );
    return scheduleRunsDb.getById(id) as ScheduleRunRow;
  },

  getById(id: string): ScheduleRunRow | null {
    return (getConnection().prepare(`SELECT ${COLUMNS} FROM schedule_runs WHERE id = ?`).get(id) as ScheduleRunRow | undefined)
      ?? null;
  },

  /** Links a run to the session it created. */
  attachSession(id: string, sessionId: string): void {
    getConnection().prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(sessionId, id);
  },

  /** Settles a running run. A run that already settled is left alone. */
  finish(id: string, status: ScheduleRunStatus, error: string | null, finishedAt: Date = new Date()): void {
    getConnection()
      .prepare(
        `UPDATE schedule_runs SET status = ?, error = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(status, error ? error.slice(0, MAX_ERROR_LENGTH) : null, finishedAt.toISOString(), id);
  },

  /** Newest first. */
  listForSchedule(scheduleId: string, limit: number): ScheduleRunRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM schedule_runs WHERE schedule_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(scheduleId, limit) as ScheduleRunRow[];
  },

  /** Drops all but the newest `keep` runs of a schedule. */
  prune(scheduleId: string, keep: number): void {
    getConnection()
      .prepare(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?
         )`
      )
      .run(scheduleId, scheduleId, keep);
  },

  /**
   * Marks every run still recorded as `running` as `interrupted`.
   *
   * Called once at startup: no run survives a server restart, so anything
   * still `running` was cut off when the previous process stopped. Returns
   * the affected schedule ids so their `last_status` can follow.
   */
  markRunningAsInterrupted(reason: string, at: Date = new Date()): string[] {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db
        .prepare(`SELECT DISTINCT schedule_id FROM schedule_runs WHERE status = 'running'`)
        .all() as Array<{ schedule_id: string }>;
      db.prepare(
        `UPDATE schedule_runs SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'running'`
      ).run(reason, at.toISOString());
      return rows.map((row) => row.schedule_id);
    })();
  },
};
