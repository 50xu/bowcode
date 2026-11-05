import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * The sidebar's hide button. On desktop it collapses the docked sidebar to its
 * icon rail through the `sidebarVisible` preference; on mobile the sidebar is a
 * drawer with its own open state, so the button must close the drawer and leave
 * the desktop preference alone.
 */

const jsonResponse = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => jsonResponse({ data: { projects: [] } }),
    getArchivedSessions: () => jsonResponse({ sessions: [] }),
    recentConversations: () => jsonResponse({ sessions: [], total: 0, hasMore: false }),
    migrateLegacyProjectStars: () => jsonResponse({}),
  },
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const PROJECTS: Project[] = [];
const NO_SESSIONS: ReadonlySet<string> = new Set();

const renderController = (isMobile: boolean) => {
  const setSidebarVisible = vi.fn();
  const onCloseMobileSidebar = vi.fn();
  const { result } = renderHook(() =>
    useSidebarController({
      projects: PROJECTS,
      selectedProject: null,
      selectedSession: null,
      activeSessions: NO_SESSIONS,
      backgroundSessionIds: NO_SESSIONS,
      isLoading: false,
      isMobile,
      t,
      onRefresh: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onSessionDelete: noop,
      onLoadMoreSessions: noop,
      onProjectDelete: noop,
      setCurrentProject: noop,
      setSidebarVisible,
      sidebarVisible: true,
      onCloseMobileSidebar,
    }),
  );
  return { result, setSidebarVisible, onCloseMobileSidebar };
};

beforeEach(() => {
  localStorage.clear();
});

test('on desktop the hide button collapses the docked sidebar', () => {
  const { result, setSidebarVisible, onCloseMobileSidebar } = renderController(false);

  act(() => result.current.collapseSidebar());

  assert.deepEqual(setSidebarVisible.mock.calls, [[false]]);
  assert.equal(onCloseMobileSidebar.mock.calls.length, 0);
});

test('on mobile the hide button closes the drawer without touching the desktop preference', () => {
  const { result, setSidebarVisible, onCloseMobileSidebar } = renderController(true);

  act(() => result.current.collapseSidebar());

  assert.equal(onCloseMobileSidebar.mock.calls.length, 1);
  assert.equal(setSidebarVisible.mock.calls.length, 0, 'sidebarVisible is a desktop-only preference');
});
