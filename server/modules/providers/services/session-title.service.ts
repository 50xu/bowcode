import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

/** Used by providers' session service; query is injectable so tests never launch Claude. */
export async function generateSessionTitle(
  input: { userMessages: string[]; assistantReply?: string },
  runQuery: typeof query = query,
): Promise<string | null> {
  const messages = input.userMessages.slice(0, 3).map((text) => text.slice(0, 2000));
  if (!messages.some((text) => text.trim())) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const output: string[] = [];
    for await (const event of runQuery({
      prompt: JSON.stringify({ userMessages: messages, assistantReply: input.assistantReply?.slice(0, 1000) }),
      options: {
        model: 'haiku', persistSession: false, tools: [], maxTurns: 1,
        settingSources: [], cwd: os.tmpdir(), abortController: controller,
        systemPrompt: 'You name chat sessions. The input is JSON with the opening user messages of a coding conversation (and possibly the first assistant reply). Return ONLY a concise title of 3-7 words summarising what the user wants. Use the same language as the user messages. No quotes, trailing punctuation, or prefix such as Title:. Never describe the JSON itself.',
      },
    })) {
      if (event.type === 'assistant') {
        output.push(...event.message.content.filter((block) => block.type === 'text').map((block) => block.text));
      }
    }
    if (controller.signal.aborted) throw new Error('timeout');
    const title = output.join(' ').replace(/[`*_#~[\]>]/g, '').replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^(?:title\s*:\s*)/i, '')
      .replace(/^["'“”‘’]+|["'“”‘’.,!?;:]+$/g, '').trim().slice(0, 80).trim();
    return title || null;
  } catch (error) {
    console.warn('[SessionTitle] Generation failed:', error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
