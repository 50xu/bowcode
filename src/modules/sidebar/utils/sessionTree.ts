import type { SessionWithProvider } from '@/shared/types';

export type SessionTreeNode = {
  session: SessionWithProvider;
  children: SessionTreeNode[];
};

/** Arrange loaded sessions by activity, keeping an active descendant's root near the top. */
export function buildSessionTree(sessions: SessionWithProvider[]): SessionTreeNode[] {
  const nodes = new Map(sessions.map((session) => [session.id, { session, children: [] as SessionTreeNode[] }]));
  const roots: SessionTreeNode[] = [];

  for (const session of sessions) {
    const node = nodes.get(session.id)!;
    const parentId = session.parentSessionId;
    let ancestorId = parentId;
    const visited = new Set([session.id]);
    while (ancestorId && nodes.has(ancestorId) && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      ancestorId = nodes.get(ancestorId)!.session.parentSessionId;
    }
    // Only an edge returning to this session creates a cycle for this node.
    const parent = parentId && nodes.get(parentId);
    if (parent && ancestorId !== session.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const activity = (session: SessionWithProvider) =>
    new Date(String(session.lastActivity || session.createdAt || session.created_at || 0)).getTime() || 0;
  const sort = (siblings: SessionTreeNode[], rootsLevel: boolean): void => {
    const latest = new Map<SessionTreeNode, number>();
    const visit = (node: SessionTreeNode): number => {
      const timestamp = Math.max(activity(node.session), ...node.children.map(visit));
      latest.set(node, timestamp);
      return timestamp;
    };
    siblings.forEach(visit);
    siblings.sort((a, b) => (rootsLevel ? latest.get(b)! - latest.get(a)! : activity(b.session) - activity(a.session)));
    siblings.forEach((node) => sort(node.children, false));
  };
  sort(roots, true);
  return roots;
}
