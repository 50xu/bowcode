import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
  background?: unknown;
  tasks?: unknown;
  externallyHeld?: unknown;
  pid?: unknown;
  processing?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
  /** Called right before a take-over send: stop treating the session as held by its old CLI process. */
  markSessionTakenOver: (sessionId: string) => void;
};

/**
 * A take-over kills the external CLI on the server, but the 5s running-sessions
 * poll can still report it for a moment. During this grace window those stale
 * external entries are ignored, so the composer is not re-locked and the
 * external-refresh path does not overwrite the reply that is now streaming.
 */
const TAKE_OVER_GRACE_MS = 20_000;

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const ExternalHoldersContext = createContext<ReadonlyMap<string, number | undefined> | null>(null);

/**
 * The set of session ids whose activity passes `include`, with a stable
 * identity while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useSessionIdSet(
  processingSessions: SessionActivityMap,
  include: (activity: SessionActivity) => boolean,
): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions]
    .filter(([, activity]) => include(activity))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const isAnyActivity = () => true;
const isBackgroundOnly = (activity: SessionActivity) => Boolean(activity.background);

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The poll's task list, kept only when every entry has the shape the indicator reads. */
const parseBackgroundTasks = (value: unknown): BackgroundTaskSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: BackgroundTaskSummary[] = [];
  for (const item of value) {
    const task = item as Partial<Record<keyof BackgroundTaskSummary, unknown>> | null;
    if (
      !task
      || typeof task.taskId !== 'string'
      || typeof task.toolUseId !== 'string'
      || typeof task.taskType !== 'string'
      || typeof task.description !== 'string'
      || typeof task.startedAt !== 'number'
    ) {
      // One entry the server wrote in a shape this client does not read
      // should not hide the rest of the session's work.
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      taskType: task.taskType,
      description: task.description,
      ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
      startedAt: task.startedAt,
      ...(task.nested === true ? { nested: true } : {}),
    });
  }
  return tasks;
};

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response or running background tasks — so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  } = useSessionProtection();

  // Kept separate from processing activity so an idle CLI holder never lights a spinner.
  const [externalHolders, setExternalHolders] = useState<ReadonlyMap<string, number | undefined>>(() => new Map());
  const takenOverUntilRef = useRef(new Map<string, number>());

  const isInTakeOverGrace = useCallback((sessionId: string) => {
    const until = takenOverUntilRef.current.get(sessionId);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    takenOverUntilRef.current.delete(sessionId);
    return false;
  }, []);

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      const holders = new Map<string, number | undefined>();
      for (const session of sessions) {
        if (typeof session.sessionId === 'string' && session.externallyHeld === true
          && !isInTakeOverGrace(session.sessionId)) {
          holders.set(session.sessionId, typeof session.pid === 'number' ? session.pid : undefined);
        }
      }
      // A fresh poll also clears websocket-only refusals when no holder remains.
      setExternalHolders(holders);

      syncProcessingSessions(
        sessions
          .filter((session) => session.processing !== false)
          // A just-taken-over session keeps its own run's entry but drops the
          // stale "running in the Claude CLI" one.
          .filter((session) => !(typeof session.sessionId === 'string'
            && session.externallyHeld === true
            && session.canInterrupt === false
            && isInTakeOverGrace(session.sessionId)))
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              background: session.background === true,
              tasks: parseBackgroundTasks(session.tasks),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [isInTakeOverGrace, syncProcessingSessions]);

  const markSessionTakenOver = useCallback((sessionId: string) => {
    takenOverUntilRef.current.set(sessionId, Date.now() + TAKE_OVER_GRACE_MS);
    setExternalHolders((previous) => {
      if (!previous.has(sessionId)) return previous;
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
    // Drop the external CLI's "processing" entry; the take-over send marks this
    // server's own run as processing right after.
    if (getSessionActivity(sessionId)?.canInterrupt === false) {
      markSessionIdle(sessionId);
    }
  }, [getSessionActivity, markSessionIdle]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
      markSessionTakenOver,
    }),
    [
      getSessionActivity,
      markSessionTakenOver,
      isSessionProcessing,
      markSessionBackground,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useSessionIdSet(processingSessions, isAnyActivity);
  const backgroundSessionIds = useSessionIdSet(processingSessions, isBackgroundOnly);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <ExternalHoldersContext.Provider value={externalHolders}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <BackgroundSessionIdsContext.Provider value={backgroundSessionIds}>
          <SessionProtectionStateContext.Provider value={processingSessions}>
            {children}
          </SessionProtectionStateContext.Provider>
        </BackgroundSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
      </ExternalHoldersContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the busy sessions, background work included. Prefer
 * this over useProcessingSessions wherever the activity details are not
 * rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * The busy sessions that are only running background tasks — no response in
 * flight. A subset of useBusySessionIdSet, with the same stable identity, for
 * the sidebar to draw those rows differently.
 */
export function useBackgroundSessionIdSet(): ReadonlySet<string> {
  const backgroundSessionIds = useContext(BackgroundSessionIdsContext);
  if (!backgroundSessionIds) {
    throw new Error('useBackgroundSessionIdSet must be used within SessionProtectionProvider');
  }
  return backgroundSessionIds;
}

/** Used by chat to protect sessions currently open in another Claude process. */
export function useExternalSessionHolders(): ReadonlyMap<string, number | undefined> {
  const holders = useContext(ExternalHoldersContext);
  if (!holders) throw new Error('useExternalSessionHolders must be used within SessionProtectionProvider');
  return holders;
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
