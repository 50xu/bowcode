import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/shared/api';

describe('api.providers.quota', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the quota from the success envelope, not the envelope itself', async () => {
    const quota = { provider: 'claude', status: 'ok', source: 'claude', planType: 'team', windows: [], fetchedAt: '2026-01-01T00:00:00.000Z' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: quota }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.providers.quota('claude', true)).resolves.toEqual(quota);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/providers/claude/quota?refresh=1');
  });
});
