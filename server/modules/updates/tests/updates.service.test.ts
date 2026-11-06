import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdatesService } from '../updates.service.js';

function harness(overrides: { git?: boolean; service?: boolean; fail?: boolean; channel?: 'stable' | 'beta'; releases?: Array<{ tag_name?: string; draft?: boolean; html_url?: string }> } = {}) {
  let now = 0;
  let channel = overrides.channel ?? 'stable';
  let locked = false;
  const calls: string[] = [];
  const urls: string[] = [];
  const service = createUpdatesService({
    current: '1.38.0', applicationRoot: '/prefix/lib/node_modules/bowcode', homeDirectory: '/fake-home',
    platform: 'linux', uid: 1000, now: () => now, cliPath: '/prefix/bin/bowcode',
    getChannel: () => channel, setChannel: (value) => { channel = value; },
    fetchRelease: async (url) => {
      urls.push(url);
      if (overrides.fail) throw new Error('offline');
      return { ok: true, status: 200, json: async () => url.includes('per_page')
        ? overrides.releases ?? [{ tag_name: 'v1.40.0-beta.2' }]
        : { tag_name: 'v1.39.0', html_url: 'https://example.test/release' } };
    },
    exists: (p) => p.endsWith('.git') ? !!overrides.git : p.endsWith('.service') && !!overrides.service,
    mkdir: (p) => { calls.push(`mkdir ${p}`); },
    openExclusive: () => { if (locked) throw new Error('locked'); locked = true; },
    remove: () => { locked = false; },
    openLog: () => 12, closeLog: () => undefined,
    spawnDetached: (_command, args) => { calls.push(args.join(' ')); },
  });
  return { service, calls, urls, setNow: (value: number) => { now = value; }, getFetches: () => urls.length };
}

test('defaults to stable and caches release metadata for 15 minutes', async () => {
  const h = harness({ service: true });
  const first = await h.service.check();
  assert.equal(first.channel, 'stable');
  assert.equal(first.latest, '1.39.0');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.canSelfUpdate, true);
  assert.match(h.urls[0], /releases\/latest$/);
  await h.service.check();
  assert.equal(h.getFetches(), 1);
  h.setNow(900_001);
  await h.service.check();
  assert.equal(h.getFetches(), 2);
});

test('beta selects the highest valid non-draft release and caches separately', async () => {
  const h = harness({ releases: [
    { tag_name: 'v1.40.0-beta.2' }, { tag_name: 'invalid' },
    { tag_name: 'v1.40.0-beta.10', html_url: 'https://example.test/beta' },
    { tag_name: 'v1.50.0', draft: true }, { tag_name: 'v1.39.5' },
  ] });
  assert.equal((await h.service.check()).latest, '1.39.0');
  const beta = await h.service.setChannel('beta');
  assert.equal(beta.channel, 'beta');
  assert.equal(beta.latest, '1.40.0-beta.10');
  assert.equal(beta.releaseUrl, 'https://example.test/beta');
  assert.match(h.urls[1], /releases\?per_page=30$/);
  await h.service.check();
  assert.equal(h.getFetches(), 2);
  await h.service.setChannel('stable');
  assert.equal(h.getFetches(), 3);
});

test('a forced check bypasses a fresh cache', async () => {
  const h = harness();
  await h.service.check();
  await h.service.check({ force: true });
  assert.equal(h.getFetches(), 2);
});

test('failed checks are cached briefly', async () => {
  const h = harness({ fail: true });
  await h.service.check();
  await h.service.check();
  assert.equal(h.getFetches(), 1);
  h.setNow(60_001);
  await h.service.check();
  assert.equal(h.getFetches(), 2);
});

test('reports fetch failure and refuses git or unmanaged updates', async () => {
  const h = harness({ fail: true, git: true });
  assert.equal((await h.service.check()).latest, null);
  assert.equal((await h.service.check()).error, 'offline');
  await assert.rejects(h.service.apply(), /managed service/);
});

test('apply pins the current channel target and uses an exclusive lock', async () => {
  const h = harness({ service: true, channel: 'beta' });
  assert.deepEqual(await h.service.apply(), { started: true });
  assert.ok(h.calls.includes('/prefix/bin/bowcode update --version 1.40.0-beta.2'));
  await assert.rejects(h.service.apply(), /locked/);
  assert.equal(h.getFetches(), 1);
});

test('apply refuses when no release target exists', async () => {
  const h = harness({ service: true, channel: 'beta', releases: [{ tag_name: 'invalid' }] });
  await assert.rejects(h.service.apply(), /No valid release/);
  assert.equal(h.calls.length, 0);
});
