import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, ChevronRight, Edit3, MoreHorizontal, Plus, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import { ActionMenu } from '@/shared/ui';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import { getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { getProjectIdentity, getProjectSummary } from '@/modules/sidebar/utils/projectIdentity';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  /** The sessions ticked in this project's list, or null when it is not the one selecting. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const { Icon, hue } = getProjectIdentity(project);
  const summary = getProjectSummary(project, sessions, currentTime);
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();
  // Keeps the "…" trigger visible while its menu is open, after the pointer leaves the row.
  const [optionsOpen, setOptionsOpen] = useState(false);

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  return (
    <div className={cn('min-w-0', isDeleting && 'pointer-events-none opacity-50')}>
      <div className={cn('group flex h-11 min-w-0 items-center gap-1 rounded-md px-1 transition-colors hover:bg-accent md:h-9', isSelected && 'bg-primary/10')}
        data-testid="project-tree-row"
      >
        <button type="button" onClick={isCompact ? toggleProject : selectAndToggleProject}
          aria-label={isExpanded ? `Collapse ${project.displayName}` : `Expand ${project.displayName}`}
          aria-expanded={isExpanded}
          className="flex h-8 w-5 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')} />
        </button>
        <button type="button" onClick={isCompact ? toggleProject : selectAndToggleProject}
          className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-0.5 text-left', isSelected && 'text-primary')}
          title={project.fullPath}
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-[var(--project-icon-bg)] text-[var(--project-icon-fg)] dark:bg-[var(--project-icon-dark-bg)] dark:text-[var(--project-icon-dark-fg)]"
            style={{
              '--project-icon-bg': `hsl(${hue} 70% 92%)`,
              '--project-icon-fg': `hsl(${hue} 65% 40%)`,
              '--project-icon-dark-bg': `hsl(${hue} 45% 22%)`,
              '--project-icon-dark-fg': `hsl(${hue} 70% 70%)`,
            } as CSSProperties}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            {isEditing ? (
              <input ref={mobileRenameInputRef} type="text" value={renameDraft}
                onChange={(event) => onRenameDraftChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveProjectName();
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }
                }}
                className="w-full rounded border border-primary bg-background px-1 text-sm text-foreground focus:outline-none max-md:text-base"
                placeholder={t('projects.projectNamePlaceholder')} autoFocus autoComplete="off"
              />
            ) : (
              <span className={cn('block truncate text-sm font-medium leading-4', isSelected ? 'text-primary' : 'text-foreground')}>{project.displayName}</span>
            )}
            <span className="block truncate text-xs leading-4 text-muted-foreground" title={summary}>{summary}</span>
          </span>
        </button>
        {tasksEnabled && <TaskIndicator status={taskStatus} size="xs" className="hidden shrink-0 md:inline-flex" />}
        {isStarred && !isEditing && (
          <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500 dark:text-yellow-400" aria-label={t('tooltips.removeFromFavorites')} />
        )}
        <div className="flex shrink-0 items-center">
          {isEditing ? (
            <>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded text-green-600 hover:bg-accent" onClick={saveProjectName} aria-label="Save project name"><Check className="h-4 w-4" /></button>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-accent" onClick={onCancelEditingProject} aria-label={t('actions.cancel')}><X className="h-4 w-4" /></button>
            </>
          ) : (
            <>
              {/* Star / rename / delete live behind one "…" so the name keeps its width.
                  The trigger always holds its slot (only its opacity changes), so neither
                  the name nor the + to its right shifts when the pointer arrives. */}
              <div className={cn('transition-opacity', optionsOpen ? 'opacity-100' : 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100')}>
                <ActionMenu
                  label={t('tooltips.projectOptions', { defaultValue: 'Project options' })}
                  ariaLabel={`${t('tooltips.projectOptions', { defaultValue: 'Project options' })}: ${project.displayName}`}
                  icon={MoreHorizontal}
                  iconOnly
                  portal
                  variant="ghost"
                  size="icon"
                  onOpenChange={setOptionsOpen}
                  triggerClassName="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                  menuClassName="w-[220px] rounded-xl p-1.5 shadow-xl"
                  items={[
                    {
                      key: 'star',
                      label: isStarred ? t('projectMenu.unfavorite') : t('projectMenu.favorite'),
                      icon: Star,
                      onSelect: toggleStarProject,
                    },
                    {
                      key: 'rename',
                      label: t('projectMenu.rename'),
                      icon: Edit3,
                      onSelect: () => onStartEditingProject(project),
                    },
                    {
                      key: 'delete',
                      label: t('projectMenu.remove'),
                      icon: Trash2,
                      isDanger: true,
                      showDividerBefore: true,
                      onSelect: () => onDeleteProject(project),
                    },
                  ]}
                />
              </div>
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded text-primary hover:bg-primary/10" onClick={() => { if (isCompact) onProjectSelect(project); onNewSession(project); }} title={t('sessions.newSession')} aria-label={t('sessions.newSession')}><Plus className="h-4 w-4" /></button>
            </>
          )}
        </div>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        backgroundSessionIds={backgroundSessionIds}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        selectedSessionIds={selectedSessionIds}
        onSetSessionSelection={onSetSessionSelection}
        onToggleSessionSelected={onToggleSessionSelected}
        onCancelSessionSelection={onCancelSessionSelection}
        onDeleteSelectedSessions={onDeleteSelectedSessions}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
