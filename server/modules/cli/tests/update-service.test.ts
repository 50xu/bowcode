import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdateCommand } from '../update.service.js';
import { createServiceCommand } from '../service.service.js';

test('CLI update --check tolerates missing releases, without running commands', async () => {
  const logs: string[] = [];
  const command = createUpdateCommand({
    root: '/prefix/lib/node_modules/bowcode', current: '1.38.0', platform: 'linux', uid: 1, home: '/fake',
    exists: () => false, fetchRelease: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    spawn: async () => { throw new Error('unexpected spawn'); }, exec: async () => false,
    log: (message) => logs.push(message), error: () => undefined,
  });
  assert.equal(await command(['--check']), 0);
  assert.match(logs.join(' '), /latest: none/);
});

test('CLI update installs release with explicit npm args and restarts active service', async () => {
  const commands: string[] = [];
  const command = createUpdateCommand({
    root: '/prefix/lib/node_modules/bowcode', current: '1.38.0', platform: 'linux', uid: 1, home: '/fake',
    exists: () => false, fetchRelease: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.39.0' }) }),
    spawn: async (exe, args) => { commands.push([exe, ...args].join(' ')); return 0; },
    exec: async (exe, args) => { commands.push([exe, ...args].join(' ')); return true; },
    log: () => undefined, error: () => undefined,
  });
  assert.equal(await command([]), 0);
  assert.match(commands[0], /npm install -g --prefix \/prefix https:\/\/github.com/);
  assert.match(commands[0], /--allow-scripts=bowcode,bcrypt,better-sqlite3,node-pty/);
  assert.match(commands.at(-1) || '', /restart bowcode.service/);
});

test('CLI beta check and update choose the highest valid non-draft release', async () => {
  const urls: string[] = [];
  const commands: string[] = [];
  const logs: string[] = [];
  const command = createUpdateCommand({
    root: '/prefix/lib/node_modules/bowcode', current: '1.39.0', platform: 'linux', uid: 1, home: '/fake',
    exists: () => false,
    fetchRelease: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => [
        { tag_name: 'v1.40.0-beta.2' }, { tag_name: 'v1.40.0-beta.10' },
        { tag_name: 'v1.50.0', draft: true }, { tag_name: 'invalid' },
      ] };
    },
    spawn: async (_exe, args) => { commands.push(args.join(' ')); return 0; },
    exec: async () => false, log: (message) => { logs.push(message); }, error: () => undefined,
  });
  assert.equal(await command(['--check', '--channel', 'beta']), 0);
  assert.match(logs[0], /latest: 1.40.0-beta.10/);
  assert.equal(await command(['--channel', 'beta']), 0);
  assert.match(urls[0], /releases\?per_page=30$/);
  assert.match(commands[0], /bowcode-1.40.0-beta.10.tgz/);
});

test('CLI rejects an invalid channel before fetching', async () => {
  const errors: string[] = [];
  const command = createUpdateCommand({
    root: '/prefix/lib/node_modules/bowcode', current: '1.0.0', platform: 'linux', uid: 1, home: '/fake',
    exists: () => false, fetchRelease: async () => { throw new Error('unexpected fetch'); },
    spawn: async () => 0, exec: async () => false, log: () => undefined, error: (message) => { errors.push(message); },
  });
  assert.equal(await command(['--channel', 'nightly']), 1);
  assert.match(errors[0], /Invalid channel/);
});

test('service install writes managed systemd unit and runs only injected commands', async () => {
  const commands: string[] = [];
  let unit = '';
  const command = createServiceCommand({
    platform: 'linux', home: '/fake', uid: 1, nodePath: '/bin/node', cliPath: '/bin/bowcode', pathEnv: '/bin',
    exists: () => false, read: () => '', write: (_path, value) => { unit = value; },
    mkdir: () => undefined, remove: () => undefined,
    exec: async (exe, args) => { commands.push([exe, ...args].join(' ')); return true; },
    log: () => undefined, error: () => undefined,
  });
  assert.equal(await command(['install', '--port', '4567']), 0);
  assert.match(unit, /managed-by: bowcode/);
  assert.match(unit, /ExecStart="\/bin\/node" "\/bin\/bowcode" start/);
  assert.match(unit, /SERVER_PORT=4567/);
  assert.match(commands.join(' '), /enable --now bowcode.service/);
});

test('service install does not overwrite unmanaged unit without force', async () => {
  const commands: string[] = [];
  const command = createServiceCommand({
    platform: 'linux', home: '/fake', uid: 1, nodePath: '/bin/node', cliPath: '/bin/bowcode', pathEnv: '/bin',
    exists: () => true, read: () => 'unmanaged', write: () => { throw new Error('unexpected write'); },
    mkdir: () => undefined, remove: () => undefined,
    exec: async (exe) => { commands.push(exe); return true; },
    log: () => undefined, error: () => undefined,
  });
  assert.equal(await command(['install']), 1);
  assert.deepEqual(commands, []);
});
