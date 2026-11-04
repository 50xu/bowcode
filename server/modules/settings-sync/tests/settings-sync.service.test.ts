import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';

import { createSettingsSyncService, redactMcp, restoreMcp, validateSyncConfig } from '../settings-sync.service.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

test('validates credential-free remotes and categories', () => {
  assert.equal(validateSyncConfig({ repoUrl: 'git@github.com:org/settings.git' }).branch, 'main');
  assert.equal(validateSyncConfig({ repoUrl: 'https://github.com/org/settings.git' }).include.claudeConfig, false);
  assert.throws(() => validateSyncConfig({ repoUrl: 'https://token@github.com/org/settings.git' }));
  assert.throws(() => validateSyncConfig({ repoUrl: 'https://github.com/org/settings.git', branch: '../evil' }));
  assert.throws(() => validateSyncConfig({ repoUrl: 'https://github.com/org/settings.git', include: { mcp: 'true' } }));
});

test('redacts every MCP env/header value and restores only matching local credentials', () => {
  const input = [{ name: 'svc', env: { PUBLIC: 'still-private' }, headers: { Authorization: 'secret' }, envHttpHeaders: { custom: 'value' } }];
  const redacted = redactMcp(input) as typeof input;
  assert.equal(redacted[0].env.PUBLIC, '<redacted>');
  assert.equal(redacted[0].headers.Authorization, '<redacted>');
  assert.equal(redacted[0].envHttpHeaders.custom, '<redacted>');
  assert.deepEqual(restoreMcp(redacted, input), input);
  assert.equal((restoreMcp(redacted, []) as typeof input)[0].env.PUBLIC, '');
});

test('push and pull use isolated bare remote, category files and preserve local MCP credentials', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sync-fixture-'));
  try {
    const remote = path.join(temp, 'remote.git');
    git(temp, 'init', '--bare', remote);
    let config: string | null = null;
    let applied: Record<string, unknown> = {};
    const sources = {
      readConfig: () => config,
      writeConfig: (value: string) => { config = value; },
      deleteConfig: () => { config = null; },
      databasePath: () => path.join(temp, 'auth.db'),
      token: () => null,
      capture: async () => ({ preferences: { theme: 'dark' }, notifications: {}, providerModels: [], plugins: {}, gitIdentity: { name: 'Example', email: 'example@local' }, mcp: { claude: [{ name: 'server', env: { SECRET: 'local-value' } }] } }),
      apply: async (_userId: number, snapshot: Record<string, unknown>) => { applied = snapshot; return { missingPlugins: [] }; },
    };
    const service = createSettingsSyncService(sources);
    service.saveConfig({ repoUrl: remote });
    await service.push(1, { viewport: 'wide' });
    const root = path.join(temp, 'settings-sync', 'repo');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'app', 'preferences.json'), 'utf8')), { theme: 'dark' });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'app', 'client.json'), 'utf8')), { viewport: 'wide' });
    assert.equal(JSON.parse(await readFile(path.join(root, 'mcp', 'claude.json'), 'utf8'))[0].env.SECRET, '<redacted>');
    assert.match(git(remote, 'rev-parse', 'refs/heads/main'), /^[a-f0-9]{40}$/);
    const pulled = await service.pull(1);
    assert.deepEqual(pulled.client, { viewport: 'wide' });
    assert.deepEqual((applied.mcp as { claude: Array<{ env: { SECRET: string } }> }).claude[0].env, { SECRET: 'local-value' });
    assert.equal((await service.getConfig()).cloned, true);
    await service.deleteConfig();
    assert.equal((await service.getConfig()).cloned, false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
