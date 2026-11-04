import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('checks only local health for a restart mismatch', async () => {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ version: '1.0.0' })));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useVersionCheck());

  await waitFor(() => assert.equal(result.current.restartRequired, true));
  assert.deepEqual(fetchMock.mock.calls.map(([url]) => url), ['/health']);
});

test('keeps restart hint off when local health is unavailable', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('offline'); });
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useVersionCheck());

  await waitFor(() => assert.equal(fetchMock.mock.calls.length, 1));
  assert.equal(result.current.restartRequired, false);
});
