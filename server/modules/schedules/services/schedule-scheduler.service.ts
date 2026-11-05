import { scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import {
  executeScheduleRun,
  recordSkippedRun,
} from '@/modules/schedules/services/schedule-runner.service.js';
import type { ScheduleRunDependencies, ScheduleRunJob } from '@/modules/schedules/services/schedule-runner.service.js';
import { announceSchedulesChanged, computeNextRunAt } from '@/modules/schedules/services/schedules.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

/** How often due schedules are looked for. Cron's granularity is a minute. */
const POLL_INTERVAL_MS = 30_000;
/**
 * A claimed fire later than this is treated as missed (the server was down or
 * asleep) and recorded as skipped instead of run: schedules do not catch up.
 */
const STALE_FIRE_MS = 2 * POLL_INTERVAL_MS;
/** Most schedule runs going at once across all schedules; further fires queue. */
const MAX_CONCURRENT_RUNS = 3;

const MISSED_FIRE_REASON = 'Missed: Bowcode was not running when this was due.';
const OVERLAP_REASON = 'Skipped: the previous run of this schedule was still in progress.';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let schedulerRuntime: ProviderRuntimeGateway | null = null;

/** Schedules with a run going right now; one run per schedule at a time. */
const activeScheduleIds = new Set<string>();
/** Fires waiting for a free slot under the global cap, oldest first. */
const pendingJobs: Array<{ job: ScheduleRunJob; dependencies: ScheduleRunDependencies }> = [];
/** Every run started and not yet settled, so a test (or shutdown) can wait for them. */
const inFlightRuns = new Set<Promise<unknown>>();

function isScheduleBusy(scheduleId: string): boolean {
  return activeScheduleIds.has(scheduleId) || pendingJobs.some((pending) => pending.job.schedule.id === scheduleId);
}

/** Starts queued runs while there is room under the global cap. */
function pumpQueue(): void {
  while (activeScheduleIds.size < MAX_CONCURRENT_RUNS && pendingJobs.length > 0) {
    const { job, dependencies } = pendingJobs.shift()!;
    // Read again: the schedule may have been edited, paused or deleted while it waited.
    const current = schedulesDb.getById(job.schedule.id);
    if (!current) continue;
    if (job.trigger === 'scheduled' && current.enabled !== 1) {
      recordSkippedRun({ ...job, schedule: current }, 'Skipped: the schedule was paused before this run could start.');
      continue;
    }

    activeScheduleIds.add(current.id);
    const running = executeScheduleRun({ ...job, schedule: current }, dependencies)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Schedules] Run failed unexpectedly', { scheduleId: current.id, error: message });
      })
      .finally(() => {
        activeScheduleIds.delete(current.id);
        inFlightRuns.delete(running);
        pumpQueue();
      });
    inFlightRuns.add(running);
  }
}

/**
 * Queues one run, or records it as skipped when the same schedule already has
 * one going or waiting. Returns whether it was queued.
 */
function enqueueRun(job: ScheduleRunJob, dependencies: ScheduleRunDependencies): boolean {
  if (isScheduleBusy(job.schedule.id)) {
    recordSkippedRun(job, OVERLAP_REASON);
    return false;
  }
  pendingJobs.push({ job, dependencies });
  pumpQueue();
  return true;
}

/**
 * Claims every due schedule and starts (or queues) its run. Runs are not
 * awaited, so different schedules run concurrently and a long run never
 * delays the next poll.
 *
 * Exported so a test can drive one pass without the timer; the returned
 * counts describe what this pass did with the fires it claimed.
 */
export function dispatchDueSchedules(
  dependencies: ScheduleRunDependencies,
  now: Date = new Date(),
): { claimed: number; started: number; skipped: number } {
  const claimed = schedulesDb.claimDue(now, computeNextRunAt);
  let started = 0;
  let skipped = 0;
  for (const fire of claimed) {
    const job: ScheduleRunJob = { schedule: fire.schedule, trigger: 'scheduled', scheduledFor: fire.firedAt };
    if (now.getTime() - new Date(fire.firedAt).getTime() > STALE_FIRE_MS) {
      recordSkippedRun(job, MISSED_FIRE_REASON);
      skipped += 1;
      continue;
    }
    if (enqueueRun(job, dependencies)) {
      started += 1;
    } else {
      skipped += 1;
    }
  }
  if (claimed.length > 0 && skipped === claimed.length) {
    // Advancing next_run_at is itself a change the list shows.
    announceSchedulesChanged();
  }
  return { claimed: claimed.length, started, skipped };
}

/**
 * Starts a run now on the user's request, without moving `next_run_at`.
 *
 * Used by the schedules routes (`POST /:id/run-now`). Refuses with 409 while
 * the schedule already has a run going, and 503 before the scheduler started.
 */
export function triggerScheduleRunNow(userId: number, scheduleId: string): void {
  const schedule = schedulesDb.getForUser(userId, scheduleId);
  if (!schedule) {
    throw new AppError('That schedule was not found.', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
  }
  if (!schedulerRuntime) {
    throw new AppError('Schedules are not running yet.', { code: 'SCHEDULER_NOT_READY', statusCode: 503 });
  }
  if (isScheduleBusy(schedule.id)) {
    throw new AppError('This schedule is already running.', { code: 'SCHEDULE_ALREADY_RUNNING', statusCode: 409 });
  }
  enqueueRun({ schedule, trigger: 'manual', scheduledFor: null }, { runtime: schedulerRuntime });
}

/**
 * Resolves once every run started so far has settled. Used by this module's
 * tests to wait for runs a dispatch pass started in the background.
 */
export async function waitForScheduleRunsToSettle(): Promise<void> {
  while (inFlightRuns.size > 0 || pendingJobs.length > 0) {
    await Promise.allSettled([...inFlightRuns]);
  }
}

/**
 * Marks runs a previous process left `running` as interrupted. No run
 * survives a restart. Exported for this module's tests; called by
 * `initializeScheduleScheduler`.
 */
export function markInterruptedRunsOnStartup(): number {
  const scheduleIds = scheduleRunsDb.markRunningAsInterrupted('Interrupted: Bowcode stopped while this run was going.');
  for (const scheduleId of scheduleIds) {
    const schedule = schedulesDb.getById(scheduleId);
    if (schedule?.last_status === 'running') {
      schedulesDb.recordLastRun(scheduleId, 'interrupted', schedule.last_run_at ?? new Date().toISOString());
    }
  }
  return scheduleIds.length;
}

/**
 * Starts the schedule poll. Used by the server entrypoint at startup.
 *
 * The database is the source of truth: on start, runs cut off by the last
 * shutdown are marked interrupted, and the first poll records fires missed
 * while the server was down as skipped (no catch-up) and moves each schedule
 * on to its next future fire.
 */
export function initializeScheduleScheduler(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) return;
  schedulerRuntime = runtime;

  try {
    markInterruptedRunsOnStartup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Schedules] Could not mark interrupted runs', { error: message });
  }

  const poll = () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      dispatchDueSchedules({ runtime });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Schedules] Dispatch pass failed', { error: message });
    } finally {
      pollInFlight = false;
    }
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for schedules.
  pollTimer.unref?.();
  poll();
}

/** Stops the schedule poll. Used by the server entrypoint at shutdown; runs in progress are left to finish. */
export function closeScheduleScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  schedulerRuntime = null;
}
