import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessageNow } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, connectedClients, runDetachedChatTurn } from '@/modules/websocket/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

async function withGateway(
  runTest: (context: {
    userId: number;
    emit: (message: Record<string, unknown>) => void;
    socket: EventEmitter & { frames: Array<Record<string, unknown>> };
    runs: string[];
    sendNow: () => Promise<void>;
    background: { active: boolean };
    runtime: Parameters<typeof runDetachedChatTurn>[1]['runtime'];
    external: { held: boolean };
    aborts: string[];
  }) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'send-queued-now-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('send-now', 'hash').id);
    sessionsDb.createAppSession('send-now-session', 'claude', directory);
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      frames: [] as Array<Record<string, unknown>>,
      send(data: string) { this.frames.push(JSON.parse(data) as Record<string, unknown>); },
    });
    const runs: string[] = [];
    const aborts: string[] = [];
    const background = { active: false };
    const external = { held: false };
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => background.active,
      getPendingApprovalsForSession: () => [],
      run: async (_provider: string, command: string, _options: unknown, writer: { send(message: unknown): void }) => {
        runs.push(command);
        writer.send({ kind: 'text', role: 'assistant', content: `reply to ${command}`, sessionId: 'send-now-session' });
      },
      abort: async (_provider: string, sessionId: string) => { aborts.push(sessionId); return true; },
    } as never;
    handleChatConnection(socket as never, { user: { id: userId } } as never, {
      runtime,
      dispatchQueuedMessageNow,
      findExternalSession: async () => external.held
        ? { providerSessionId: 'external', pid: 42, status: 'idle', startedAt: 1, cwd: directory }
        : null,
    });
    const emit = (message: Record<string, unknown>) => {
      socket.emit('message', Buffer.from(JSON.stringify(message)));
    };
    const sendNow = async () => {
      emit({ type: 'chat.send-queued-now', sessionId: 'send-now-session' });
      // The websocket message listener is async, and a resolved provider run settles on a later turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };
    await runTest({ userId, emit, socket, runs, sendNow, background, external, aborts, runtime });
  } finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('send-now with no queued message reports SEND_NOW_FAILED', async () => {
  await withGateway(async ({ socket, sendNow }) => {
    await sendNow();
    assert.equal(socket.frames.find((frame) => frame.kind === 'protocol_error')?.code, 'SEND_NOW_FAILED');
    assert.equal(socket.frames.find((frame) => frame.kind === 'protocol_error')?.error, 'Nothing queued');
  });
});

test('send-now on an idle session dispatches the queued message immediately', async () => {
  await withGateway(async ({ userId, runs, sendNow }) => {
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'send immediately' } });
    await sendNow();
    assert.deepEqual(runs, ['send immediately']);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('send-now on an externally held session still sends (the dispatch takes it over)', async () => {
  await withGateway(async ({ userId, socket, runs, sendNow, external }) => {
    sessionsDb.assignProviderSessionId('send-now-session', 'external');
    external.held = true;
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'interrupt the CLI' } });
    await sendNow();
    assert.equal(socket.frames.some((frame) => frame.code === 'SESSION_HELD_EXTERNALLY'), false);
    assert.deepEqual(runs, ['interrupt the CLI']);
  });
});

test('send-now aborts this server\'s active run before dispatch', async () => {
  await withGateway(async ({ userId, runs, sendNow, aborts }) => {
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'next turn' } });
    chatRunRegistry.startRun({
      appSessionId: 'send-now-session', provider: 'claude', providerSessionId: null, connection: null, userId,
    });
    await sendNow();
    assert.deepEqual(aborts, ['send-now-session']);
    assert.deepEqual(runs, ['next turn']);
  });
});

test('send-now supersedes held background work', async () => {
  await withGateway(async ({ userId, runs, sendNow, background }) => {
    background.active = true;
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'replace background work' } });
    await sendNow();
    assert.deepEqual(runs, ['replace background work']);
  });
});

test('a queued message sent by the server streams to the socket already showing the session', async () => {
  await withGateway(async ({ userId, socket, sendNow }) => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'send-now-session' }] })));
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'queued turn' } });
    await sendNow();
    // Before the fix the detached run had no audience, so this frame never
    // reached the open tab and the transcript only updated after a reload.
    const reply = socket.frames.find((frame) => frame.kind === 'text' && frame.content === 'reply to queued turn');
    assert.ok(reply, 'the open socket receives the queued run\'s events');
    assert.equal(reply.sessionId, 'send-now-session');
    assert.ok(socket.frames.some((frame) => frame.kind === 'complete' && frame.sessionId === 'send-now-session'));
  });
});

test('a detached queued run announces its user row once before the runtime, with split deduplicated attachments', async () => {
  await withGateway(async ({ userId, socket, emit, sendNow, runtime }) => {
    emit({ type: 'chat.subscribe', sessions: [{ sessionId: 'send-now-session' }] });
    const image = { path: path.join(getGlobalImageAssetsDir(), 'shot.png'), name: 'shot.png', mimeType: 'image/png' };
    const file = { path: path.join(getGlobalImageAssetsDir(), 'notes.txt'), name: 'notes.txt', mimeType: 'text/plain' };
    sessionDraftsDb.saveDraft(userId, 'send-now-session', {
      text: '', queuedMessage: { content: 'inspect attachments', attachments: [image, file, image] },
    });
    let framesAtRuntime: Array<Record<string, unknown>> = [];
    runtime.run = async () => { framesAtRuntime = [...socket.frames]; };

    await sendNow();

    const turns = socket.frames.filter((frame) => frame.kind === 'turn_started');
    assert.equal(turns.length, 1);
    assert.equal(typeof turns[0].seq, 'number');
    assert.equal(turns[0].sessionId, 'send-now-session');
    assert.equal(turns[0].provider, 'claude');
    assert.equal(typeof turns[0].timestamp, 'string');
    const row = turns[0].userMessage as Record<string, unknown>;
    assert.match(row.id as string, /^local_turn_[0-9a-f-]{36}$/);
    assert.equal(row.sessionId, 'send-now-session');
    assert.equal(row.provider, 'claude');
    assert.equal(row.timestamp, turns[0].timestamp);
    assert.equal(row.kind, 'text');
    assert.equal(row.role, 'user');
    assert.equal(row.content, 'inspect attachments');
    assert.deepEqual(row.images, [image]);
    assert.deepEqual(row.files, [file]);
    assert.equal(framesAtRuntime.filter((frame) => frame.kind === 'turn_started').length, 1);
  });
});

test('a detached turn omits empty attachment fields', async () => {
  await withGateway(async ({ userId, socket, emit, sendNow }) => {
    emit({ type: 'chat.subscribe', sessions: [{ sessionId: 'send-now-session' }] });
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'plain turn' } });
    await sendNow();
    const row = socket.frames.find((frame) => frame.kind === 'turn_started')?.userMessage as Record<string, unknown>;
    assert.equal(Object.hasOwn(row, 'images'), false);
    assert.equal(Object.hasOwn(row, 'files'), false);
  });
});

test('ordinary chat.send does not announce a detached turn', async () => {
  await withGateway(async ({ socket, emit }) => {
    emit({ type: 'chat.send', sessionId: 'send-now-session', content: 'ordinary turn' });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.ok(socket.frames.some((frame) => frame.kind === 'text'));
    assert.equal(socket.frames.filter((frame) => frame.kind === 'turn_started').length, 0);
  });
});

test('run-settled subscribers wait for the runtime promise, not its complete event', async () => {
  await withGateway(async ({ userId, runtime }) => {
    let releaseRuntime: (() => void) | undefined;
    const runtimeSettled = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    runtime.run = async (_provider: string, _command: string, _options: unknown, writer: { send(message: unknown): void }) => {
      writer.send({ kind: 'complete', sessionId: 'send-now-session', exitCode: 0 });
      await runtimeSettled;
    };
    const notifications: string[] = [];
    const unsubscribe = chatRunRegistry.onRunSettled((sid) => { notifications.push(sid); });
    try {
      const dispatch = runDetachedChatTurn({ sessionId: 'send-now-session', userId, content: 'wait for runtime' }, { runtime });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(notifications, [], 'complete alone does not notify listeners');
      releaseRuntime?.();
      await dispatch;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      assert.deepEqual(notifications, ['send-now-session']);
    } finally {
      releaseRuntime?.();
      unsubscribe();
    }
  });
});

test('a queued run does not stream to a tab showing another session', async () => {
  await withGateway(async ({ userId, socket, sendNow }) => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'some-other-session' }] })));
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'elsewhere' } });
    await sendNow();
    assert.equal(socket.frames.some((frame) => frame.kind === 'text' && frame.content === 'reply to elsewhere'), false);
  });
});
