import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import providerRouter from '@/modules/providers/provider.routes.js';
import { claudeSettingsPermissionsService } from '@/modules/providers/services/claude-settings-permissions.service.js';
import { codexRulesService, openCodePermissionsService } from '@/modules/providers/services/provider-permission-files.service.js';

const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-permissions-'));
  const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR'];
  const previous = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  try {
    await run(home);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(home, { recursive: true, force: true });
  }
};

test('Claude edits user rules without changing unrelated or managed settings', async () => {
  await withHome(async (home) => {
    const file = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ env: { TOKEN: 'secret' }, permissions: { allow: ['Read'], defaultMode: 'plan' } }));
    await claudeSettingsPermissionsService.changeUserRule('add', 'allow', ' Bash(git status) ');
    await assert.rejects(claudeSettingsPermissionsService.changeUserRule('add', 'allow', 'Bash(git status)'));
    await assert.rejects(claudeSettingsPermissionsService.changeUserRule('add', 'allow', 'a'.repeat(501)));
    await claudeSettingsPermissionsService.changeUserRule('remove', 'allow', 'Read');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      env: { TOKEN: 'secret' }, permissions: { allow: ['Bash(git status)'], defaultMode: 'plan' },
    });
    await assert.rejects(claudeSettingsPermissionsService.changeUserRule('add', 'allow', '  '));
    await writeFile(file, '{broken');
    await assert.rejects(claudeSettingsPermissionsService.changeUserRule('add', 'allow', 'Edit'));
    assert.equal(await readFile(file, 'utf8'), '{broken');
  });
});

test('OpenCode reads JSONC and writes permission without losing unknown keys', async () => {
  await withHome(async (home) => {
    const directory = path.join(home, '.config', 'opencode');
    const file = path.join(directory, 'opencode.jsonc');
    await mkdir(directory, { recursive: true });
    await writeFile(file, '{ // note\n "plugin": ["one",], "permission": {"bash": "ask",}, "extra": {"x": true} }');
    assert.deepEqual((await openCodePermissionsService.read()).permission, { bash: 'ask' });
    await openCodePermissionsService.update({ bash: { '*': 'deny' } });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      plugin: ['one'], permission: { bash: { '*': 'deny' } }, extra: { x: true },
    });
    await assert.rejects(openCodePermissionsService.update(['invalid']));
    await writeFile(file, '{broken');
    await assert.rejects(openCodePermissionsService.update('allow'));
    assert.equal(await readFile(file, 'utf8'), '{broken');
  });
});

test('Codex saves raw files under CODEX_HOME and rejects traversal', async () => {
  await withHome(async (home) => {
    process.env.CODEX_HOME = path.join(home, 'custom');
    await codexRulesService.save('default.rules', 'prefix_rule(pattern=["git"], decision="allow")\n');
    assert.deepEqual(await codexRulesService.list(), [{ name: 'default.rules', content: 'prefix_rule(pattern=["git"], decision="allow")\n' }]);
    assert.equal((await codexRulesService.read('default.rules')).content, 'prefix_rule(pattern=["git"], decision="allow")\n');
    await assert.rejects(codexRulesService.save('../outside.rules', 'bad'));
    await assert.rejects(codexRulesService.read('..rules'));
    assert.equal(await readFile(path.join(home, 'custom', 'rules', 'default.rules'), 'utf8'), 'prefix_rule(pattern=["git"], decision="allow")\n');
  });
});

test('permission routes validate inputs and return saved data', async () => {
  await withHome(async () => {
    const app = express().use(express.json(), express.Router().use('/api/providers', providerRouter));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers`;
      const request = (url: string, method: string, data: unknown) => fetch(`${base}${url}`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
      });
      assert.equal((await request('/claude/settings-permissions/rules', 'POST', { category: 'invalid', rule: 'Read' })).status, 400);
      assert.equal((await request('/claude/settings-permissions/rules', 'POST', { category: 'allow', rule: 'Read' })).status, 200);
      assert.equal((await request('/opencode/settings-permissions', 'PUT', { permission: [] })).status, 400);
      assert.equal((await request('/opencode/settings-permissions', 'PUT', { permission: { bash: 'ask' } })).status, 200);
      assert.equal((await request('/codex/rules/default.rules', 'PUT', { content: 'raw' })).status, 200);
      assert.equal((await request('/codex/rules/default.rules', 'PUT', { content: 4 })).status, 400);
      assert.equal((await request('/codex/rules/%2E%2Eevil.rules', 'PUT', { content: 'bad' })).status, 400);
      const files = await (await fetch(`${base}/codex/rules`)).json() as { data: { files: Array<{ content: string }> } };
      assert.equal(files.data.files[0]?.content, 'raw');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
