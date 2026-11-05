import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { SessionRetentionSettings } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createSessionRetentionRouter } from '../session-retention.routes.js';

type Service = Parameters<typeof createSessionRetentionRouter>[0];

async function withServer(
  service: Partial<Service>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express().use(express.json()).use('/api/session-retention', createSessionRetentionRouter(service as Service));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code } });
      return;
    }
    res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-retention`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function put(url: string, body: unknown): Promise<globalThis.Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('PUT /settings passes only the validated fields to the service', async () => {
  const patches: Array<Partial<SessionRetentionSettings>> = [];
  await withServer({
    updateSettings: (patch) => {
      patches.push(patch);
      return { settings: { enabled: true, inactiveDays: 90, action: 'delete', skipStarredProjects: false }, lastRun: null };
    },
  }, async (baseUrl) => {
    const response = await put(`${baseUrl}/settings`, {
      enabled: true, inactiveDays: 90, action: 'delete', skipStarredProjects: false, extra: 'ignored',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(patches, [{ enabled: true, inactiveDays: 90, action: 'delete', skipStarredProjects: false }]);
  });
});

test('PUT /settings rejects invalid values without calling the service', async () => {
  let called = false;
  await withServer({
    updateSettings: () => { called = true; return { settings: {} as SessionRetentionSettings, lastRun: null }; },
  }, async (baseUrl) => {
    for (const body of [
      { inactiveDays: 0 },
      { inactiveDays: 1.5 },
      { inactiveDays: '30' },
      { inactiveDays: 3651 },
      { action: 'purge' },
      { enabled: 'true' },
      { skipStarredProjects: 1 },
      [],
    ]) {
      const response = await put(`${baseUrl}/settings`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      const payload = await response.json() as { error: { code: string } };
      assert.equal(payload.error.code, 'INVALID_SESSION_RETENTION_SETTINGS');
    }
  });
  assert.equal(called, false);
});

test('GET /preview and POST /run return the service result in the success envelope', async () => {
  await withServer({
    preview: async () => ({ total: 3 }) as unknown as Awaited<ReturnType<Service['preview']>>,
    runNow: async () => ({ archived: 2 }) as unknown as Awaited<ReturnType<Service['runNow']>>,
  }, async (baseUrl) => {
    assert.deepEqual(await (await fetch(`${baseUrl}/preview`)).json(), { success: true, data: { total: 3 } });
    assert.deepEqual(
      await (await fetch(`${baseUrl}/run`, { method: 'POST' })).json(),
      { success: true, data: { archived: 2 } },
    );
  });
});
