import { CalendarClock, ChevronDown, ChevronRight, Pause, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import ScheduleEditorForm from '@/modules/schedules/ScheduleEditorForm';
import ScheduleRunHistory, { ScheduleStatusBadge } from '@/modules/schedules/ScheduleRunHistory';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import { describeScheduleCadence, formatScheduleDateTime } from '@/modules/schedules/utils/scheduleCadence';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { LLMProvider, Project, Schedule, ScheduleInput } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';

type SchedulesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sidebar's projects: the editor's project choices, and how each row names its project. */
  projects: Project[];
  /**
   * Opens a session a run created. The dialog closes itself first. `projectId`
   * is null when the schedule's project is no longer in the sidebar.
   */
  onOpenSession: (sessionId: string, provider: LLMProvider, projectId: string | null) => void;
};

/** What the dialog shows: the list, or the editor for a new (null) or existing schedule. */
type DialogView = { kind: 'list' } | { kind: 'editor'; schedule: Schedule | null };

function projectForSchedule(projects: Project[], schedule: Schedule): Project | undefined {
  return projects.find((project) => project.fullPath === schedule.projectPath || project.path === schedule.projectPath);
}

function projectLabel(projects: Project[], schedule: Schedule): string {
  const project = projectForSchedule(projects, schedule);
  if (project) return project.displayName;
  const parts = schedule.projectPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? schedule.projectPath;
}

/** The body of the dialog; mounted only while it is open, so schedules are read (and followed) only then. */
function SchedulesDialogBody({ projects, onOpenSession, onClose }: {
  projects: Project[];
  onOpenSession: SchedulesDialogProps['onOpenSession'];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('schedules');
  const { subscribe } = useWebSocket();
  const {
    schedules,
    isLoading,
    loadError,
    createSchedule,
    updateSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule,
    runScheduleNow,
  } = useSchedules(subscribe);
  // Whether the list or the editor is showing, and which schedule the editor holds.
  const [view, setView] = useState<DialogView>({ kind: 'list' });
  // The schedule whose run history is expanded; one at a time keeps the list scannable.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The last row action's failure (run now, pause, delete), shown above the list.
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSubmit = async (input: ScheduleInput) => {
    if (view.kind === 'editor' && view.schedule) {
      await updateSchedule(view.schedule.id, input);
    } else {
      await createSchedule(input);
    }
    setView({ kind: 'list' });
  };

  const openSession = (schedule: Schedule, sessionId: string) => {
    onClose();
    onOpenSession(sessionId, schedule.provider, projectForSchedule(projects, schedule)?.projectId ?? null);
  };

  if (view.kind === 'editor') {
    return (
      <>
        <div className="border-b border-border px-5 py-3">
          <DialogTitle className="not-sr-only text-base font-semibold">
            {view.schedule ? t('editor.editTitle') : t('editor.newTitle')}
          </DialogTitle>
        </div>
        <ScheduleEditorForm
          schedule={view.schedule}
          projects={projects}
          onCancel={() => setView({ kind: 'list' })}
          onSubmit={handleSubmit}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="not-sr-only text-base font-semibold">{t('title')}</DialogTitle>
        </div>
        <Button size="sm" onClick={() => setView({ kind: 'editor', schedule: null })}>
          <Plus />
          {t('actions.new')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <p className="mb-3 text-xs text-muted-foreground">{t('runsWhileRunningNote')}</p>
        {(loadError || actionError) && (
          <p role="alert" className="mb-3 text-sm text-destructive">{actionError ?? loadError}</p>
        )}

        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : schedules.length === 0 ? (
          <div className="py-10 text-center">
            <CalendarClock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">{t('empty.title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('empty.description')}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {schedules.map((schedule) => {
              const expanded = expandedId === schedule.id;
              return (
                <li key={schedule.id} className="rounded-lg border border-border/70 bg-card">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
                    <button
                      type="button"
                      className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent"
                      aria-expanded={expanded}
                      aria-label={t('history.toggle')}
                      onClick={() => setExpandedId(expanded ? null : schedule.id)}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{schedule.name}</span>
                        {!schedule.enabled && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('paused')}</span>
                        )}
                        {schedule.lastStatus && <ScheduleStatusBadge status={schedule.lastStatus} />}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">{projectLabel(projects, schedule)}</span>
                        <span className="inline-flex items-center gap-1">
                          <LLMProviderLogo provider={schedule.provider} className="h-3 w-3" />
                          {schedule.model ?? t('editor.defaultModel')}
                        </span>
                        <span>{describeScheduleCadence(schedule, t, i18n.language)}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {schedule.enabled && schedule.nextRunAt
                          ? t('nextRun', { time: formatScheduleDateTime(schedule.nextRunAt, i18n.language) })
                          : t('noNextRun')}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={t('actions.runNow')} aria-label={t('actions.runNow')}
                        disabled={schedule.lastStatus === 'running'}
                        onClick={() => void runAction(() => runScheduleNow(schedule.id))}>
                        <Zap />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
                        title={schedule.enabled ? t('actions.pause') : t('actions.resume')}
                        aria-label={schedule.enabled ? t('actions.pause') : t('actions.resume')}
                        onClick={() => void runAction(() => (schedule.enabled ? pauseSchedule(schedule.id) : resumeSchedule(schedule.id)))}>
                        {schedule.enabled ? <Pause /> : <Play />}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={t('actions.edit')} aria-label={t('actions.edit')}
                        onClick={() => setView({ kind: 'editor', schedule })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        title={t('actions.delete')} aria-label={t('actions.delete')}
                        onClick={() => {
                          if (window.confirm(t('confirmDelete', { name: schedule.name }))) {
                            void runAction(() => deleteSchedule(schedule.id));
                          }
                        }}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="border-t border-border/60">
                      <ScheduleRunHistory
                        scheduleId={schedule.id}
                        revision={`${schedule.lastRunAt ?? ''}:${schedule.lastStatus ?? ''}`}
                        onOpenSession={(sessionId) => openSession(schedule, sessionId)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The schedules dialog: every schedule across projects, with create/edit,
 * run now, pause/resume, delete and each schedule's run history. Used by the
 * sidebar module, which opens it from the Schedules button in its header.
 */
export function SchedulesDialog({ open, onOpenChange, projects, onOpenSession }: SchedulesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden p-0">
        {open && (
          <SchedulesDialogBody projects={projects} onOpenSession={onOpenSession} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
