import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import { api } from '@/shared/api';
import type { ServerEvent } from '@/shared/types';

function listResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const SCHEDULE = { id: 'sch-1', name: 'Nightly', enabled: true, lastStatus: null };

afterEach(() => {
  vi.restoreAllMocks();
});

test('the schedules list is read again when the server announces schedules_changed', async () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const list = vi.spyOn(api.schedules, 'list')
    .mockResolvedValueOnce(listResponse([]))
    .mockResolvedValue(listResponse([SCHEDULE]));

  const { result } = renderHook(() => useSchedules(subscribe));
  await waitFor(() => assert.equal(result.current.isLoading, false));
  assert.equal(result.current.schedules.length, 0);

  // Unrelated frames do not trigger a read.
  act(() => listeners.forEach((listener) => listener({ kind: 'session_upserted' })));
  assert.equal(list.mock.calls.length, 1);

  act(() => listeners.forEach((listener) => listener({ kind: 'schedules_changed' })));
  await waitFor(() => assert.equal(result.current.schedules.length, 1));
  assert.equal(list.mock.calls.length, 2);
});

test('a refused mutation rethrows the server message and still re-reads the list', async () => {
  vi.spyOn(api.schedules, 'list').mockResolvedValue(listResponse([]));
  vi.spyOn(api.schedules, 'runNow').mockResolvedValue(new Response(
    JSON.stringify({ success: false, error: { code: 'SCHEDULE_ALREADY_RUNNING', message: 'This schedule is already running.' } }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  ));

  const { result } = renderHook(() => useSchedules());
  await waitFor(() => assert.equal(result.current.isLoading, false));

  await assert.rejects(() => result.current.runScheduleNow('sch-1'), /already running/);
});
