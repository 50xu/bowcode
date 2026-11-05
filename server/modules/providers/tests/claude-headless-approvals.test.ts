import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

type CanUseTool = (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => Promise<{ behavior: string; message?: string }>;

/**
 * Starts a Claude run against a stand-in SDK query that ends at once, and
 * hands back the `canUseTool` callback the runtime built for it.
 */
async function captureCanUseTool(options: Record<string, unknown>): Promise<{ canUseTool: CanUseTool; sent: NormalizedMessage[]; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-headless-'));
  const sent: NormalizedMessage[] = [];
  let canUseTool: CanUseTool | null = null;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: ({ options: sdkOptions }) => {
      canUseTool = (sdkOptions as { canUseTool: CanUseTool }).canUseTool;
      const iterator = (async function* () { /* no messages */ })();
      return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} }) as never;
    },
  };
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  await queryClaudeSDK('hello', { sessionId: 'headless-session', cwd, ...options }, writer as never, context);
  assert.ok(canUseTool, 'the runtime never built canUseTool');
  return { canUseTool, sent, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test('a headless run denies AskUserQuestion and ExitPlanMode at once instead of waiting forever', async () => {
  const { canUseTool, sent, cleanup } = await captureCanUseTool({ headless: true, permissionMode: 'default' });
  try {
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      const decision = await canUseTool(tool, {});
      assert.equal(decision.behavior, 'deny');
      assert.match(decision.message ?? '', /No user is attached/);
    }
    assert.equal(sent.filter((message) => message.kind === 'permission_request').length, 0);
  } finally {
    await cleanup();
  }
});

test('an interactive run still asks the user for AskUserQuestion', async () => {
  const { canUseTool, sent, cleanup } = await captureCanUseTool({ permissionMode: 'default' });
  const controller = new AbortController();
  try {
    const pending = canUseTool('AskUserQuestion', {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.filter((message) => message.kind === 'permission_request').length, 1);
    controller.abort();
    await pending;
  } finally {
    await cleanup();
  }
});
