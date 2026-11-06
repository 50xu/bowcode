import { Cron } from 'croner';

import { projectsDb, scheduleRunsDb, schedulesDb } from '@/modules/database/index.js';
import type { ScheduleRow, ScheduleRunRow } from '@/modules/database/index.js';
import { providerCapabilitiesService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type {
  LLMProvider,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduleWriteInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Shortest gap allowed between two fires of one cron schedule. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
/** How many consecutive fires are checked against the minimum interval. */
const INTERVAL_CHECK_FIRES = 24;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 200;
const MAX_DURATION_MINUTES_LIMIT = 24 * 60;
const DEFAULT_MAX_DURATION_MINUTES = 0;
/** Runs listed with a schedule's detail view. */
const RECENT_RUNS_LIMIT = 20;
/** Runs kept per schedule; this module's runner prunes older history after each run. */
export const SCHEDULE_RUN_HISTORY_LIMIT = 50;
const PREVIEW_FIRES = 5;

/** A schedule as the API returns it. */
export type Schedule = {
  id: string;
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
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  createdAt: string;
  updatedAt: string;
};

/** One run as the API returns it. */
export type ScheduleRun = {
  id: string;
  scheduleId: string;
  sessionId: string | null;
  trigger: ScheduleRunTrigger;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  error: string | null;
};

function invalid(message: string, code = 'INVALID_SCHEDULE'): AppError {
  return new AppError(message, { code, statusCode: 400 });
}

/** Whether `timeZone` is an IANA zone name this runtime knows. */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses a five-field cron expression in a time zone, or throws a 400.
 *
 * Six- and seven-field forms (seconds, years) are refused: the poll runs every
 * 30 seconds, and the minimum interval makes sub-minute fields meaningless.
 */
function parseCron(expression: string, timeZone: string): Cron {
  const trimmed = expression.trim();
  if (trimmed.split(/\s+/).length !== 5) {
    throw invalid('A cron expression needs exactly five fields: minute hour day-of-month month day-of-week.', 'INVALID_CRON');
  }
  if (!isValidTimeZone(timeZone)) {
    throw invalid(`"${timeZone}" is not a known time zone.`, 'INVALID_TIMEZONE');
  }
  try {
    return new Cron(trimmed, { timezone: timeZone, paused: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(`That cron expression is not valid: ${message}`, 'INVALID_CRON');
  }
}

/** Rejects expressions that would fire more often than every five minutes. */
function assertMinimumInterval(cron: Cron, from: Date): void {
  const fires = cron.nextRuns(INTERVAL_CHECK_FIRES, from);
  if (fires.length === 0) {
    throw invalid('That cron expression never fires.', 'INVALID_CRON');
  }
  for (let index = 1; index < fires.length; index += 1) {
    if (fires[index].getTime() - fires[index - 1].getTime() < MIN_INTERVAL_MS) {
      throw invalid('A schedule may run at most once every 5 minutes.', 'SCHEDULE_TOO_FREQUENT');
    }
  }
}

/**
 * The first fire of a schedule strictly after `after`, as a UTC ISO string,
 * or null when it has none left (a one-off whose time has passed).
 *
 * Used by the schedule scheduler's claim, which advances `next_run_at` past
 * `now` so fires missed while the server was down are not replayed.
 */
export function computeNextRunAt(
  schedule: Pick<ScheduleRow, 'kind' | 'cron_expression' | 'run_at' | 'timezone'>,
  after: Date,
): string | null {
  if (schedule.kind === 'once') {
    if (!schedule.run_at) return null;
    const runAt = new Date(schedule.run_at);
    return runAt.getTime() > after.getTime() ? runAt.toISOString() : null;
  }
  if (!schedule.cron_expression) return null;
  const next = new Cron(schedule.cron_expression, { timezone: schedule.timezone, paused: true }).nextRun(after);
  return next ? next.toISOString() : null;
}

/**
 * Tells every open chat socket that the schedules changed, so a schedules
 * panel reads its list again through the authenticated GET. The frame carries
 * no schedule data. Never throws.
 *
 * Used by this module's service (create, edit, pause, delete) and runner
 * (a run started or finished).
 */
export function announceSchedulesChanged(scheduleId: string | null = null): void {
  const frame = JSON.stringify({ kind: 'schedules_changed', scheduleId, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    try {
      client.send(frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Schedules] Failed to announce a change', { error: message });
    }
  });
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    projectPath: row.project_path,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    permissionMode: row.permission_mode,
    prompt: row.prompt,
    kind: row.kind,
    cronExpression: row.cron_expression,
    runAt: row.run_at,
    timezone: row.timezone,
    maxDurationMinutes: row.max_duration_minutes,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toScheduleRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    sessionId: row.session_id,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    error: row.error,
  };
}

/**
 * The permission modes a scheduled run may use for a provider: whatever the
 * capability matrix accepts, minus `plan` (a plan waits for approval nobody
 * is there to give).
 */
function allowedPermissionModes(provider: LLMProvider): string[] {
  return providerCapabilitiesService.getProviderCapabilities(provider).permissionModes
    .filter((mode) => mode !== 'plan');
}

/** `auto` when the provider supports it, otherwise the provider's own default. */
function defaultPermissionMode(provider: LLMProvider): string {
  const allowed = allowedPermissionModes(provider);
  if (allowed.includes('auto')) return 'auto';
  const providerDefault = providerCapabilitiesService.getProviderCapabilities(provider).defaultPermissionMode;
  return allowed.includes(providerDefault) ? providerDefault : allowed[0];
}

function resolveProjectPath(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError(`Project "${projectId}" was not found.`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  return projectPath;
}

function getOwnedSchedule(userId: number, id: string): ScheduleRow {
  const row = schedulesDb.getForUser(userId, id);
  if (!row) {
    throw new AppError('That schedule was not found.', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
  }
  return row;
}

/** The full set of columns a create or update writes, before persistence. */
type ResolvedSchedule = Parameters<typeof schedulesDb.update>[1];

/**
 * Validates a complete schedule definition and computes its next fire.
 *
 * `existing` supplies every field the input leaves out, so a PATCH is
 * validated as the schedule it would produce, not as a fragment.
 */
function resolveSchedule(input: ScheduleWriteInput, existing: ScheduleRow | null, now: Date): ResolvedSchedule {
  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw invalid('A schedule needs a name.');
  if (name.length > MAX_NAME_LENGTH) throw invalid('That name is too long.');

  const projectPath = input.projectId !== undefined
    ? resolveProjectPath(input.projectId)
    : existing?.project_path;
  if (!projectPath) throw invalid('A schedule needs a project.', 'PROJECT_REQUIRED');

  const provider = (input.provider ?? existing?.provider) as LLMProvider | undefined;
  if (!provider || !providerCapabilitiesService.getProviderCapabilities(provider)) {
    throw invalid('A schedule needs a supported provider.', 'UNSUPPORTED_PROVIDER');
  }

  const providerChanged = existing !== null && input.provider !== undefined && input.provider !== existing.provider;
  const permissionMode = input.permissionMode
    ?? (existing && !providerChanged ? existing.permission_mode : defaultPermissionMode(provider));
  if (!allowedPermissionModes(provider).includes(permissionMode)) {
    throw invalid(`Permission mode "${permissionMode}" cannot be used by a scheduled ${provider} run.`, 'INVALID_PERMISSION_MODE');
  }

  const model = (input.model !== undefined ? input.model : existing?.model ?? null)?.trim() || null;
  const effort = (input.effort !== undefined ? input.effort : existing?.effort ?? null)?.trim() || null;
  if (effort && effort !== 'default') {
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
    if (!capabilities.supportsEffort || !capabilities.effortLevels.includes(effort)) {
      throw invalid(`Effort "${effort}" is not available for ${provider}.`, 'INVALID_EFFORT');
    }
  }

  const prompt = (input.prompt ?? existing?.prompt ?? '').trim();
  if (!prompt) throw invalid('A schedule needs a prompt.', 'PROMPT_REQUIRED');
  if (prompt.length > MAX_PROMPT_LENGTH) throw invalid('That prompt is too long.', 'PROMPT_TOO_LONG');

  const kind = input.kind ?? existing?.kind;
  if (kind !== 'once' && kind !== 'cron') throw invalid('A schedule must be "once" or "cron".');

  const timezone = (input.timezone ?? existing?.timezone ?? 'UTC').trim();
  if (!isValidTimeZone(timezone)) throw invalid(`"${timezone}" is not a known time zone.`, 'INVALID_TIMEZONE');

  const maxDurationMinutes = input.maxDurationMinutes ?? existing?.max_duration_minutes ?? DEFAULT_MAX_DURATION_MINUTES;
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 0 || maxDurationMinutes > MAX_DURATION_MINUTES_LIMIT) {
    throw invalid(`The time limit must be between 0 (no limit) and ${MAX_DURATION_MINUTES_LIMIT} minutes.`, 'INVALID_MAX_DURATION');
  }

  const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);

  let cronExpression: string | null = null;
  let runAt: string | null = null;
  if (kind === 'cron') {
    cronExpression = (input.cronExpression !== undefined ? input.cronExpression : existing?.cron_expression ?? '')?.trim() ?? '';
    if (!cronExpression) throw invalid('A recurring schedule needs a cron expression.', 'INVALID_CRON');
    assertMinimumInterval(parseCron(cronExpression, timezone), now);
  } else {
    const rawRunAt = input.runAt !== undefined ? input.runAt : existing?.run_at ?? null;
    const parsed = rawRunAt ? new Date(rawRunAt) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw invalid('A one-off schedule needs a valid date and time.', 'INVALID_RUN_AT');
    }
    if (enabled && parsed.getTime() <= now.getTime()) {
      throw invalid('That time has already passed.', 'RUN_AT_IN_PAST');
    }
    runAt = parsed.toISOString();
  }

  const nextRunAt = enabled
    ? computeNextRunAt({ kind, cron_expression: cronExpression, run_at: runAt, timezone }, now)
    : null;

  return {
    name,
    projectPath,
    provider,
    model,
    effort,
    permissionMode,
    prompt,
    kind,
    cronExpression,
    runAt,
    timezone,
    maxDurationMinutes,
    enabled,
    nextRunAt,
  };
}

/** Used by the schedules routes for CRUD, preview and history reads. */
export const schedulesService = {
  list(userId: number, projectId?: string | null): Schedule[] {
    const projectPath = projectId ? resolveProjectPath(projectId) : null;
    return schedulesDb.listForUser(userId, projectPath).map(toSchedule);
  },

  get(userId: number, id: string): Schedule & { recentRuns: ScheduleRun[] } {
    const row = getOwnedSchedule(userId, id);
    return {
      ...toSchedule(row),
      recentRuns: scheduleRunsDb.listForSchedule(row.id, RECENT_RUNS_LIMIT).map(toScheduleRun),
    };
  },

  listRuns(userId: number, id: string): ScheduleRun[] {
    const row = getOwnedSchedule(userId, id);
    return scheduleRunsDb.listForSchedule(row.id, SCHEDULE_RUN_HISTORY_LIMIT).map(toScheduleRun);
  },

  create(userId: number, input: ScheduleWriteInput, now: Date = new Date()): Schedule {
    if (!input.projectId) throw invalid('A schedule needs a project.', 'PROJECT_REQUIRED');
    const resolved = resolveSchedule(input, null, now);
    const row = schedulesDb.create({ userId, ...resolved });
    announceSchedulesChanged(row.id);
    return toSchedule(row);
  },

  update(userId: number, id: string, input: ScheduleWriteInput, now: Date = new Date()): Schedule {
    const existing = getOwnedSchedule(userId, id);
    const resolved = resolveSchedule(input, existing, now);
    const row = schedulesDb.update(existing.id, resolved) as ScheduleRow;
    announceSchedulesChanged(row.id);
    return toSchedule(row);
  },

  pause(userId: number, id: string): Schedule {
    const existing = getOwnedSchedule(userId, id);
    schedulesDb.setEnabled(existing.id, false, null);
    announceSchedulesChanged(existing.id);
    return toSchedule(schedulesDb.getById(existing.id) as ScheduleRow);
  },

  /** Re-enables a schedule from now on; fires missed while paused are not replayed. */
  resume(userId: number, id: string, now: Date = new Date()): Schedule {
    const existing = getOwnedSchedule(userId, id);
    const nextRunAt = computeNextRunAt(existing, now);
    if (!nextRunAt) {
      throw new AppError('This one-off schedule\'s time has passed. Edit it to pick a new time.', {
        code: 'RUN_AT_IN_PAST',
        statusCode: 409,
      });
    }
    schedulesDb.setEnabled(existing.id, true, nextRunAt);
    announceSchedulesChanged(existing.id);
    return toSchedule(schedulesDb.getById(existing.id) as ScheduleRow);
  },

  delete(userId: number, id: string): void {
    if (!schedulesDb.delete(userId, id)) {
      throw new AppError('That schedule was not found.', { code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
    }
    announceSchedulesChanged(id);
  },

  /** The next five fires of a cron expression in a time zone, validated like a save would be. */
  preview(cronExpression: string, timeZone: string, now: Date = new Date()): string[] {
    const cron = parseCron(cronExpression, timeZone);
    assertMinimumInterval(cron, now);
    return cron.nextRuns(PREVIEW_FIRES, now).map((fire) => fire.toISOString());
  },
};
