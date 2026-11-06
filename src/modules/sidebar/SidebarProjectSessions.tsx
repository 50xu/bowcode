import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import SidebarChildSessions from '@/modules/sidebar/SidebarChildSessions';
import { buildSessionTree } from '@/modules/sidebar/utils/sessionTree';
import type { SessionTreeNode } from '@/modules/sidebar/utils/sessionTree';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  /** The sessions ticked here, or null when this project's list is not in selection mode. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

const EXPANDED_SESSION_PARENTS_KEY = 'sidebar-expanded-session-parents';

function readExpandedParents(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_SESSION_PARENTS_KEY) ?? 'null');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex h-9 items-center px-2 md:h-8">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession: _onNewSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectSessionsProps) {
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);
  // Browser-local parent expansion survives remounts and is shared across project lists.
  const [expandedParentIds, setExpandedParentIds] = useState<ReadonlySet<string>>(readExpandedParents);
  const previouslyLoadedIds = useRef<Set<string>>(new Set());
  const removedLoadedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!initialSessionsLoaded) return;
    const loadedIds = new Set(sessions.map((session) => session.id));
    const removed = [...previouslyLoadedIds.current].filter((id) => !loadedIds.has(id));
    removed.forEach((id) => removedLoadedIds.current.add(id));
    loadedIds.forEach((id) => removedLoadedIds.current.delete(id));
    previouslyLoadedIds.current = loadedIds;
    if (removed.length) {
      setExpandedParentIds((previous) => {
        const next = new Set(previous);
        removed.forEach((id) => next.delete(id));
        return next.size === previous.size ? previous : next;
      });
    }
  }, [initialSessionsLoaded, sessions]);
  useEffect(() => {
    try {
      const saved = readExpandedParents();
      const next = new Set([...saved, ...expandedParentIds]);
      // The currently loaded project's known ids are authoritative for its own expansions.
      for (const session of sessions) {
        if (!expandedParentIds.has(session.id)) next.delete(session.id);
      }
      removedLoadedIds.current.forEach((id) => next.delete(id));
      localStorage.setItem(EXPANDED_SESSION_PARENTS_KEY, JSON.stringify([...next]));
    } catch { /* Expansion still works when storage is unavailable. */ }
  }, [expandedParentIds, sessions]);
  // A selected descendant opens its ancestors once per selection, not on every websocket list refresh.
  const autoExpandedSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSession?.id) {
      autoExpandedSelection.current = null;
      return;
    }
    if (autoExpandedSelection.current === selectedSession.id) return;
    const ancestors: string[] = [];
    const findSelected = (nodes: SessionTreeNode[], path: string[]): boolean => {
      for (const node of nodes) {
        if (node.session.id === selectedSession.id) {
          ancestors.push(...path);
          return true;
        }
        if (findSelected(node.children, [...path, node.session.id])) return true;
      }
      return false;
    };
    if (findSelected(tree, [])) {
      autoExpandedSelection.current = selectedSession.id;
      if (ancestors.length) {
        setExpandedParentIds((previous) => ancestors.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ancestors]));
      }
    }
  }, [selectedSession?.id, tree]);
  const onToggleParent = useCallback((id: string) => {
    setExpandedParentIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  const selectableSessionIds = sessions.filter((session) => !isSessionRunning(session)).map((session) => session.id);
  // Re-derived from the selectable rows rather than read straight off the
  // selection, so a row that started running after it was ticked drops out of
  // the count, the button and the ids the confirmation is opened with.
  const effectiveSelectedIds = selectedSessionIds
    ? selectableSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
    : [];
  const checkedSessionIds = new Set(effectiveSelectedIds);
  const allLoadedSelected =
    selectableSessionIds.length > 0 && effectiveSelectedIds.length === selectableSessionIds.length;
  // With more sessions on the server than on screen, the button only reaches the
  // loaded rows, so it offers "Select all loaded" rather than a "Select all" it
  // could not honour. Once those rows are ticked it flips to "Clear" either way.
  const selectAllLabel = allLoadedSelected
    ? t('sessions.clearSelection')
    : hasMoreSessions
      ? t('sessions.selectAllLoaded')
      : t('sessions.selectAll');

  const renderRow = (node: SessionTreeNode, isOrphanedChild: boolean, alignChevron: boolean, expanded: boolean, containsSelection: boolean, hiddenActivity: 'processing' | 'attention' | 'background' | null) => {
    const session = node.session;
    return (
      <SidebarSessionItem
        project={project}
        session={session}
        selectedSession={selectedSession}
        isProcessing={isSessionRunning(session)}
        hasBackgroundWork={backgroundSessionIds.has(session.id)}
        needsAttention={attentionSessionIds.has(session.id)}
        isOrphanedChild={isOrphanedChild || undefined}
        hasChildren={node.children.length > 0}
        alignChevron={alignChevron}
        isChildrenExpanded={expanded}
        containsSelection={containsSelection}
        hiddenActivity={hiddenActivity}
        onToggleChildren={onToggleParent}
        currentTime={currentTime}
        onRenameDraftChange={onRenameDraftChange}
        isEditing={session.id === sessionRenameId}
        renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        isSelecting={isSelecting}
        isChecked={checkedSessionIds.has(session.id)}
        onToggleSessionSelected={onToggleSessionSelected}
        t={t}
      />
    );
  };

  // The guide drops from the project chevron's centre (px-1.5 + half of w-5 = 16px),
  // and the padding starts session rows so their chevron column sits under the project icon.
  return (
    <div className="mb-2 ml-[15px] mt-0.5 space-y-0.5 border-l border-border/60 pl-[10px]">

      {isSelecting && (
        <div className="px-1">
          <>
            {/* Wraps rather than clips: at the narrowest sidebar width a long
                translated "Select all loaded" leaves no room for Cancel. */}
            <div className="flex flex-wrap items-center justify-between gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onSetSessionSelection({
                    projectId: project.projectId,
                    sessionIds: new Set(allLoadedSelected ? [] : selectableSessionIds),
                  })
                }
                disabled={selectableSessionIds.length === 0}
              >
                {selectAllLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={onCancelSessionSelection}
              >
                {t('actions.cancel')}
              </Button>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 w-full justify-start gap-2 rounded-md bg-red-600 text-xs font-medium text-white hover:bg-red-700"
              onClick={() => onDeleteSelectedSessions(effectiveSelectedIds)}
              disabled={effectiveSelectedIds.length === 0}
            >
              <Trash2 className="h-3 w-3" />
              {t('sessions.deleteSelected', { count: effectiveSelectedIds.length })}
            </Button>
          </>
        </div>
      )}

      {/* A page emptied by deleting every loaded row still has sessions behind
          it on the server, so it keeps its "Load more" instead of "No sessions". */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !hasMoreSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          <SidebarChildSessions
            nodes={tree}
            renderRow={renderRow}
            expandedParentIds={expandedParentIds}
            selectedSessionId={selectedSession?.id}
            activeSessions={activeSessions}
            backgroundSessionIds={backgroundSessionIds}
            attentionSessionIds={attentionSessionIds}
          />

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-full justify-start rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:h-8"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
