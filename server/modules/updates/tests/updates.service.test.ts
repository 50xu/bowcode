import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdatesService } from '../updates.service.js';

function harness(overrides: { git?: boolean; service?: boolean; fail?: boolean } = {}) {
  let now = 0;
  let fetches = 0;
  let locked = false;
  const calls: string[] = [];
  const service = createUpdatesService({
    current: '1.38.0', applicationRoot: '/prefix/lib/node_modules/bowcode', homeDirectory: '/fake-home',
    platform: 'linux', uid: 1000, now: () => now, cliPath: '/prefix/bin/bowcode',
    fetchRelease: async () => {
      fetches += 1;
      if (overrides.fail) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.39.0', html_url: 'https://example.test/release' }) };
    },
    exists: (p) => p.endsWith('.git') ? !!overrides.git : p.endsWith('.service') && !!overrides.service,
    mkdir: (p) => { calls.push(`mkdir ${p}`); },
    openExclusive: () => { if (locked) throw new Error('locked'); locked = true; },
    remove: () => { locked = false; },
    openLog: () => 12, closeLog: () => undefined,
    spawnDetached: (_command, args) => { calls.push(args.join(' ')); },
  });
  return { service, calls, setNow: (value: number) => { now = value; }, getFetches: () => fetches };
}

test('caches release metadata for 15 minutes and reports update availability', async () => {
  const h = harness({ service: true });
  const first = await h.service.check();
  assert.equal(first.latest, '1.39.0');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.canSelfUpdate, true);
  await h.service.check();
  assert.equal(h.getFetches(), 1);
  h.setNow(900_001);
  await h.service.check();
  assert.equal(h.getFetches(), 2);
});

test('a forced check bypasses a fresh cache', async () => {
  const h = harness();
  await h.service.check();
  await h.service.check({ force: true });
  assert.equal(h.getFetches(), 2);
});

test('failed checks are cached briefly so a transient error does not hide releases', async () => {
  const h = harness({ fail: true });
  await h.service.check();
  await h.service.check();
  assert.equal(h.getFetches(), 1);
  h.setNow(60_001);
  await h.service.check();
  assert.equal(h.getFetches(), 2);
});

test('reports fetch failure without failing GET and refuses git or unmanaged updates', async () => {
  const h = harness({ fail: true, git: true });
  assert.equal((await h.service.check()).latest, null);
  assert.equal((await h.service.check()).error, 'offline');
  assert.throws(() => h.service.apply(), /managed service/);
});

test('starts one detached update using an exclusive lock', () => {
  const h = harness({ service: true });
  assert.deepEqual(h.service.apply(), { started: true });
  assert.match(h.calls.join(' '), /update/);
  assert.throws(() => h.service.apply(), /locked/);
});
