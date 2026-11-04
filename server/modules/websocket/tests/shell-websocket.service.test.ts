import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: string[]; send: (frame: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (frame) => socket.frames.push(frame);
  return socket;
}

function fakePty() {
  let onData: (chunk: string) => void = () => undefined;
  return {
    killed: false,
    writes: [] as string[],
    emitData(chunk: string) { onData(chunk); },
    onData(callback: (chunk: string) => void) { onData = callback; return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
    write(chunk: string) { this.writes.push(chunk); },
    resize() {},
    kill() { this.killed = true; },
  };
}

test('spawns the user login shell in the requested project without launching an agent', () => {
  const calls: Array<{ shell: string; args: string[]; cwd: string }> = [];
  const processHandle = fakePty();
  const socket = fakeSocket();
  handleShellConnection(socket as never, { spawnPty: (shell, args, options) => {
    calls.push({ shell, args: Array.isArray(args) ? args : [args], cwd: options.cwd ?? '' });
    return processHandle as never;
  } });
  socket.emit('message', JSON.stringify({ type: 'init', terminalId: 'login', projectPath: process.cwd(), provider: 'claude', initialCommand: 'claude --resume old' }));
  assert.deepEqual(calls, [{ shell: os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash', args: os.platform() === 'win32' ? [] : ['-l'], cwd: process.cwd() }]);
  socket.emit('message', JSON.stringify({ type: 'kill' }));
  assert.equal(processHandle.killed, true);
});

test('different terminal IDs have independent PTYs and reconnect to the matching one', () => {
  const processes = [fakePty(), fakePty()];
  let spawned = 0;
  const deps = { spawnPty: () => processes[spawned++] as never };
  const attach = (terminalId: string) => {
    const socket = fakeSocket();
    handleShellConnection(socket as never, deps);
    socket.emit('message', JSON.stringify({ type: 'init', projectPath: process.cwd(), terminalId }));
    return socket;
  };
  const first = attach('one');
  const second = attach('two');
  processes[0].emitData('first output');
  const replacement = attach('one');
  first.emit('close');
  processes[0].emitData('more output');
  assert.equal(spawned, 2);
  assert.ok(replacement.frames.some((frame) => frame.includes('first output')));
  assert.ok(replacement.frames.some((frame) => frame.includes('more output')));
  assert.ok(!second.frames.some((frame) => frame.includes('first output')));
  replacement.emit('message', JSON.stringify({ type: 'kill' }));
  second.emit('message', JSON.stringify({ type: 'kill' }));
  assert.equal(processes[0].killed, true);
  assert.equal(processes[1].killed, true);
});

test('invalid or non-directory cwd falls back to home', () => {
  const paths: string[] = [];
  const handles: ReturnType<typeof fakePty>[] = [];
  const deps = { spawnPty: (_shell: string, _args: string | string[], options: { cwd?: string }) => {
    paths.push(options.cwd ?? '');
    const handle = fakePty();
    handles.push(handle);
    return handle as never;
  } };
  for (const [index, projectPath] of [path.join(os.tmpdir(), 'terminal-absent-directory-xyz'), import.meta.filename].entries()) {
    const socket = fakeSocket();
    handleShellConnection(socket as never, deps);
    socket.emit('message', JSON.stringify({ type: 'init', terminalId: `bad-${index}`, projectPath }));
    socket.emit('message', JSON.stringify({ type: 'kill' }));
  }
  assert.deepEqual(paths, [os.homedir(), os.homedir()]);
  assert.ok(handles.every((handle) => handle.killed));
});

test('rejects malformed terminal IDs without spawning a PTY', () => {
  const socket = fakeSocket();
  let spawned = false;
  handleShellConnection(socket as never, { spawnPty: () => { spawned = true; return fakePty() as never; } });
  socket.emit('message', JSON.stringify({ type: 'init', terminalId: '../invalid', projectPath: process.cwd() }));
  assert.equal(spawned, false);
  assert.match(socket.frames[0], /Invalid terminal ID/);
});
