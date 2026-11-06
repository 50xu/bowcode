import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createUpdatesRouter } from '../updates.routes.js';

test('PUT /channel validates input and returns the freshly checked status', async () => {
  const channels: string[] = [];
  const service = {
    setChannel: async (channel: 'stable' | 'beta') => { channels.push(channel); return { channel, latest: '1.40.0-beta.2' }; },
  } as Parameters<typeof createUpdatesRouter>[0];
  const app = express().use(express.json()).use('/api/updates', createUpdatesRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/updates/channel`;
    for (const body of [{ channel: 'nightly' }, { channel: null }, {}]) {
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(channels, []);
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'beta' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { channel: 'beta', latest: '1.40.0-beta.2' });
    assert.deepEqual(channels, ['beta']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
