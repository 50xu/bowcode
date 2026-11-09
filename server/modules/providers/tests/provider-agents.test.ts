import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import providerRouter from '@/modules/providers/provider.routes.js';
import { ClaudeAgentsProvider } from '@/modules/providers/list/claude/claude-agents.provider.js';
import { providerAgentsService as agents } from '@/modules/providers/services/agents.service.js';

test('provider agents: user/project list, native creation, validation, edit, delete and safe names', { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-agents-'));
  const workspacePath = path.join(root, 'workspace');
  const originalHome = os.homedir;
  const originalCodex = process.env.CODEX_HOME;
  (os as typeof os & { homedir: () => string }).homedir = () => root;
  delete process.env.CODEX_HOME;
  try {
    for (const provider of ['claude', 'codex', 'opencode']) {
      const user = await agents.create(provider, { scope: 'user', name: 'helper', description: 'A helper', model: 'test-model', instructions: 'Be useful.' });
      const project = await agents.create(provider, { scope: 'project', workspacePath, name: 'local', description: 'Local helper', instructions: 'Work locally.' });
      const source = await fs.readFile(user.filePath, 'utf8');
      assert.equal(user.model, 'test-model');
      assert.match(source, provider === 'codex' ? /developer_instructions = "Be useful\."/ : /---\n/);
      assert.match(source, /description/);
      if (provider === 'claude') assert.match(source, /name: "helper"/);
      if (provider === 'opencode') assert.match(source, /description: "A helper"/);
      const listed = await agents.list(provider, workspacePath);
      assert.deepEqual(listed.map(agent => [agent.name, agent.scope]), [['helper', 'user'], ['local', 'project']]);
      assert.equal((await agents.list(provider)).length, 1);
      assert.equal((await agents.get(provider, 'project', 'local', workspacePath)).filePath, project.filePath);
      await assert.rejects(agents.create(provider, { scope: 'user', name: 'helper', description: 'duplicate', instructions: 'Duplicate prompt.' }), { statusCode: 409 });
      await assert.rejects(agents.update(provider, 'user', 'helper', 'invalid'), { statusCode: 400 });
      assert.equal(await fs.readFile(user.filePath, 'utf8'), source);
      await agents.update(provider, 'user', 'helper', source.replace('A helper', 'Updated helper'));
      assert.equal((await agents.get(provider, 'user', 'helper')).description, 'Updated helper');
      await assert.rejects(agents.create(provider, { scope: 'user', name: '../outside', description: 'bad', instructions: '' }), { statusCode: 400 });
      await assert.rejects(agents.get(provider, 'project', 'local'), { statusCode: 400 });
      await agents.delete(provider, 'project', 'local', workspacePath);
      assert.equal((await agents.list(provider, workspacePath)).length, 1);
      await agents.delete(provider, 'user', 'helper');
    }
    const legacy = path.join(root, '.config', 'opencode', 'agent');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'old.md'), '---\ndescription: Legacy\n---\nOld prompt\n');
    await fs.writeFile(path.join(legacy, 'bad.md'), 'not frontmatter');
    assert.deepEqual((await agents.list('opencode')).map(agent => agent.name), ['old']);
    await agents.delete('opencode', 'user', 'old');
  } finally {
    (os as typeof os & { homedir: () => string }).homedir = originalHome;
    if (originalCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodex;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project root failure leaves user agents visible', { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-agent-scope-'));
  class BrokenProjectProvider extends ClaudeAgentsProvider {
    protected projectRoot(): string {
      throw new Error('Invalid workspace path');
    }
  }
  const originalHome = os.homedir;
  (os as typeof os & { homedir: () => string }).homedir = () => root;
  try {
    const provider = new BrokenProjectProvider();
    await provider.createAgent({ scope: 'user', name: 'global', description: 'Global agent', instructions: 'Help.' });
    assert.deepEqual((await provider.listAgents('/bad/workspace')).map(agent => agent.name), ['global']);
  } finally {
    (os as typeof os & { homedir: () => string }).homedir = originalHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('agent routes reject invalid create payloads before writing files', { concurrency: false }, async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-agent-route-'));
  const app = express().use(express.json(), express.Router().use('/api/providers', providerRouter));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/claude/agents`;
    const request = (body: unknown) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const valid = { scope: 'user', name: 'helper', description: 'Useful', instructions: 'Help.' };
    for (const invalid of [null, [], { ...valid, scope: [] }, { ...valid, name: {} },
      { ...valid, description: 42 }, { ...valid, instructions: [] }, { ...valid, model: {} },
      { ...valid, workspacePath: [] }, { ...valid, scope: 'project' }]) {
      assert.equal((await request(invalid)).status, 400);
    }
    const response = await request({ ...valid, scope: 'project', workspacePath, model: 'test' });
    assert.equal(response.status, 201);
    const created = await response.json() as { data: { filePath: string } };
    await fs.unlink(created.data.filePath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
