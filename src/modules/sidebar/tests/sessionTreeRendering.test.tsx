import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');
const project = { projectId: 'p', name: 'p', sessions: [] } as unknown as Project;
const session = (id: string, parentSessionId?: string): SessionWithProvider =>
  ({ id, summary: id, parentSessionId, __provider: 'claude', lastActivity: '2026-08-21T10:00:00Z' } as SessionWithProvider);
const sessions = [session('parent'), session('child-1', 'parent'), session('child-2', 'parent')];
const noop = () => {};
const t = ((key: string, options?: { count?: number }) =>
  key === 'sessions.subagentSessions' ? `${options?.count} subagent sessions` : key) as Parameters<typeof SidebarProjectSessions>[0]['t'];
const props = (overrides: Partial<Parameters<typeof SidebarProjectSessions>[0]> = {}) => ({
  project, isExpanded: true, sessions, selectedSession: null, initialSessionsLoaded: true,
  hasMoreSessions: false, isLoadingMoreSessions: false, activeSessions: new Set<string>(),
  backgroundSessionIds: new Set<string>(), attentionSessionIds: new Set<string>(),
  currentTime: new Date('2026-08-21T10:00:00Z'), sessionRenameId: null, sessionRenameDraft: '',
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onProjectSelect: noop, onSessionSelect: noop,
  onDeleteSession: noop, onLoadMoreSessions: noop, onNewSession: noop,
  selectedSessionIds: null, onSetSessionSelection: noop, onToggleSessionSelected: noop,
  onCancelSessionSelection: noop, onDeleteSelectedSessions: noop, t, ...overrides,
});

test('toggle starts collapsed and expands direct and recursive children', () => {
  render(React.createElement(SidebarProjectSessions, props({
    sessions: [...sessions, session('grandchild', 'child-1')],
  })));
  const toggle = screen.getByRole('button', { name: '2 subagent sessions' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByTitle('child-1'), null);
  fireEvent.click(toggle);
  assert.ok(screen.getByTitle('child-1'));
  assert.ok(screen.getByTitle('child-2'));
  assert.equal(screen.queryByTitle('grandchild'), null);
  fireEvent.click(screen.getByRole('button', { name: '1 subagent sessions' }));
  assert.ok(screen.getByTitle('grandchild'));
});

test('selected descendant opens ancestors on mount and when selection changes', () => {
  const nested = [...sessions, session('grandchild', 'child-1')];
  const { rerender } = render(React.createElement(SidebarProjectSessions, props({ sessions: nested })));
  rerender(React.createElement(SidebarProjectSessions, props({ sessions: nested, selectedSession: nested[3] })));
  assert.ok(screen.getByTitle('grandchild'));
});

test('orphaned child shows the bot tooltip trigger', () => {
  render(React.createElement(SidebarProjectSessions, props({ sessions: [session('orphan', 'unloaded')] })));
  assert.ok(screen.getByTestId('started-by-another-session-icon'));
});

test('collapsed descendant processing shows activity on the toggle', () => {
  render(React.createElement(SidebarProjectSessions, props({
    sessions: [...sessions, session('grandchild', 'child-1')], activeSessions: new Set(['grandchild']),
  })));
  assert.ok(screen.getByTestId('subagent-activity-indicator').querySelector('.animate-spin'));
});

test('select all includes nested sessions while collapsed', () => {
  const onSetSessionSelection = vi.fn();
  render(React.createElement(SidebarProjectSessions, props({
    selectedSessionIds: new Set(), onSetSessionSelection,
  })));
  fireEvent.click(screen.getByRole('button', { name: 'sessions.selectAll' }));
  assert.deepEqual([...onSetSessionSelection.mock.calls[0][0].sessionIds], ['parent', 'child-1', 'child-2']);
});
