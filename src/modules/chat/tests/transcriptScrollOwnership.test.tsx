import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: {
    providers: { sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }) },
    runningSessions: () => Promise.resolve({ ok: false }),
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const project: Project = {
  projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false,
};
const buildMessage = (index: number, timestamp = `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`): NormalizedMessage => ({
  id: `m-${index}`, kind: 'text', role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude', sessionId: SESSION_A, content: `message ${index}`, timestamp,
} as NormalizedMessage);

/** jsdom layout for a transcript whose rows can be prepended or appended. */
function createContainer(height = 5000, clientHeight = 500) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const writes: number[] = [];
  let scrollTop = height - clientHeight;
  let scrollHeight = height;
  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => { scrollTop = next; writes.push(next); },
  });
  element.getBoundingClientRect = () => ({ top: 0, bottom: clientHeight } as DOMRect);
  const addRow = (timestamp: string, top: () => number) => {
    const row = document.createElement('div');
    row.setAttribute('data-transcript-row', '');
    row.setAttribute('data-message-timestamp', timestamp);
    row.getBoundingClientRect = () => ({ top: top() - scrollTop, bottom: top() - scrollTop + 100 } as DOMRect);
    element.appendChild(row);
    return row;
  };
  return { element, writes, addRow, setHeight: (value: number) => { scrollHeight = value; } };
}

function createStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1, status: 'idle' as const, total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false, offset: messagesBySession.get(sessionId)?.length ?? 0,
  });
  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId), applied: true, changed: false, deferred: false,
    })),
    setActiveSession: vi.fn(), isStale: vi.fn(() => false), updateStreaming: vi.fn(), finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderChatSessionState(options: { session: ProjectSession; store: ReturnType<typeof createStore> }) {
  const [{ useChatSessionState }, { SessionProtectionProvider }] = await Promise.all([
    import('@/modules/chat/hooks/useChatSessionState'),
    import('@/shared/context/SessionProtectionContext'),
  ]);
  return renderHook(
    ({ session }: { session: ProjectSession }) => useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: session, ws: null,
      sendMessage: vi.fn(), resetStreamingState: vi.fn(),
      statusCheckSentAtRef: { current: new Map() }, lastSeqRef: { current: new Map() },
      sessionStore: options.store as never,
    }),
    { initialProps: { session: options.session }, wrapper: SessionProtectionProvider },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('transcript scroll ownership', () => {
  it('does not yank a reader back during streaming, but follows while pinned', async () => {
    const messages = new Map([[SESSION_A, [buildMessage(0)]]]);
    const { result, rerender } = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store: createStore(messages) });
    const container = createContainer();
    result.current.scrollContainerRef.current = container.element;
    act(() => { result.current.scrollToBottom(); });
    container.writes.length = 0;
    container.setHeight(5100);
    messages.set(SESSION_A, [...messages.get(SESSION_A)!, buildMessage(1)]);
    act(() => { rerender({ session: { id: SESSION_A } as ProjectSession }); });
    expect(container.writes).toContain(5100);

    act(() => { result.current.setIsUserScrolledUp(true); });
    container.writes.length = 0;
    container.setHeight(5200);
    messages.set(SESSION_A, [...messages.get(SESSION_A)!, buildMessage(2)]);
    act(() => { rerender({ session: { id: SESSION_A } as ProjectSession }); vi.advanceTimersByTime(200); });
    expect(container.writes).toEqual([]);
  });

  it('compensates a prepend once by the inserted height', async () => {
    const messages = new Map([[SESSION_A, [buildMessage(1), buildMessage(2)]]]);
    const { result, rerender } = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store: createStore(messages) });
    const container = createContainer(2000);
    result.current.scrollContainerRef.current = container.element;
    let shift = 0;
    container.addRow(String(buildMessage(1).timestamp), () => 1500 + shift);
    act(() => { result.current.setIsUserScrolledUp(true); });
    container.writes.length = 0;
    shift = 120;
    container.setHeight(2120);
    messages.set(SESSION_A, [buildMessage(0), ...messages.get(SESSION_A)!]);
    act(() => { rerender({ session: { id: SESSION_A } as ProjectSession }); });
    expect(container.writes).toEqual([1620]);
  });

  it('retains the first rendered row on tail append while free', async () => {
    const messages = new Map([[SESSION_A, Array.from({ length: 110 }, (_, i) => buildMessage(i))]]);
    const { result, rerender } = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store: createStore(messages) });
    const container = createContainer();
    result.current.scrollContainerRef.current = container.element;
    act(() => { result.current.setIsUserScrolledUp(true); });
    const first = result.current.visibleMessages[0].timestamp;
    container.writes.length = 0;
    messages.set(SESSION_A, [...messages.get(SESSION_A)!, buildMessage(111)]);
    act(() => { rerender({ session: { id: SESSION_A } as ProjectSession }); });
    assert.equal(result.current.visibleMessages[0].timestamp, first);
    expect(container.writes).toEqual([]);
  });

  it('ignores scroll events caused by its own bottom write', async () => {
    const messages = new Map([[SESSION_A, [buildMessage(0)]]]);
    const { result } = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store: createStore(messages) });
    const container = createContainer();
    result.current.scrollContainerRef.current = container.element;
    act(() => { result.current.scrollToBottom(); container.element.dispatchEvent(new Event('scroll')); });
    expect(result.current.isUserScrolledUp).toBe(false);
    expect(container.writes).toContain(5000);
  });

  it('does not carry a search jump into the next session', { timeout: 20_000 }, async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0)]], [SESSION_B, [buildMessage(1, '2026-01-01T00:00:05.000Z')]],
    ]);
    const searchSession = {
      id: SESSION_A, __searchTargetSnippet: 'message 0', __searchTargetTimestamp: String(buildMessage(0).timestamp),
    } as unknown as ProjectSession;
    const { result, rerender } = await renderChatSessionState({ session: searchSession, store: createStore(messages) });
    const container = createContainer();
    const row = container.addRow('2026-01-01T00:00:05.000Z', () => 4500);
    result.current.scrollContainerRef.current = container.element;
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { rerender({ session: { id: SESSION_B } as ProjectSession }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3400); });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(row.classList.contains('search-highlight-flash')).toBe(false);
  });
});
