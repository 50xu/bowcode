import assert from 'node:assert/strict';
import test from 'node:test';

import type { query } from '@anthropic-ai/claude-agent-sdk';

import { generateSessionTitle } from '@/modules/providers/services/session-title.service.js';

function stub(events: unknown[] = [], failure?: Error): typeof query {
  return (() => (async function* () {
    for (const event of events) yield event;
    if (failure) throw failure;
  })()) as unknown as typeof query;
}

const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('title generation bounds inputs and sanitises the assistant output', async () => {
  let received: unknown;
  const run = ((params: unknown) => {
    received = params;
    return stub([assistant('  **“Repair the broken login flow.”**\n')])({} as never);
  }) as unknown as typeof query;
  assert.equal(await generateSessionTitle({ userMessages: Array(4).fill('x'.repeat(3000)), assistantReply: 'y'.repeat(2000) }, run), 'Repair the broken login flow');
  const input = received as { prompt: string; options: Record<string, unknown> };
  assert.equal(JSON.parse(input.prompt).userMessages.length, 3);
  assert.equal(JSON.parse(input.prompt).userMessages[0].length, 2000);
  assert.equal(JSON.parse(input.prompt).assistantReply.length, 1000);
  assert.equal(input.options.persistSession, false);
  assert.deepEqual(input.options.settingSources, []);
});

test('title generation returns null on empty output and SDK failure', async () => {
  assert.equal(await generateSessionTitle({ userMessages: ['hello'] }, stub()), null);
  assert.equal(await generateSessionTitle({ userMessages: ['hello'] }, stub([], new Error('offline'))), null);
});
