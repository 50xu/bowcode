import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { SessionTreeNode } from '@/modules/sidebar/utils/sessionTree';

type SidebarChildSessionsProps = {
  nodes: SessionTreeNode[];
  renderRow: (node: SessionTreeNode, isOrphanedChild: boolean) => ReactNode;
  expandedParentIds: ReadonlySet<string>;
  onToggleParent: (id: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  t: TFunction;
  nested?: boolean;
};

function descendantActivity(
  children: SessionTreeNode[],
  activeSessions: ReadonlySet<string>,
  backgroundSessionIds: ReadonlySet<string>,
  attentionSessionIds: ReadonlySet<string>,
): 'processing' | 'attention' | 'background' | null {
  let activity: 'processing' | 'attention' | 'background' | null = null;
  for (const child of children) {
    const id = child.session.id;
    if (activeSessions.has(id) && !backgroundSessionIds.has(id)) return 'processing';
    if (attentionSessionIds.has(id)) activity = 'attention';
    else if (backgroundSessionIds.has(id) && !activity) activity = 'background';
    const deeper = descendantActivity(child.children, activeSessions, backgroundSessionIds, attentionSessionIds);
    if (deeper === 'processing') return 'processing';
    if (deeper === 'attention') activity = 'attention';
    else if (deeper === 'background' && !activity) activity = 'background';
  }
  return activity;
}

/** Used by SidebarProjectSessions to render nested session rows with their own expandable descendants. */
export default function SidebarChildSessions({
  nodes, renderRow, expandedParentIds, onToggleParent, activeSessions, backgroundSessionIds,
  attentionSessionIds, t, nested = false,
}: SidebarChildSessionsProps) {
  return (
    <div className={nested ? 'ml-3 border-l border-border/60 pl-1.5' : undefined}>
      {nodes.map((node) => {
        const { session, children } = node;
        const expanded = expandedParentIds.has(session.id);
        const activity = !expanded && descendantActivity(children, activeSessions, backgroundSessionIds, attentionSessionIds);
        return (
          <div key={session.id}>
            {renderRow(node, !nested && Boolean(session.parentSessionId || session.parentProviderSessionId))}
            {children.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-3 h-9 w-[calc(100%-0.75rem)] justify-start gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:h-8"
                  onClick={() => onToggleParent(session.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  {t('sessions.subagentSessions', { count: children.length })}
                  {activity && (
                    <span data-testid="subagent-activity-indicator" role="status" aria-label={activity} className="ml-auto inline-flex items-center">
                      {activity === 'processing' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <span className={`h-1.5 w-1.5 rounded-full ${activity === 'attention' ? 'bg-amber-500' : 'bg-purple-500 dark:bg-purple-400'}`} />
                      )}
                    </span>
                  )}
                </Button>
                {expanded && (
                  <SidebarChildSessions
                    nodes={children}
                    renderRow={renderRow}
                    expandedParentIds={expandedParentIds}
                    onToggleParent={onToggleParent}
                    activeSessions={activeSessions}
                    backgroundSessionIds={backgroundSessionIds}
                    attentionSessionIds={attentionSessionIds}
                    t={t}
                    nested
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
