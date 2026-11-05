import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { Schedule, ScheduleInput, ServerEvent } from '@/shared/types';

type ApiEnvelope<T> = { success: boolean; data: T };

/**
 * Every schedule of the user, across projects, kept current with the server.
 * Used by this module's SchedulesDialog, which lists them and hands mutations
 * to the editor form.
 *
 * Read on mount and again whenever the server announces `schedules_changed`
 * (a schedule was edited anywhere, or a run started or finished) and after a
 * websocket reconnect, since an announcement sent while the socket was down
 * is lost. Mutations throw an `ApiRequestError` carrying the server's message
 * so the editor can show why a save was refused.
 */
export function useSchedules(
  subscribe?: (listener: (event: ServerEvent) => void) => () => void,
) {
  // The list on screen; replaced wholesale by every read.
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  // True until the first read settles, so the panel shows a loading state instead of the empty state.
  const [isLoading, setIsLoading] = useState(true);
  // The last read's failure, shown above the list; cleared by the next successful read.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Numbers each list request so only the newest answer is applied: a run
  // starting and finishing announces two changes back to back.
  const latestRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequestRef.current;
    try {
      const body = await readApiJson<ApiEnvelope<Schedule[]>>(await api.schedules.list());
      if (request !== latestRequestRef.current) return;
      setSchedules(Array.isArray(body.data) ? body.data : []);
      setLoadError(null);
    } catch (error) {
      if (request !== latestRequestRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === latestRequestRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'schedules_changed' || event.kind === 'websocket_reconnected') {
        void refresh();
      }
    });
  }, [refresh, subscribe]);

  /** Runs one mutation and re-reads the list, rethrowing the server's refusal. */
  const mutate = useCallback(async <T,>(request: () => Promise<Response>): Promise<T> => {
    try {
      const body = await readApiJson<ApiEnvelope<T>>(await request());
      return body.data;
    } finally {
      void refresh();
    }
  }, [refresh]);

  const createSchedule = useCallback(
    (input: ScheduleInput) => mutate<Schedule>(() => api.schedules.create(input)),
    [mutate],
  );
  const updateSchedule = useCallback(
    (id: string, input: Partial<ScheduleInput>) => mutate<Schedule>(() => api.schedules.update(id, input)),
    [mutate],
  );
  const pauseSchedule = useCallback((id: string) => mutate<Schedule>(() => api.schedules.pause(id)), [mutate]);
  const resumeSchedule = useCallback((id: string) => mutate<Schedule>(() => api.schedules.resume(id)), [mutate]);
  const deleteSchedule = useCallback((id: string) => mutate<unknown>(() => api.schedules.remove(id)), [mutate]);
  const runScheduleNow = useCallback((id: string) => mutate<unknown>(() => api.schedules.runNow(id)), [mutate]);

  return {
    schedules,
    isLoading,
    loadError,
    refresh,
    createSchedule,
    updateSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule,
    runScheduleNow,
  };
}
