import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { appConfigDb, getConnection, sessionsDb } from '@/modules/database/index.js';
import { getOpenCodeDatabasePath, readJsonRecord, unwrapJsonStringLiteral } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';

const DAY = 86_400_000;
const RETENTION = 14 * DAY;
const LIVE_RETENTION = 30 * 60_000;
const GRAM = 40;
const WINDOW = 16;
const HASH_BASE = 31;
const HASH_POWER = Array.from({ length: GRAM - 1 }, () => 0).reduce((power) => Math.imul(power, HASH_BASE), 1);

type ToolCall = {
  provider: LLMProvider;
  owner: string;
  agentId: string | null;
  toolUseId: string | null;
  toolName: string | null;
  calledAt: number;
  input: unknown;
};

type Candidate = {
  owner_provider: string;
  owner_provider_session_id: string;
  agent_id: string | null;
  tool_use_id: string | null;
  called_at: number;
  shared: number;
};

/** Provider synchronizers use this to make escaped shell and JSON prompt text comparable. */
export function normalizeLineageText(text: string): string {
  let normalized = text;
  // More than one quoting layer is common when a shell command is JSON-encoded.
  for (let pass = 0; pass < 3; pass += 1) {
    normalized = normalized.replace(/\\(?:u([0-9a-fA-F]{4})|([nt"'\\]))/g,
      (_match, unicode: string | undefined, escape: string | undefined) => {
        if (unicode) return String.fromCharCode(parseInt(unicode, 16));
        return escape === 'n' ? '\n' : escape === 't' ? '\t' : escape ?? '';
      });
  }
  return normalized.replace(/["'`\\]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Provider synchronizers use stable rightmost-minimum winnowing to compare prompts to tool inputs. */
export function lineageFingerprints(normalized: string): Set<number> {
  const fingerprints = new Set<number>();
  if (normalized.length < GRAM) return fingerprints;
  const width = Math.min(WINDOW, normalized.length - GRAM + 1);
  const deque: Array<{ index: number; hash: number }> = [];
  let head = 0;
  let hash = 0;
  for (let offset = 0; offset < GRAM; offset += 1) {
    hash = (Math.imul(hash, HASH_BASE) + normalized.charCodeAt(offset)) >>> 0;
  }
  for (let index = 0; index + GRAM <= normalized.length; index += 1) {
    if (index > 0) {
      hash = (Math.imul((hash - Math.imul(normalized.charCodeAt(index - 1), HASH_POWER)) >>> 0, HASH_BASE)
        + normalized.charCodeAt(index + GRAM - 1)) >>> 0;
    }
    while (deque.length > head && deque[deque.length - 1].hash >= hash) deque.pop();
    deque.push({ index, hash });
    if (index >= width - 1) {
      while (deque[head].index <= index - width) head += 1;
      fingerprints.add(deque[head].hash);
      if (head > 1024) { deque.splice(0, head); head = 0; }
    }
  }
  return fingerprints;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function time(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractClaude(row: Record<string, unknown>, owner: string, agentId: string | null): ToolCall[] {
  if (row.type !== 'assistant') return [];
  const message = record(row.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const calledAt = time(row.timestamp);
  if (calledAt === null) return [];
  return content.flatMap((entry) => {
    const block = record(entry);
    return block?.type === 'tool_use' ? [{ provider: 'claude' as const, owner, agentId,
      toolUseId: text(block.id), toolName: text(block.name), calledAt, input: block.input }] : [];
  });
}

function extractCodex(row: Record<string, unknown>, owner: string): ToolCall[] {
  if (row.type !== 'response_item') return [];
  const payload = record(row.payload);
  if (!payload || !['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(payload.type))) return [];
  const calledAt = time(row.timestamp);
  return calledAt === null ? [] : [{ provider: 'codex', owner, agentId: null,
    toolUseId: text(payload.call_id) ?? text(payload.id), toolName: text(payload.name) ?? text(payload.type),
    calledAt, input: payload.arguments ?? payload.input ?? payload.command }];
}

function firstPrompt(provider: LLMProvider, row: Record<string, unknown>): string | null {
  if (provider === 'claude' && row.type === 'user') {
    const message = record(row.message);
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((item) => record(item)).filter((item) => item?.type === 'text')
      .map((item) => text(item?.text) ?? '').join(' ');
  }
  if (provider === 'codex') {
    const payload = record(row.payload);
    if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      return (Array.isArray(payload.content) ? payload.content : []).map((item) => text(record(item)?.text) ?? '').join(' ');
    }
    if (row.type === 'event_msg' && payload?.type === 'user_message') return text(payload.message);
  }
  return null;
}

function savePrompt(provider: LLMProvider, owner: string, prompt: string, createdAt: number): void {
  if (!prompt.trim()) return;
  getConnection().prepare(`INSERT INTO session_lineage_prompts (provider, provider_session_id, prompt, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(provider, provider_session_id) DO UPDATE SET
      prompt = excluded.prompt, created_at = excluded.created_at
    WHERE excluded.created_at < session_lineage_prompts.created_at`).run(provider, owner, prompt, createdAt);
}

function callFingerprints(call: ToolCall): Set<number> {
  const normalized = normalizeLineageText(stringValues(call.input).join(' ')).slice(0, 16_000);
  return normalized.length < 80 ? new Set() : lineageFingerprints(normalized);
}

function pruneCalls(cutoff: number): void {
  const db = getConnection();
  db.prepare(`DELETE FROM session_tool_fingerprints WHERE call_id IN
    (SELECT id FROM session_tool_calls WHERE called_at < ?)`).run(cutoff);
  db.prepare('DELETE FROM session_tool_calls WHERE called_at < ?').run(cutoff);
}

function insertCalls(calls: ToolCall[]): void {
  const db = getConnection();
  const insertCall = db.prepare(`INSERT INTO session_tool_calls
    (owner_provider, owner_provider_session_id, agent_id, tool_use_id, tool_name, called_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insertFingerprint = db.prepare('INSERT INTO session_tool_fingerprints (fingerprint, call_id) VALUES (?, ?)');
  db.transaction(() => {
    const cutoff = Date.now() - LIVE_RETENTION;
    pruneCalls(cutoff);
    for (const call of calls) {
      if (call.calledAt < cutoff) continue;
      const fingerprints = callFingerprints(call);
      if (!fingerprints.size) continue;
      const id = Number(insertCall.run(call.provider, call.owner, call.agentId, call.toolUseId, call.toolName, call.calledAt).lastInsertRowid);
      for (const fingerprint of fingerprints) insertFingerprint.run(fingerprint, id);
    }
  })();
}

/** Indexes only appended complete JSONL lines; Claude sidecars belong to their containing parent directory. */
export async function indexLineageJsonl(provider: 'claude' | 'codex', filePath: string,
  backfillCall?: (call: ToolCall) => void, promptsOnly = false): Promise<void> {
  if (!filePath.endsWith('.jsonl') || filePath.split(path.sep).includes('tool-results')) return;
  const subagent = provider === 'claude' && path.basename(path.dirname(filePath)) === 'subagents';
  const agentId = subagent ? /^agent-(.+)\.jsonl$/.exec(path.basename(filePath))?.[1] ?? null : null;
  if (subagent && !agentId) return;
  const db = getConnection();
  const source = `${provider}:${filePath}`;
  const progress = db.prepare('SELECT byte_offset FROM session_lineage_progress WHERE source = ?').get(source) as { byte_offset: number } | undefined;
  let info;
  try { info = await stat(filePath); } catch { return; }
  const owner = subagent ? path.basename(path.dirname(path.dirname(filePath))) : null;
  let offset = progress && progress.byte_offset <= info.size ? progress.byte_offset : 0;
  if (offset === info.size && !backfillCall && !promptsOnly) return;
  if (backfillCall || promptsOnly) offset = 0;
  if (info.size === 0) return;
  if (offset > 0) {
    const handle = await open(filePath, 'r');
    try {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, offset - 1);
      if (previous[0] !== 10) offset = 0;
    } finally { await handle.close(); }
  }
  // Keep the byte offset at the end of the last complete line, even when a writer is mid-JSON.
  const calls: ToolCall[] = [];
  const stream = createReadStream(filePath, { start: offset, end: info.size - 1 });
  let pending = Buffer.alloc(0);
  let consumed = 0;
  let codexOwner: string | null = provider === 'codex'
    ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(filePath)?.[1] ?? null
    : null;
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        const line = pending.subarray(0, newline).toString('utf8');
        consumed += newline + 1;
        pending = pending.subarray(newline + 1);
        let row: Record<string, unknown> | null;
        try { row = record(JSON.parse(line)); } catch { row = null; }
        if (row) {
          const sessionId = owner ?? (provider === 'claude' ? text(row.sessionId) : null);
          if (provider === 'codex' && row.type === 'session_meta') {
            const payload = record(row.payload);
            if (typeof payload?.id === 'string') codexOwner = payload.id;
          }
          const actualOwner = provider === 'codex' ? codexOwner : sessionId;
          if (actualOwner) {
            for (const call of provider === 'claude' ? extractClaude(row, actualOwner, agentId) : extractCodex(row, actualOwner)) {
              if (backfillCall) backfillCall(call);
              else if (!promptsOnly) calls.push(call);
            }
            if (!subagent) {
              const prompt = firstPrompt(provider, row);
              const createdAt = time(row.timestamp) ?? info.birthtimeMs;
              if (prompt) savePrompt(provider, actualOwner, prompt, createdAt);
            }
          }
        }
        newline = pending.indexOf(10);
      }
    }
  } finally { stream.destroy(); }
  db.transaction(() => {
    if (!backfillCall && !promptsOnly) insertCalls(calls);
    db.prepare(`INSERT INTO session_lineage_progress (source, byte_offset) VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET byte_offset = excluded.byte_offset`).run(source, offset + consumed);
  })();
}

function setLineage(childProvider: string, childId: string, parentProvider: string, parentId: string,
  agentId: string | null, toolUseId: string | null, source: 'native' | 'prompt-match', score: number | null): boolean {
  if (childProvider === parentProvider && childId === parentId) return false;
  const db = getConnection();
  const child = sessionsDb.getSessionByProviderSessionId(childId, childProvider);
  if (!child || (source === 'prompt-match' && child.lineage_source) || child.lineage_source === 'native') return false;
  // A missing parent row is allowed; its provider-native identity is still useful.
  const seen = new Set([`${childProvider}:${childId}`]);
  let cursorProvider = parentProvider;
  let cursorId = parentId;
  while (cursorId) {
    const key = `${cursorProvider}:${cursorId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const ancestor = sessionsDb.getSessionByProviderSessionId(cursorId, cursorProvider);
    cursorProvider = ancestor?.parent_provider ?? '';
    cursorId = ancestor?.parent_provider_session_id ?? '';
  }
  const result = db.prepare(`UPDATE sessions SET parent_provider = ?, parent_provider_session_id = ?, parent_agent_id = ?,
    parent_tool_use_id = ?, lineage_source = ?, lineage_score = ?, lineage_checked_at = ?
    WHERE session_id = ? AND (lineage_source IS NULL OR (lineage_source = 'prompt-match' AND ? = 'native'))`)
    .run(parentProvider, parentId, agentId, toolUseId, source, score, new Date().toISOString(), child.session_id, source);
  return result.changes > 0;
}

/** Records a provider-supplied parent without allowing prompt matches to replace it. */
export function setNativeSessionLineage(provider: LLMProvider, sessionId: string, parentId: string): boolean {
  return setLineage(provider, sessionId, provider, parentId, null, null, 'native', null);
}

function rankedCandidates(candidates: Candidate[], createdAt: number, fingerprintCount: number): Candidate[] {
  return candidates.filter((candidate) => candidate.shared >= 5 && candidate.shared / fingerprintCount >= 0.5)
    .sort((a, b) => Number(a.called_at > createdAt) - Number(b.called_at > createdAt)
      || b.shared - a.shared || b.called_at - a.called_at);
}

/** Resolves one discovered child against time-bounded tool calls across every provider. */
export function resolveSessionLineage(provider: LLMProvider, sessionId: string): boolean {
  const db = getConnection();
  const child = sessionsDb.getSessionByProviderSessionId(sessionId, provider);
  if (!child || child.lineage_source) return false;
  const prompt = db.prepare(`SELECT prompt, created_at FROM session_lineage_prompts
    WHERE provider = ? AND provider_session_id = ?`).get(provider, sessionId) as { prompt: string; created_at: number } | undefined;
  if (!prompt) return false;
  const fingerprints = [...lineageFingerprints(normalizeLineageText(prompt.prompt).slice(0, 6000))];
  let linked = false;
  if (fingerprints.length >= 5) {
    const candidates = db.prepare(`SELECT owner_provider, owner_provider_session_id, agent_id, tool_use_id,
      called_at, COUNT(DISTINCT f.fingerprint) AS shared FROM session_tool_fingerprints f
      JOIN session_tool_calls c ON c.id = f.call_id
      WHERE f.fingerprint IN (SELECT value FROM json_each(?)) AND c.called_at BETWEEN ? AND ?
      GROUP BY c.id HAVING shared >= 5`).all(
      JSON.stringify(fingerprints), prompt.created_at - 600_000, prompt.created_at + 2_000) as Candidate[];
    for (const candidate of rankedCandidates(candidates, prompt.created_at, fingerprints.length)) {
      if (setLineage(provider, sessionId, candidate.owner_provider, candidate.owner_provider_session_id,
        candidate.agent_id, candidate.tool_use_id, 'prompt-match', candidate.shared / fingerprints.length)) { linked = true; break; }
    }
  }
  db.prepare('UPDATE sessions SET lineage_checked_at = ? WHERE session_id = ?')
    .run(new Date().toISOString(), child.session_id);
  return linked;
}

/** Retries recent unresolved children after a provider batch, even if their parent has no Bowcode row. */
export function retryUnresolvedLineage(): void {
  const cutoff = Date.now() - 15 * 60_000;
  const rows = getConnection().prepare(`SELECT p.provider, p.provider_session_id FROM session_lineage_prompts p
    JOIN sessions s ON s.provider = p.provider AND s.provider_session_id = p.provider_session_id
    WHERE s.lineage_source IS NULL AND p.created_at >= ?`).all(cutoff) as Array<{ provider: LLMProvider; provider_session_id: string }>;
  for (const row of rows) resolveSessionLineage(row.provider, row.provider_session_id);
  getConnection().transaction(() => pruneCalls(Date.now() - LIVE_RETENTION))();
}

/** Reads newly persisted OpenCode tool parts and first prompts from its shared SQLite store. */
export function indexOpenCodeLineage(db: Database.Database, backfillCall?: (call: ToolCall) => void,
  promptsOnly = false, cutoff = 0): void {
  const app = getConnection();
  const source = `opencode:${getOpenCodeDatabasePath()}`;
  const progress = app.prepare('SELECT last_part_id FROM session_lineage_progress WHERE source = ?')
    .get(source) as { last_part_id: string } | undefined;
  const lastRowId = backfillCall || promptsOnly ? 0 : Number(progress?.last_part_id ?? 0) || 0;
  type MessageRow = { cursor: number; id: string; session_id: string; type: string; time_created: number; data: string };
  const rows = db.prepare(`SELECT rowid AS cursor, id, session_id, type, time_created, data FROM session_message
    WHERE rowid > ? ORDER BY rowid`).iterate(lastRowId) as IterableIterator<MessageRow>;
  const calls: ToolCall[] = [];
  let lastMessageCursor: number | undefined;
  for (const row of rows) {
    lastMessageCursor = row.cursor;
    const data = readJsonRecord(row.data);
    const content = Array.isArray(data?.content) ? data.content : [];
    if (row.type === 'user') {
      const prompt = text(data?.text) ?? content.map((item) => text(record(item)?.text) ?? '').join(' ');
      if (prompt) savePrompt('opencode', row.session_id, unwrapJsonStringLiteral(prompt), row.time_created);
    }
    if (row.type === 'assistant') {
      for (const item of content) {
        const part = record(item);
        const state = record(part?.state);
        if (part?.type !== 'tool' || !state) continue;
        const call: ToolCall = { provider: 'opencode', owner: row.session_id, agentId: null,
          toolUseId: text(part.id), toolName: text(part.name), calledAt: row.time_created,
          input: state.input };
        if (backfillCall && row.time_created >= cutoff) backfillCall(call);
        else if (!backfillCall && !promptsOnly) calls.push(call);
      }
    }
  }
  // Tool parts are stored separately from session_message in current OpenCode stores.
  const hasParts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_part'").get();
  if (hasParts) {
    const partSource = `${source}:parts`;
    const partProgress = app.prepare('SELECT last_part_id FROM session_lineage_progress WHERE source = ?')
      .get(partSource) as { last_part_id: string } | undefined;
    // Rowid tracks insertion order; time_created can be older than the previous
    // part when the store finishes a delayed tool call.
    type PartRow = { cursor: number; session_id: string; call_id: string | null; time_created: number; type: string; data: string };
    const parts = db.prepare(`SELECT p.rowid AS cursor, p.session_id, p.call_id, p.time_created, p.type, p.data
      FROM session_part p WHERE p.rowid > ? ORDER BY p.rowid`)
      .iterate(backfillCall || promptsOnly ? 0 : Number(partProgress?.last_part_id ?? 0) || 0) as IterableIterator<PartRow>;
    let lastPartCursor: number | undefined;
    for (const part of parts) {
      lastPartCursor = part.cursor;
      if (part.type !== 'tool') continue;
      const data = readJsonRecord(part.data);
      const state = record(data?.state);
      if (!state) continue;
      const call: ToolCall = { provider: 'opencode', owner: part.session_id, agentId: null,
        toolUseId: part.call_id ?? text(data?.id), toolName: text(data?.tool) ?? text(data?.name),
        calledAt: part.time_created, input: state?.input };
      if (backfillCall && part.time_created >= cutoff) backfillCall(call);
      else if (!backfillCall && !promptsOnly) calls.push(call);
    }
    app.transaction(() => {
      if (!backfillCall && !promptsOnly) insertCalls(calls);
      if (lastPartCursor !== undefined) app.prepare(`INSERT INTO session_lineage_progress (source, last_part_id)
        VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_part_id = excluded.last_part_id`)
        .run(partSource, String(lastPartCursor));
      if (lastMessageCursor !== undefined) app.prepare(`INSERT INTO session_lineage_progress (source, last_part_id)
        VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_part_id = excluded.last_part_id`)
        .run(source, String(lastMessageCursor));
    })();
    return;
  }
  app.transaction(() => {
    if (!backfillCall && !promptsOnly) insertCalls(calls);
    if (lastMessageCursor !== undefined) app.prepare(`INSERT INTO session_lineage_progress (source, last_part_id)
      VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_part_id = excluded.last_part_id`)
      .run(source, String(lastMessageCursor));
  })();
}

async function recentJsonlFiles(root: string, cutoff: number): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tool-results') await visit(target);
      } else if (entry.name.endsWith('.jsonl')) {
        try { if ((await stat(target)).mtimeMs >= cutoff) found.push(target); } catch { /* file vanished */ }
      }
    }
  }
  await visit(root);
  return found;
}

/** One-time background catch-up after startup watcher initialization; never delays HTTP listen. */
export async function backfillSessionLineage(): Promise<void> {
  if (appConfigDb.get('session_lineage_backfill_v1') === 'true') return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cutoff = Date.now() - RETENTION;
  const files = new Map<'claude' | 'codex', string[]>();
  for (const provider of ['claude', 'codex'] as const) {
    const root = path.join(os.homedir(), provider === 'claude' ? '.claude/projects' : '.codex/sessions');
    files.set(provider, await recentJsonlFiles(root, cutoff));
    // Collect prompts before building the inverted index; no calls are persisted.
    for (const file of files.get(provider) ?? []) await indexLineageJsonl(provider, file, undefined, true);
  }
  let openCode: Database.Database | null = null;
  try {
    openCode = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    indexOpenCodeLineage(openCode, undefined, true);
  } catch { openCode?.close(); openCode = null; /* OpenCode may not be installed. */ }

  type Child = { provider: LLMProvider; id: string; createdAt: number; fingerprintCount: number; best: Candidate | null };
  const inverted = new Map<number, Child[]>();
  const children: Child[] = [];
  const rows = getConnection().prepare(`SELECT p.provider, p.provider_session_id, p.prompt, p.created_at
    FROM session_lineage_prompts p JOIN sessions s
      ON s.provider = p.provider AND s.provider_session_id = p.provider_session_id
    WHERE s.lineage_source IS NULL AND julianday(s.created_at) >= julianday(?)`).all(new Date(cutoff).toISOString()) as Array<{
    provider: LLMProvider; provider_session_id: string; prompt: string; created_at: number;
  }>;
  for (const row of rows) {
    const fingerprints = lineageFingerprints(normalizeLineageText(row.prompt).slice(0, 6000));
    if (fingerprints.size < 5) continue;
    const child: Child = { provider: row.provider, id: row.provider_session_id, createdAt: row.created_at,
      fingerprintCount: fingerprints.size, best: null };
    children.push(child);
    for (const fingerprint of fingerprints) {
      const matches = inverted.get(fingerprint) ?? [];
      matches.push(child);
      inverted.set(fingerprint, matches);
    }
  }
  const matchCall = (call: ToolCall): void => {
    if (call.calledAt < cutoff) return;
    const shared = new Map<Child, number>();
    for (const fingerprint of callFingerprints(call)) {
      for (const child of inverted.get(fingerprint) ?? []) {
        if (call.calledAt < child.createdAt - 600_000 || call.calledAt > child.createdAt + 2_000) continue;
        shared.set(child, (shared.get(child) ?? 0) + 1);
      }
    }
    for (const [child, count] of shared) {
      const candidate: Candidate = { owner_provider: call.provider, owner_provider_session_id: call.owner,
        agent_id: call.agentId, tool_use_id: call.toolUseId, called_at: call.calledAt, shared: count };
      if (rankedCandidates([candidate], child.createdAt, child.fingerprintCount).length &&
        (!child.best || rankedCandidates([candidate, child.best], child.createdAt, child.fingerprintCount)[0] === candidate)) {
        child.best = candidate;
      }
    }
  };
  for (const provider of ['claude', 'codex'] as const) {
    for (const file of files.get(provider) ?? []) await indexLineageJsonl(provider, file, matchCall);
  }
  if (openCode) {
    try { indexOpenCodeLineage(openCode, matchCall, false, cutoff); } finally { openCode.close(); }
  }
  for (const child of children) {
    if (!child.best) continue;
    const candidate = child.best;
    setLineage(child.provider, child.id, candidate.owner_provider, candidate.owner_provider_session_id,
      candidate.agent_id, candidate.tool_use_id, 'prompt-match', candidate.shared / child.fingerprintCount);
  }
  appConfigDb.set('session_lineage_backfill_v1', 'true');
}
