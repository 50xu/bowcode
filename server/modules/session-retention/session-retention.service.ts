import type { SessionRetentionAction, SessionRetentionSettings } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** `app_config` key holding the settings document. */
const SETTINGS_CONFIG_KEY = 'session_retention_settings';
/** `app_config` key holding the outcome of the most recent pass. */
const LAST_RUN_CONFIG_KEY = 'session_retention_last_run';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Most sessions one pass archives or deletes.
 *
 * A first pass over a long history could otherwise remove thousands of
 * transcripts in one go, holding the event loop on synchronous SQLite writes
 * and file unlinks. Anything left over is picked up by the next pass.
 */
const BATCH_LIMIT = 100;

/** How many of the matching sessions a preview lists by name. */
const PREVIEW_SAMPLE_SIZE = 20;

/** Time between background passes. Inactivity is measured in days, so hourly is plenty. */
const PASS_INTERVAL_MS = 60 * 60 * 1000;

/** Off until the user opts in: nothing is ever archived or deleted by default. */
const DEFAULT_SETTINGS: SessionRetentionSettings = {
  enabled: false,
  inactiveDays: 30,
  action: 'archive',
  skipStarredProjects: true,
  autoTitleSessions: true,
};

/** One session the cleanup selected, as the preview lists it. */
type RetentionCandidate = {
  sessionId: string;
  provider: string;
  title: string;
  projectPath: string | null;
  projectName: string | null;
  isArchived: boolean;
  lastActivity: string;
};

type InactiveSessionQuery = {
  cutoff: Date;
  includeArchived: boolean;
  skipStarredProjects: boolean;
  excludeSessionIds: readonly string[];
  limit: number;
};

type RetentionRunTrigger = 'scheduled' | 'manual';

type RetentionRunResult = {
  trigger: RetentionRunTrigger;
  action: SessionRetentionAction;
  inactiveDays: number;
  cutoff: string;
  startedAt: string;
  finishedAt: string;
  archived: number;
  deleted: number;
  /** Deleted sessions whose transcript file(s) were actually removed from disk. */
  deletedFromDisk: number;
  /** Selected sessions that started running between selection and action. */
  skippedBusy: number;
  failed: number;
  /** Matching sessions left for later passes (batch limit or failures). */
  remaining: number;
};

type SessionRetentionDependencies = {
  /** Key-value persistence (the `app_config` table). */
  config: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  findInactiveSessions(query: InactiveSessionQuery): { sessions: RetentionCandidate[]; total: number };
  /** Every session with a run, background work or an external CLI holder right now. */
  listBusySessionIds(): Promise<string[]>;
  /** Cheap re-check made immediately before acting on one session. */
  isSessionBusy(sessionId: string): boolean;
  /** Must be the same code path as the sidebar's Archive action. */
  archiveSession(sessionId: string): Promise<void>;
  /** Must be the same code path as the sidebar's permanent delete. */
  deleteSession(sessionId: string): Promise<{ deletedFromDisk: boolean }>;
  announceSessionsRemoved(sessionIds: string[], action: 'archived' | 'deleted'): void;
  now?(): Date;
  logError?(message: string, details: Record<string, unknown>): void;
};

function readJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Merges a stored document over the defaults field by field, so a corrupted
 * or partially written value can only ever fall back to "disabled", never
 * enable deletion by accident.
 */
function normalizeStoredSettings(stored: Record<string, unknown> | null): SessionRetentionSettings {
  if (!stored) {
    return { ...DEFAULT_SETTINGS };
  }
  const inactiveDays = stored.inactiveDays;
  return {
    enabled: stored.enabled === true,
    inactiveDays: Number.isInteger(inactiveDays) && (inactiveDays as number) >= 1 && (inactiveDays as number) <= 3650
      ? inactiveDays as number
      : DEFAULT_SETTINGS.inactiveDays,
    action: stored.action === 'delete' ? 'delete' : 'archive',
    skipStarredProjects: stored.skipStarredProjects !== false,
    autoTitleSessions: stored.autoTitleSessions !== false,
  };
}

/**
 * Creates the inactive-session cleanup with its persistence and the existing
 * session archive/delete paths injected.
 *
 * Used by this module's composition root (`session-retention.module.ts`).
 */
export function createSessionRetentionService(dependencies: SessionRetentionDependencies) {
  const now = () => dependencies.now?.() ?? new Date();
  const logError = dependencies.logError ?? ((message, details) => console.error(message, details));
  let passInFlight = false;
  let passTimer: ReturnType<typeof setInterval> | null = null;

  const getSettings = (): SessionRetentionSettings =>
    normalizeStoredSettings(readJsonRecord(dependencies.config.get(SETTINGS_CONFIG_KEY)));

  const getLastRun = (): RetentionRunResult | null =>
    readJsonRecord(dependencies.config.get(LAST_RUN_CONFIG_KEY)) as RetentionRunResult | null;

  const cutoffFor = (settings: SessionRetentionSettings): Date =>
    new Date(now().getTime() - settings.inactiveDays * DAY_MS);

  // Archive never revisits an archived session. Delete does: archiving is the
  // usual first step, and an archived session past the threshold is exactly
  // what a "delete old sessions" setting is expected to clear.
  const queryFor = (
    settings: SessionRetentionSettings,
    busySessionIds: readonly string[],
    limit: number,
  ): InactiveSessionQuery => ({
    cutoff: cutoffFor(settings),
    includeArchived: settings.action === 'delete',
    skipStarredProjects: settings.skipStarredProjects,
    excludeSessionIds: busySessionIds,
    limit,
  });

  async function executePass(trigger: RetentionRunTrigger): Promise<RetentionRunResult | null> {
    const settings = getSettings();
    // The background pass is a no-op while disabled. A manual "Run now" is an
    // explicit request and runs with the saved threshold and action either way.
    if (trigger === 'scheduled' && !settings.enabled) {
      return null;
    }

    const startedAt = now().toISOString();
    const busySessionIds = await dependencies.listBusySessionIds();
    const query = queryFor(settings, busySessionIds, BATCH_LIMIT);
    const { sessions, total } = dependencies.findInactiveSessions(query);

    const removedSessionIds: string[] = [];
    let deletedFromDisk = 0;
    let skippedBusy = 0;
    let failed = 0;

    for (const candidate of sessions) {
      // A run may have started on this session after the busy list was read.
      if (dependencies.isSessionBusy(candidate.sessionId)) {
        skippedBusy += 1;
        continue;
      }
      try {
        if (settings.action === 'archive') {
          await dependencies.archiveSession(candidate.sessionId);
        } else {
          const result = await dependencies.deleteSession(candidate.sessionId);
          if (result.deletedFromDisk) {
            deletedFromDisk += 1;
          }
        }
        removedSessionIds.push(candidate.sessionId);
      } catch (error) {
        failed += 1;
        logError('[SessionRetention] Could not clean up session', {
          sessionId: candidate.sessionId,
          action: settings.action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const removedAction = settings.action === 'archive' ? 'archived' : 'deleted';
    if (removedSessionIds.length > 0) {
      dependencies.announceSessionsRemoved(removedSessionIds, removedAction);
    }

    const result: RetentionRunResult = {
      trigger,
      action: settings.action,
      inactiveDays: settings.inactiveDays,
      cutoff: query.cutoff.toISOString(),
      startedAt,
      finishedAt: now().toISOString(),
      archived: settings.action === 'archive' ? removedSessionIds.length : 0,
      deleted: settings.action === 'delete' ? removedSessionIds.length : 0,
      deletedFromDisk,
      skippedBusy,
      failed,
      remaining: Math.max(0, total - removedSessionIds.length),
    };
    dependencies.config.set(LAST_RUN_CONFIG_KEY, JSON.stringify(result));
    return result;
  }

  /** Runs one pass unless another is already running; `null` when skipped. */
  async function runGuardedPass(trigger: RetentionRunTrigger): Promise<RetentionRunResult | null> {
    if (passInFlight) {
      if (trigger === 'manual') {
        throw new AppError('A cleanup pass is already running.', {
          code: 'SESSION_RETENTION_IN_PROGRESS',
          statusCode: 409,
        });
      }
      return null;
    }
    passInFlight = true;
    try {
      return await executePass(trigger);
    } finally {
      passInFlight = false;
    }
  }

  return {
    /** Current settings plus the outcome of the last pass, for the settings screen. */
    getStatus() {
      return { settings: getSettings(), lastRun: getLastRun() };
    },

    /** Applies an already-validated partial update and persists the merged document. */
    updateSettings(patch: Partial<SessionRetentionSettings>) {
      const settings = normalizeStoredSettings({ ...getSettings(), ...patch });
      dependencies.config.set(SETTINGS_CONFIG_KEY, JSON.stringify(settings));
      return { settings, lastRun: getLastRun() };
    },

    /**
     * Reports what a pass with the saved settings would select right now:
     * the full count and the oldest few by name. Busy sessions are left out the
     * same way a pass leaves them out.
     */
    async preview() {
      const settings = getSettings();
      const busySessionIds = await dependencies.listBusySessionIds();
      const query = queryFor(settings, busySessionIds, PREVIEW_SAMPLE_SIZE);
      const { sessions, total } = dependencies.findInactiveSessions(query);
      return {
        settings,
        cutoff: query.cutoff.toISOString(),
        total,
        batchLimit: BATCH_LIMIT,
        sessions,
      };
    },

    /** One pass on demand, regardless of `enabled`. */
    async runNow(): Promise<RetentionRunResult> {
      // Manual runs never return null: they are not gated on `enabled` and a
      // concurrent pass throws instead of skipping.
      return (await runGuardedPass('manual')) as RetentionRunResult;
    },

    /** One background pass; a no-op while disabled or while another pass runs. */
    runScheduledPass(): Promise<RetentionRunResult | null> {
      return runGuardedPass('scheduled');
    },

    /** Starts the hourly background pass and runs the first one immediately. */
    start(): void {
      if (passTimer) {
        return;
      }
      const tick = () => {
        void runGuardedPass('scheduled').catch((error: unknown) => {
          logError('[SessionRetention] Cleanup pass failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      passTimer = setInterval(tick, PASS_INTERVAL_MS);
      // Never keep the process alive just for cleanup.
      passTimer.unref?.();
      tick();
    },

    stop(): void {
      if (passTimer) {
        clearInterval(passTimer);
        passTimer = null;
      }
    },
  };
}
