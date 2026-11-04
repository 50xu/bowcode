import { BookOpen, Boxes, Briefcase, Code2, Cpu, Database, Flame, Folder, Globe, Layers, Leaf, Package, Rocket, Server, Wallet, Zap } from 'lucide-react';

import type { Project, SessionWithProvider } from '@/shared/types';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';

const PROJECT_ICONS = [Folder, Rocket, Boxes, Code2, Database, Globe, Cpu, Leaf, Flame, Zap, Package, Server, Wallet, BookOpen, Briefcase, Layers] as const;

/** Gives a project a stable visual identity independent of its display name. */
export function getProjectIdentity(project: Project) {
  const key = project.fullPath || project.projectId;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  const value = hash >>> 0;
  return { Icon: PROJECT_ICONS[value % PROJECT_ICONS.length], hue: value % 360 };
}

/** Summarizes the most recently active loaded session and the project's total count. */
export function getProjectSummary(project: Project, sessions: SessionWithProvider[], currentTime: Date = new Date()): string {
  if (sessions.length === 0) return 'No sessions yet';

  const latest = sessions.reduce((mostRecent, session) => {
    const timestamp = (item: SessionWithProvider) => new Date(item.lastActivity || item.createdAt || item.created_at || 0).getTime() || 0;
    return timestamp(session) > timestamp(mostRecent) ? session : mostRecent;
  });
  const title = (latest.summary || latest.title || latest.name || 'New session').trim();
  const shortTitle = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  const count = Number(project.sessionMeta?.total ?? sessions.length);
  const age = formatCompactAge(latest.lastActivity || latest.createdAt || latest.created_at, currentTime);
  return `${shortTitle} · ${count}${age ? ` · ${age}` : ''}`;
}
