import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';

import providerRouter from '@/modules/providers/provider.routes.js';
import {
  createProviderQuotaService, parseClaudeQuota, parseCodexQuota, providerQuotaService,
} from '@/modules/providers/services/provider-quota.service.js';
import { AppError } from '@/shared/utils.js';

const fakeResponse = (body: unknown, status = 200): Response => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
}) as Response;
const noRefresh = async (): Promise<void> => {};

test('Claude limits array wins over fallback, including empty limits, and preserves scopes', () => {
  const parsed = parseClaudeQuota({ subscriptionType: 'max', limits: [
    { kind: 'session', group: 'session', percent: 35, resets_at: '2026-01-02T03:04:05Z', scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, scope: { surface: { display_name: 'Code' } } },
  ], five_hour: { utilization: 99 } }, 'claude');
  assert.equal(parsed.planType, 'max');
  assert.deepEqual(parsed.windows, [
    { id: 'session:Opus', kind: 'session', label: 'Opus', usedPercent: 35, resetsAt: '2026-01-02T03:04:05.000Z', windowMinutes: 300 },
    { id: 'weekly_scoped:Code', kind: 'weekly', label: 'Code', usedPercent: 4, resetsAt: null, windowMinutes: 10080 },
  ]);
  assert.deepEqual(parseClaudeQuota({ limits: [], five_hour: { utilization: 50 } }, 'claude').windows, []);
});

test('Claude legacy fallback skips absent buckets and maps 5h/7d model windows', () => {
  const parsed = parseClaudeQuota({ five_hour: { utilization: 12, resets_at: '2026-01-02T00:00:00Z' },
    seven_day_sonnet: { utilization: 70 }, seven_day_opus: null }, 'claude');
  assert.deepEqual(parsed.windows.map((row) => [row.id, row.kind, row.label, row.windowMinutes]), [
    ['five_hour', 'session', null, 300], ['seven_day_sonnet', 'weekly', 'Sonnet', 10080],
  ]);
});

test('Codex maps main and distinct named buckets with second-based reset times', () => {
  const main = { limitId: 'codex', primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1767225600 },
    secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1767830400 } };
  const parsed = parseCodexQuota({ account: { account: { type: 'chatgpt', planType: 'plus' } }, rateLimits: {
    rateLimits: main, rateLimitsByLimitId: { codex: main, spark: { limitId: 'spark', limitName: 'Spark',
      primary: { usedPercent: 90, windowDurationMins: 60, resetsAt: 1767225600 } } },
  } });
  assert.equal(parsed.planType, 'plus');
  assert.deepEqual(parsed.windows.map((row) => [row.id, row.kind, row.label, row.resetsAt]), [
    ['main:primary', 'session', null, '2026-01-01T00:00:00.000Z'],
    ['main:secondary', 'weekly', null, '2026-01-08T00:00:00.000Z'],
    ['spark:primary', 'session', 'Spark', '2026-01-01T00:00:00.000Z'],
  ]);
  assert.equal(parseCodexQuota({ account: { account: { type: 'apiKey' } } }).status, 'unsupported');
  assert.equal(parseCodexQuota({ account: { account: null } }).status, 'unauthenticated');
});

test('quota service caches for 60 seconds, deduplicates in-flight reads and refreshes', async () => {
  let clock = 1_767_225_600_000;
  let calls = 0;
  let finish!: (value: Response) => void;
  const service = createProviderQuotaService({ now: () => clock, refreshClaudeLogin: noRefresh,
    readClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'secret' } }),
    fetch: (() => { calls++; return new Promise<Response>((resolve) => { finish = resolve; }); }) as typeof fetch,
  });
  const first = service.getQuota('claude');
  const second = service.getQuota('claude', { refresh: true });
  assert.equal(calls, 0); // Credential read runs in a microtask.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish(fakeResponse({ limits: [] }));
  assert.deepEqual(await first, await second);
  const cached = await service.getQuota('claude');
  assert.equal(calls, 1);
  assert.equal(cached.fetchedAt, '2026-01-01T00:00:00.000Z');
  clock += 60_001;
  const expired = service.getQuota('claude');
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish(fakeResponse({ limits: [] }));
  await expired;
  assert.equal(calls, 2);
  const refresh = service.getQuota('claude', { refresh: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish(fakeResponse({ limits: [] }));
  await refresh;
  assert.equal(calls, 3);
});

test('Claude expired OAuth refreshes through the CLI before fetching; API key alone is unsupported', async () => {
  let credentials = { claudeAiOauth: { accessToken: 'old', expiresAt: 1_000 } };
  let refreshCalls = 0;
  let authorization: string | undefined;
  const refreshed = createProviderQuotaService({
    now: () => 2_000,
    readClaudeCredentials: async () => credentials,
    refreshClaudeLogin: async () => {
      refreshCalls++;
      credentials = { claudeAiOauth: { accessToken: 'new', expiresAt: 100_000 } };
    },
    fetch: (async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
      return fakeResponse({ limits: [] });
    }) as typeof fetch,
  });
  assert.equal((await refreshed.getQuota('claude')).status, 'ok');
  assert.equal(refreshCalls, 1);
  assert.equal(authorization, 'Bearer new');

  let fetchCalls = 0;
  const unchanged = createProviderQuotaService({
    now: () => 2_000,
    readClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'old', expiresAt: 1_000 } }),
    refreshClaudeLogin: noRefresh,
    fetch: (() => { fetchCalls++; return Promise.reject(new Error('unexpected')); }) as typeof fetch,
  });
  assert.equal((await unchanged.getQuota('claude')).status, 'unauthenticated');
  assert.equal(fetchCalls, 0);

  const failed = createProviderQuotaService({
    now: () => 2_000,
    readClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'old', expiresAt: 1_000 } }),
    refreshClaudeLogin: async () => { throw new Error('refresh failed'); },
    fetch: (() => { fetchCalls++; return Promise.reject(new Error('unexpected')); }) as typeof fetch,
  });
  assert.equal((await failed.getQuota('claude')).status, 'unauthenticated');
  assert.equal(fetchCalls, 0);

  const key = createProviderQuotaService({
    now: () => 2_000,
    env: { ANTHROPIC_API_KEY: 'secret' },
    readClaudeCredentials: async () => null,
    refreshClaudeLogin: noRefresh,
    fetch: (() => { fetchCalls++; return Promise.reject(new Error('unexpected')); }) as typeof fetch,
  });
  assert.equal((await key.getQuota('claude')).message, 'Quota only applies to Claude subscription logins');
  assert.equal(fetchCalls, 0);
});

test('Claude 401 refreshes once and retries only when the file token changes', async () => {
  let credentials = { claudeAiOauth: { accessToken: 'old' } };
  const authorizations: string[] = [];
  let refreshCalls = 0;
  const refreshed = createProviderQuotaService({
    readClaudeCredentials: async () => credentials,
    refreshClaudeLogin: async () => {
      refreshCalls++;
      credentials = { claudeAiOauth: { accessToken: 'new' } };
    },
    fetch: (async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
      return authorizations.length === 1 ? fakeResponse({}, 401) : fakeResponse({ limits: [] });
    }) as typeof fetch,
  });
  assert.equal((await refreshed.getQuota('claude')).status, 'ok');
  assert.equal(refreshCalls, 1);
  assert.deepEqual(authorizations, ['Bearer old', 'Bearer new']);

  let unchangedFetchCalls = 0;
  const unchanged = createProviderQuotaService({
    readClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'same' } }),
    refreshClaudeLogin: noRefresh,
    fetch: (async () => { unchangedFetchCalls++; return fakeResponse({}, 401); }) as typeof fetch,
  });
  assert.equal((await unchanged.getQuota('claude')).status, 'unauthenticated');
  assert.equal(unchangedFetchCalls, 1);
});

test('Claude environment OAuth token never triggers login refresh', async () => {
  let refreshCalls = 0;
  let authorization: string | undefined;
  const service = createProviderQuotaService({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'environment-token' },
    readClaudeCredentials: async () => null,
    refreshClaudeLogin: async () => { refreshCalls++; },
    fetch: (async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
      return fakeResponse({}, 401);
    }) as typeof fetch,
  });
  assert.equal((await service.getQuota('claude')).status, 'unauthenticated');
  assert.equal(refreshCalls, 0);
  assert.equal(authorization, 'Bearer environment-token');
  assert.equal((await createProviderQuotaService({ refreshClaudeLogin: noRefresh }).getQuota('opencode')).status, 'unsupported');
});

test('quota route validates provider and refresh query and wraps the service result', async () => {
  const original = providerQuotaService.getQuota;
  const calls: unknown[] = [];
  providerQuotaService.getQuota = async (provider, options) => {
    calls.push([provider, options]);
    return { provider, status: 'ok', source: 'test', planType: null, windows: [], fetchedAt: '2026-01-01T00:00:00.000Z' };
  };
  const app = express().use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers`;
    const response = await fetch(`${base}/claude/quota?refresh=1`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { source: string } }).data.source, 'test');
    assert.deepEqual(calls, [['claude', { refresh: true }]]);
    assert.equal((await fetch(`${base}/invalid/quota`)).status, 400);
    assert.equal((await fetch(`${base}/codex/quota?refresh=true`)).status, 400);
    assert.equal(calls.length, 1);
  } finally {
    providerQuotaService.getQuota = original;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a transient error keeps the last good snapshot', async () => {
  let status = 200;
  const service = createProviderQuotaService({
    now: () => 1_000,
    refreshClaudeLogin: noRefresh,
    readClaudeCredentials: async () => ({ claudeAiOauth: { accessToken: 'tok', expiresAt: 999_999 } }),
    fetch: (async () => status === 200
      ? fakeResponse({ limits: [{ kind: 'session', group: 'session', percent: 40 }] })
      : fakeResponse({}, status)) as typeof fetch,
  });
  const first = await service.getQuota('claude');
  status = 429;
  const second = await service.getQuota('claude', { refresh: true });
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.windows, first.windows);
});
