import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessageNow } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

async function withGateway(
  runTest: (context: {
    userId: number;
    socket: EventEmitter & { frames: Array<Record<string, unknown>> };
    runs: string[];
    sendNow: () => Promise<void>;
    background: { active: boolean };
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
    const sendNow = async () => {
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.send-queued-now', sessionId: 'send-now-session' })));
      // The websocket message listener is async, and a resolved provider run settles on a later turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };
    await runTest({ userId, socket, runs, sendNow, background, external, aborts });
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

test('a queued run does not stream to a tab showing another session', async () => {
  await withGateway(async ({ userId, socket, sendNow }) => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'some-other-session' }] })));
    sessionDraftsDb.saveDraft(userId, 'send-now-session', { text: '', queuedMessage: { content: 'elsewhere' } });
    await sendNow();
    assert.equal(socket.frames.some((frame) => frame.kind === 'text' && frame.content === 'reply to elsewhere'), false);
  });
});
