import type { ReactNode } from 'react';

import type { SessionTreeNode } from '@/modules/sidebar/utils/sessionTree';

type SidebarChildSessionsProps = {
  nodes: SessionTreeNode[];
  renderRow: (node: SessionTreeNode, isOrphanedChild: boolean, alignChevron: boolean, expanded: boolean, containsSelection: boolean, hiddenActivity: 'processing' | 'attention' | 'background' | null) => ReactNode;
  expandedParentIds: ReadonlySet<string>;
  selectedSessionId?: string;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
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

function containsSession(nodes: SessionTreeNode[], id?: string): boolean {
  return Boolean(id) && nodes.some((node) => node.session.id === id || containsSession(node.children, id));
}

/** Used by SidebarProjectSessions to render nested session rows with their own expandable descendants. */
export default function SidebarChildSessions({
  nodes, renderRow, expandedParentIds, selectedSessionId, activeSessions, backgroundSessionIds,
  attentionSessionIds, nested = false,
}: SidebarChildSessionsProps) {
  const alignChevron = nodes.some((node) => node.children.length > 0);
  return (
    // Geometry of a row: px-2 (8px), then a 20px chevron, gap-2, the icon at 36px.
    // The guide drops from the chevron's centre (17px + 1px border) and the 22px
    // padding starts child rows 40px in, one step deeper than the parent's icon.
    <div className={nested ? 'ml-[17px] border-l border-border/60 pl-[22px]' : undefined}>
      {nodes.map((node) => {
        const { session, children } = node;
        const expanded = expandedParentIds.has(session.id);
        const hiddenActivity = !expanded && children.length > 0
          ? descendantActivity(children, activeSessions, backgroundSessionIds, attentionSessionIds) : null;
        return (
          <div key={session.id}>
            {renderRow(node, !nested && Boolean(session.parentSessionId || session.parentProviderSessionId), alignChevron, expanded, !expanded && containsSession(children, selectedSessionId), hiddenActivity)}
            {children.length > 0 && expanded && (
              <SidebarChildSessions
                nodes={children}
                renderRow={renderRow}
                expandedParentIds={expandedParentIds}
                selectedSessionId={selectedSessionId}
                activeSessions={activeSessions}
                backgroundSessionIds={backgroundSessionIds}
                attentionSessionIds={attentionSessionIds}
                nested
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
