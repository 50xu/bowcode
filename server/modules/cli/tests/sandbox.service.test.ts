import assert from 'node:assert/strict';
import test from 'node:test';

import { createSandboxCommandService } from '../sandbox.service.js';

test('creates a sandbox through injected filesystem, subprocess, and clock adapters', async () => {
  const commands: string[][] = [];
  const detachedCommands: string[][] = [];
  const waits: number[] = [];
  const service = createSandboxCommandService({
    homeDirectory: '/home/user',
    fileSystem: {
      pathExists: (candidatePath) => candidatePath === '/home/user/project',
    },
    output: { log: () => undefined, error: () => undefined },
    runSandboxCommand: (argumentsList) => {
      commands.push(argumentsList);
      return argumentsList[0] === 'secret' ? 'anthropic' : '';
    },
    spawnDetachedSandbox: (argumentsList) => detachedCommands.push(argumentsList),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  const exitCode = await service.execute(['~/project']);

  assert.equal(exitCode, 0);
  assert.deepEqual(detachedCommands, [[
    'run',
    '--template',
    'docker.io/cloudcliai/sandbox:claude-code',
    '--name',
    'project',
    'claude',
    '/home/user/project',
  ]]);
  assert.deepEqual(waits, [5_000]);
  assert.ok(commands.some((argumentsList) => argumentsList.join('\0') === [
    'exec', 'project', 'bash', '-c', 'nohup bowcode start --port 3001 > /tmp/bowcode.log 2>&1 & disown',
  ].join('\0')));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'ports'));
});

test('sandbox help uses Bowcode while retaining published CloudCLI template images', async () => {
  const messages: string[] = [];
  const service = createSandboxCommandService({
    homeDirectory: '/home/user',
    fileSystem: { pathExists: () => false },
    output: { log: (message = '') => messages.push(message), error: () => undefined },
    runSandboxCommand: () => '',
    spawnDetachedSandbox: () => undefined,
    wait: async () => undefined,
  });

  assert.equal(await service.execute(['help']), 0);
  const help = messages.join('\n');
  assert.match(help, /Bowcode Sandbox/);
  assert.match(help, /bowcode sandbox ~\/my-project/);
  assert.match(help, /docker\.io\/cloudcliai\/sandbox:claude-code/);
  assert.doesNotMatch(help, /cloudcli sandbox|CloudCLI Sandbox/);
});

test('sandbox logs read the Bowcode log path', async () => {
  const commands: string[][] = [];
  const service = createSandboxCommandService({
    homeDirectory: '/home/user',
    fileSystem: { pathExists: () => false },
    output: { log: () => undefined, error: () => undefined },
    runSandboxCommand: (argumentsList) => {
      commands.push(argumentsList);
      return '';
    },
    spawnDetachedSandbox: () => undefined,
    wait: async () => undefined,
  });

  assert.equal(await service.execute(['logs', 'project']), 0);
  assert.deepEqual(commands[1], ['exec', 'project', 'bash', '-c', 'cat /tmp/bowcode.log']);
});

test('does not spawn when the workspace does not exist', async () => {
  let detachedCalls = 0;
  const service = createSandboxCommandService({
    homeDirectory: '/home/user',
    fileSystem: {
      pathExists: () => false,
    },
    output: { log: () => undefined, error: () => undefined },
    runSandboxCommand: () => '',
    spawnDetachedSandbox: () => {
      detachedCalls += 1;
    },
    wait: async () => undefined,
  });

  const exitCode = await service.execute(['/missing']);

  assert.equal(exitCode, 1);
  assert.equal(detachedCalls, 0);
});
