import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

test('a detached turn marks the session processing, adds its user row once on replay, and reconciles the queue', () => {
  let dispatch: (event: ServerEvent) => void = () => { throw new Error('No event listener registered'); };
  const messages: NormalizedMessage[] = [];
  const processing: Array<{ sessionId: string; activity: unknown }> = [];
  const reconciled: string[] = [];
  const lastSeq = new Map<string, number>();

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (callback) => {
      dispatch = callback;
      return () => { dispatch = () => { throw new Error('Listener removed'); }; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: lastSeq },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId, activity) => { if (sessionId) processing.push({ sessionId, activity }); },
    onDetachedTurnStarted: (sessionId) => { reconciled.push(sessionId); },
    requestLatestMessages: async () => {},
    sessionStore: {
      getMessages: () => messages,
      appendRealtime: (_sessionId: string, message: NormalizedMessage) => { messages.push(message); },
    } as unknown as SessionStore,
  }));

  const started = {
    kind: 'turn_started', sessionId: 'viewed-session', provider: 'claude', seq: 3,
    timestamp: '2026-11-12T10:00:00.000Z',
    userMessage: {
      id: 'local_turn_123', sessionId: 'viewed-session', provider: 'claude',
      timestamp: '2026-11-12T10:00:00.000Z', kind: 'text', role: 'user', content: 'queued prompt',
    },
  } as unknown as ServerEvent;
  dispatch(started);
  dispatch(started);

  assert.deepEqual(processing, [
    { sessionId: 'viewed-session', activity: { statusText: null, canInterrupt: true } },
    { sessionId: 'viewed-session', activity: { statusText: null, canInterrupt: true } },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'local_turn_123');
  assert.equal(messages[0].content, 'queued prompt');
  assert.deepEqual(reconciled, ['viewed-session', 'viewed-session']);
  assert.equal(lastSeq.get('viewed-session'), 3);
});
