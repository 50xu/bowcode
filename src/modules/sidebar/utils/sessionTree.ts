import type { SessionWithProvider } from '@/shared/types';

export type SessionTreeNode = {
  session: SessionWithProvider;
  children: SessionTreeNode[];
};

/** Arrange loaded sidebar sessions without changing their order or linking outside the loaded page. */
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

  return roots;
}
