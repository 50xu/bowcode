import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatScheduleDateTime } from '@/modules/schedules/utils/scheduleCadence';
import { api, readApiJson } from '@/shared/api';
import type { ScheduleRun, ScheduleRunStatus } from '@/shared/types';
import { Button } from '@/shared/ui';

type ScheduleRunHistoryProps = {
  scheduleId: string;
  /**
   * Changes whenever the schedule's latest run changes (its `lastRunAt` and
   * `lastStatus`), so the history is read again as runs start and finish.
   */
  revision: string;
  onOpenSession: (sessionId: string) => void;
};

const STATUS_CLASSES: Record<ScheduleRunStatus, string> = {
  running: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  succeeded: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  skipped: 'bg-muted text-muted-foreground',
  timed_out: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

/** A status pill for a run, shared by the history rows and the panel's "last run" column. */
export function ScheduleStatusBadge({ status }: { status: ScheduleRunStatus }) {
  const { t } = useTranslation('schedules');
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status]}`}>
      {t(`status.${status}`)}
    </span>
  );
}

function formatDuration(run: ScheduleRun): string {
  if (!run.finishedAt) return '';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Rendered by this module's SchedulesPanel under an expanded schedule: its recent runs, each linking to its session. */
export default function ScheduleRunHistory({ scheduleId, revision, onOpenSession }: ScheduleRunHistoryProps) {
  const { t, i18n } = useTranslation('schedules');
  // The runs on screen, newest first; null until the first read settles.
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  // Why the last read failed, shown in place of the list.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<{ data: ScheduleRun[] }>(await api.schedules.runs(scheduleId));
        if (cancelled) return;
        setRuns(Array.isArray(body.data) ? body.data : []);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleId, revision]);

  if (error) {
    return <p className="px-3 py-2 text-xs text-destructive">{error}</p>;
  }
  if (runs === null) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('history.loading')}</p>;
  }
  if (runs.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('history.empty')}</p>;
  }

  return (
    <ul className="divide-y divide-border/60" aria-label={t('history.title')}>
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
          <ScheduleStatusBadge status={run.status} />
          <span className="text-foreground">{formatScheduleDateTime(run.startedAt, i18n.language)}</span>
          {run.trigger === 'manual' && <span className="text-muted-foreground">{t('history.manual')}</span>}
          {formatDuration(run) && <span className="text-muted-foreground">{formatDuration(run)}</span>}
          {run.error && <span className="min-w-0 basis-full break-words text-muted-foreground">{run.error}</span>}
          {run.sessionId && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => onOpenSession(run.sessionId!)}
            >
              <ExternalLink />
              {t('history.openSession')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
