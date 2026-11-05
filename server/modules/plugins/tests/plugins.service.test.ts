import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createPluginsRouter } from '../plugins.routes.js';
import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null, getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin', dirName: 'plugin' }),
    update: async () => ({ name: 'plugin', dirName: 'plugin' }),
    uninstall: async () => undefined, startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false, joinPath: (...parts) => parts.join('/'),
    logError: () => undefined, ...overrides,
  };
}

test('Express 5 plugin asset and RPC wildcards preserve nested paths and query strings', async () => {
  const assetPaths: string[] = [];
  const upstreamPaths: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamPaths.push(request.url ?? '');
    response.end('proxied');
  });
  const service = createPluginsService(dependencies({
    getPluginDirectory: () => '/plugins/demo',
    resolveAsset: (_name, assetPath) => {
      assetPaths.push(assetPath);
      return 'package.json';
    },
    assetIsFile: () => true,
    joinPath: (...parts) => parts.join('/'),
    getServerPort: () => (upstream.address() as { port: number }).port,
  }));
  const app = express().use('/api/plugins', createPluginsRouter(service));
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/api/plugins/demo/assets/nested/logo.svg`);
    const rpc = await fetch(`${base}/api/plugins/demo/rpc/nested/action?key=value`);
    assert.equal(rpc.status, 200);
    assert.equal(await rpc.text(), 'proxied');
    assert.deepEqual(assetPaths, ['nested/logo.svg']);
    assert.deepEqual(upstreamPaths, ['/nested/action?key=value']);
  } finally {
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
  }
});

test('update restarts a running plugin server when the update fails', async () => {
  const operations: string[] = [];
  let running = true;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: 'server.js' }],
    getPluginDirectory: () => '/plugins/demo',
    isServerRunning: () => running,
    stopServer: async () => { operations.push('stop'); running = false; },
    update: async () => { operations.push('pull'); throw new Error('git pull failed'); },
    startServer: async () => { operations.push('start'); running = true; return 4000; },
  }));
  await assert.rejects(service.update('demo'), /git pull failed/);
  assert.deepEqual(operations, ['stop', 'pull', 'start']);
});

test('a failed update does not start a plugin server that was not running', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: 'server.js' }],
    getPluginDirectory: () => '/plugins/demo',
    update: async () => { operations.push('pull'); throw new Error('git pull failed'); },
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await assert.rejects(service.update('demo'), /git pull failed/);
  assert.deepEqual(operations, ['pull']);
});

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['save', 'start']);
});
