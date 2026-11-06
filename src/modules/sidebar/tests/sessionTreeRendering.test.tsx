import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');
const project = { projectId: 'p', name: 'p', sessions: [] } as unknown as Project;
const session = (id: string, parentSessionId?: string): SessionWithProvider =>
  ({ id, summary: id, parentSessionId, __provider: 'claude', lastActivity: '2026-08-21T10:00:00Z' } as SessionWithProvider);
const sessions = [session('parent'), session('child-1', 'parent'), session('child-2', 'parent')];
const noop = () => {};
const t = ((key: string) => key) as Parameters<typeof SidebarProjectSessions>[0]['t'];
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

beforeEach(() => localStorage.clear());

const expand = () => screen.getByRole('button', { name: 'sessions.expandChildren' });

test('collapsed by default; chevron expands direct and recursive children without selecting', () => {
  const onSessionSelect = vi.fn();
  render(React.createElement(SidebarProjectSessions, props({
    sessions: [...sessions, session('grandchild', 'child-1')], onSessionSelect,
  })));
  assert.equal(expand().getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByTitle('child-1'), null);
  fireEvent.click(expand());
  assert.equal(onSessionSelect.mock.calls.length, 0);
  assert.ok(screen.getByTitle('child-1'));
  assert.ok(screen.getByTitle('child-2'));
  assert.equal(screen.queryByTitle('grandchild'), null);
  fireEvent.click(expand());
  assert.ok(screen.getByTitle('grandchild'));
});

test('clicking the row opens the session without toggling children', () => {
  const onSessionSelect = vi.fn();
  render(React.createElement(SidebarProjectSessions, props({ onSessionSelect })));
  fireEvent.click(screen.getByTitle('parent'));
  assert.equal(onSessionSelect.mock.calls.length, 1);
  assert.equal(expand().getAttribute('aria-expanded'), 'false');
});

test('bulk selection chevron toggles without ticking the row', () => {
  const onToggleSessionSelected = vi.fn();
  render(React.createElement(SidebarProjectSessions, props({ selectedSessionIds: new Set(), onToggleSessionSelected })));
  fireEvent.click(expand());
  assert.equal(onToggleSessionSelected.mock.calls.length, 0);
  assert.ok(screen.getByTitle('child-1'));
});

test('expansion persists across remounts', () => {
  const view = render(React.createElement(SidebarProjectSessions, props()));
  fireEvent.click(expand());
  assert.deepEqual(JSON.parse(localStorage.getItem('sidebar-expanded-session-parents') ?? '[]'), ['parent']);
  view.unmount();
  render(React.createElement(SidebarProjectSessions, props()));
  assert.ok(screen.getByTitle('child-1'));
});

test('prunes removed loaded ids without dropping ids for unloaded sessions', () => {
  localStorage.setItem('sidebar-expanded-session-parents', JSON.stringify(['parent', 'unloaded-parent']));
  const view = render(React.createElement(SidebarProjectSessions, props()));
  assert.ok(screen.getByTitle('child-1'));
  view.rerender(React.createElement(SidebarProjectSessions, props({ sessions: [session('other')] })));
  assert.deepEqual(JSON.parse(localStorage.getItem('sidebar-expanded-session-parents') ?? '[]'), ['unloaded-parent']);
});

test('selected descendant opens ancestors on mount and when selection changes', () => {
  const nested = [...sessions, session('grandchild', 'child-1')];
  const view = render(React.createElement(SidebarProjectSessions, props({ sessions: nested, selectedSession: nested[3] })));
  assert.ok(screen.getByTitle('grandchild'));
  view.rerender(React.createElement(SidebarProjectSessions, props({ sessions: nested, selectedSession: nested[2] })));
  assert.ok(screen.getByTitle('child-2'));
});

test('collapsing an ancestor of the selected session highlights its row and chevron', () => {
  const view = render(React.createElement(SidebarProjectSessions, props({ selectedSession: sessions[1] })));
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseChildren' }));
  assert.equal(screen.queryByTitle('child-1'), null);
  assert.ok(expand().className.includes('text-primary'));
  assert.ok(screen.getByTitle('parent').closest('a')?.className.includes('bg-primary/5'));
  // Updating the loaded list must not undo a deliberate collapse of the current selection.
  view.rerender(React.createElement(SidebarProjectSessions, props({ selectedSession: sessions[1], sessions: [...sessions] })));
  assert.equal(expand().getAttribute('aria-expanded'), 'false');
});

test('orphaned child shows the bot tooltip trigger', () => {
  render(React.createElement(SidebarProjectSessions, props({ sessions: [session('orphan', 'unloaded')] })));
  assert.ok(screen.getByTestId('started-by-another-session-icon'));
});

test('collapsed descendant activity replaces age on the parent', () => {
  const view = render(React.createElement(SidebarProjectSessions, props({ activeSessions: new Set(['child-1']) })));
  assert.ok(screen.getByTestId('subagent-activity-indicator').querySelector('.animate-spin'));
  assert.equal(screen.getByTitle('parent').closest('a')?.textContent?.includes('<1m'), false);
  view.rerender(React.createElement(SidebarProjectSessions, props({ attentionSessionIds: new Set(['child-1']) })));
  assert.ok(screen.getByTestId('subagent-activity-indicator').querySelector('.bg-amber-500'));
  view.rerender(React.createElement(SidebarProjectSessions, props({ backgroundSessionIds: new Set(['child-1']) })));
  assert.ok(screen.getByTestId('subagent-activity-indicator').querySelector('.bg-purple-500'));
});

test('spacers align siblings only when one has children', () => {
  const view = render(React.createElement(SidebarProjectSessions, props({ sessions: [session('parent'), session('plain'), session('child', 'parent')] })));
  assert.equal(screen.getAllByTestId('session-chevron-spacer').length, 1);
  view.rerender(React.createElement(SidebarProjectSessions, props({ sessions: [session('plain'), session('other')] })));
  assert.equal(screen.queryByTestId('session-chevron-spacer'), null);
});

test('select all includes nested sessions while collapsed', () => {
  const onSetSessionSelection = vi.fn();
  render(React.createElement(SidebarProjectSessions, props({ selectedSessionIds: new Set(), onSetSessionSelection })));
  fireEvent.click(screen.getByRole('button', { name: 'sessions.selectAll' }));
  assert.deepEqual([...onSetSessionSelection.mock.calls[0][0].sessionIds], ['parent', 'child-1', 'child-2']);
});
