import { scheduleRunsDb, schedulesDb, sessionsDb } from '@/modules/database/index.js';
import type { ScheduleRow } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  SCHEDULE_RUN_HISTORY_LIMIT,
  announceSchedulesChanged,
} from '@/modules/schedules/services/schedules.service.js';
import { broadcastSessionUpserted, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { LLMProvider, ScheduleRunStatus, ScheduleRunTrigger } from '@/shared/types.js';

/** How long a timed-out run's provider gets to wind down after the abort. */
const ABORT_GRACE_MS = 10_000;

/** One run the scheduler has decided to start. */
export type ScheduleRunJob = {
  schedule: ScheduleRow;
  trigger: ScheduleRunTrigger;
  /** The fire this run is for (UTC ISO), null for "Run now". */
  scheduledFor: string | null;
};

/** What a run needs from outside: the runtime gateway and, for tests, a shorter time limit. */
export type ScheduleRunDependencies = {
  runtime: ProviderRuntimeGateway;
  /** Overrides `max_duration_minutes`; tests use it to time out in milliseconds. */
  maxDurationMs?: number;
};

type TurnResult = Awaited<ReturnType<typeof runDetachedChatTurn>>;

/** Title of the session a run creates: "<schedule name> · YYYY-MM-DD HH:mm" in the schedule's zone. */
function buildSessionTitle(schedule: ScheduleRow, at: Date): string {
  let stamp: string;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: schedule.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    stamp = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  } catch {
    stamp = at.toISOString().slice(0, 16).replace('T', ' ');
  }
  return `${schedule.name} · ${stamp}`;
}

/** Maps a settled turn to the run's status and error text. */
function classifyTurn(result: TurnResult): { status: ScheduleRunStatus; error: string | null } {
  if (!result.started) {
    return { status: 'failed', error: result.error ?? 'The run could not start.' };
  }
  if (result.error) {
    return { status: 'failed', error: result.error };
  }
  const outcome = result.outcome;
  if (outcome?.aborted) {
    return { status: 'interrupted', error: 'The run was stopped before it finished.' };
  }
  if (outcome?.providerError) {
    return { status: 'failed', error: outcome.providerError };
  }
  if (outcome && outcome.exitCode !== 0) {
    return {
      status: 'failed',
      error: outcome.exitCode === null
        ? 'The run ended without reporting completion.'
        : `The run exited with code ${outcome.exitCode}.`,
    };
  }
  return { status: 'succeeded', error: null };
}

function settleRun(scheduleId: string, runId: string, status: ScheduleRunStatus, error: string | null, startedAt: string): void {
  scheduleRunsDb.finish(runId, status, error);
  schedulesDb.recordLastRun(scheduleId, status, startedAt);
  scheduleRunsDb.prune(scheduleId, SCHEDULE_RUN_HISTORY_LIMIT);
  announceSchedulesChanged(scheduleId);
}

/**
 * Records a fire that was not run, with the reason.
 *
 * Used by this module's scheduler for missed fires (server down), overlapping
 * fires of one schedule, and queued fires whose schedule was paused.
 */
export function recordSkippedRun(job: ScheduleRunJob, reason: string): void {
  const run = scheduleRunsDb.create({
    scheduleId: job.schedule.id,
    trigger: job.trigger,
    scheduledFor: job.scheduledFor,
    status: 'skipped',
    error: reason,
  });
  schedulesDb.recordLastRun(job.schedule.id, 'skipped', run.started_at);
  scheduleRunsDb.prune(job.schedule.id, SCHEDULE_RUN_HISTORY_LIMIT);
  announceSchedulesChanged(job.schedule.id);
}

/**
 * Executes one schedule run end to end and resolves with its final status.
 *
 * Every run starts a brand-new app session in the schedule's project, so the
 * user follows it like any other conversation and the run history links to
 * it. The turn runs detached (no browser attached) with `headless: true`, so
 * runtimes refuse to wait on interactive prompts. It is raced against the
 * schedule's time limit when one is configured; past it the provider run is
 * aborted the same way `chat.abort` does and the run is recorded as `timed_out`.
 *
 * Used by this module's scheduler, which owns concurrency (one run per
 * schedule, a global cap) and calls this once a slot is free. Never throws.
 */
export async function executeScheduleRun(job: ScheduleRunJob, dependencies: ScheduleRunDependencies): Promise<ScheduleRunStatus> {
  const { schedule } = job;
  const startedAtDate = new Date();
  const run = scheduleRunsDb.create({
    scheduleId: schedule.id,
    trigger: job.trigger,
    scheduledFor: job.scheduledFor,
    status: 'running',
    startedAt: startedAtDate,
  });
  schedulesDb.recordLastRun(schedule.id, 'running', run.started_at);
  announceSchedulesChanged(schedule.id);

  const provider = schedule.provider as LLMProvider;
  let sessionId: string;
  try {
    sessionId = sessionsService.createAppSession(provider, schedule.project_path, schedule.prompt, { autoTitle: false }).sessionId;
    sessionsDb.updateSessionCustomName(sessionId, buildSessionTitle(schedule, startedAtDate));
    scheduleRunsDb.attachSession(run.id, sessionId);
    // Puts the new session in every open sidebar now, rather than when the
    // provider first announces its own id.
    void broadcastSessionUpserted(sessionId).catch(() => { /* the provider's own announcement follows */ });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settleRun(schedule.id, run.id, 'failed', `Could not create the session: ${message}`, run.started_at);
    return 'failed';
  }

  const configuredMaxDurationMs = dependencies.maxDurationMs ?? schedule.max_duration_minutes * 60_000;
  const maxDurationMs: number | null = configuredMaxDurationMs === 0 ? null : configuredMaxDurationMs;
  const turn: Promise<{ kind: 'settled'; result: TurnResult } | { kind: 'threw'; error: string }> = runDetachedChatTurn(
    {
      sessionId,
      userId: schedule.user_id,
      content: schedule.prompt,
      options: {
        ...(schedule.model ? { model: schedule.model } : {}),
        ...(schedule.effort ? { effort: schedule.effort } : {}),
        permissionMode: schedule.permission_mode,
        headless: true,
      },
    },
    { runtime: dependencies.runtime },
  ).then(
    (result) => ({ kind: 'settled' as const, result }),
    (error: unknown) => ({ kind: 'threw' as const, error: error instanceof Error ? error.message : String(error) }),
  );

  let first: Awaited<typeof turn> | { kind: 'timeout'; maxDurationMs: number };
  if (maxDurationMs === null) {
    first = await turn;
  } else {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ kind: 'timeout'; maxDurationMs: number }>((resolve) => {
      // Deliberately not unref'd: it is cleared as soon as the turn settles, and
      // an unref'd timer as the only pending work lets Node 22 treat the event
      // loop as idle while the turn is still being awaited.
      timer = setTimeout(() => resolve({ kind: 'timeout', maxDurationMs }), maxDurationMs);
    });
    first = await Promise.race([turn, timeout]);
    if (timer) clearTimeout(timer);
  }

  if (first.kind === 'timeout') {
    try {
      const aborted = await dependencies.runtime.abort(provider, sessionId);
      // Same as `chat.abort`: emit the terminal complete on the run's behalf
      // so every watching client sees it end.
      chatRunRegistry.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Schedules] Could not abort a timed-out run', { scheduleId: schedule.id, sessionId, error: message });
    }
    // Give the provider a moment to wind down; never wait on it indefinitely.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([turn, new Promise((resolve) => { graceTimer = setTimeout(resolve, ABORT_GRACE_MS); })]);
    if (graceTimer) clearTimeout(graceTimer);
    const minutes = Math.round(first.maxDurationMs / 60_000);
    settleRun(
      schedule.id,
      run.id,
      'timed_out',
      `The run passed its ${minutes > 0 ? `${minutes}-minute` : 'time'} limit and was stopped.`,
      run.started_at,
    );
    return 'timed_out';
  }

  const { status, error } = first.kind === 'threw'
    ? { status: 'failed' as const, error: first.error }
    : classifyTurn(first.result);
  settleRun(schedule.id, run.id, status, error, run.started_at);
  return status;
}
