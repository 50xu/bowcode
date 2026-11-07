import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { LLMProvider, ProviderQuota, ProviderQuotaWindow } from '@/shared/types.js';
import { getOpenCodeDatabasePath, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type RecordValue = Record<string, unknown>;
type QuotaData = Pick<ProviderQuota, 'status' | 'source' | 'planType' | 'windows' | 'message'>;
type QuotaDependencies = {
  now?: () => number;
  fetch?: typeof fetch;
  readClaudeCredentials?: () => Promise<unknown>;
  readOpenCodeCredentials?: () => Array<{ integrationId: string | null; value: unknown }>;
  readCodexRateLimits?: () => Promise<{ account: unknown; rateLimits: unknown }>;
  env?: NodeJS.ProcessEnv;
};

const record = (value: unknown): RecordValue | null => readObjectRecord(value) as RecordValue | null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const iso = (value: unknown, seconds = false): string | null => {
  const millis = typeof value === 'string' && !seconds ? Date.parse(value) :
    number(value) === null ? NaN : (value as number) * (seconds ? 1000 : 1);
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : null;
};
const status = (kind: QuotaData['status'], source: string | null, message?: string): QuotaData => ({
  status: kind, source, planType: null, windows: [], ...(message ? { message } : {}),
});

/** Parses Claude's limits array (including an empty array) or its legacy usage buckets; reused by OpenCode OAuth. */
export function parseClaudeQuota(value: unknown, source: string): QuotaData {
  const body = record(value);
  if (!body) return status('error', source, 'Invalid Claude quota response');
  const windows: ProviderQuotaWindow[] = [];
  if (Array.isArray(body.limits)) {
    for (const raw of body.limits) {
      const row = record(raw);
      if (!row || !['session', 'weekly_all', 'weekly_scoped'].includes(String(row.kind))) continue;
      const scope = record(row.scope);
      const label = readOptionalString(record(scope?.model)?.display_name)
        ?? readOptionalString(record(scope?.surface)?.display_name) ?? null;
      const kind = row.group === 'session' || row.group === 'weekly' ? row.group :
        row.kind === 'session' ? 'session' : 'weekly';
      windows.push({
        id: `${row.kind}${label ? `:${label}` : ''}`, kind, label,
        usedPercent: number(row.percent), resetsAt: iso(row.resets_at), windowMinutes: kind === 'session' ? 300 : 10080,
      });
    }
  } else {
    for (const [key, kind, label, minutes] of [
      ['five_hour', 'session', null, 300],
      ['seven_day', 'weekly', null, 10080],
      ['seven_day_opus', 'weekly', 'Opus', 10080],
      ['seven_day_sonnet', 'weekly', 'Sonnet', 10080],
    ] as const) {
      const row = record(body[key]);
      if (!row) continue;
      windows.push({ id: key, kind, label, usedPercent: number(row.utilization),
        resetsAt: iso(row.resets_at), windowMinutes: minutes });
    }
  }
  return { status: 'ok', source, planType: readOptionalString(body.subscriptionType) ?? null, windows };
}

/** Fetches Claude subscription usage for either Claude Code or an OpenCode Claude OAuth login. */
export async function fetchClaudeQuota(token: string, source: string, fetcher: typeof fetch, signal: AbortSignal): Promise<QuotaData> {
  const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal,
  });
  if (response.status === 401 || response.status === 403) return status('unauthenticated', source, 'Claude subscription login is no longer authorized');
  if (!response.ok) return status('error', source, `Claude quota request failed (${response.status})`);
  return parseClaudeQuota(await response.json(), source);
}

/** Normalizes Codex app-server account and all distinct rate-limit snapshots. */
export function parseCodexQuota(value: unknown): QuotaData {
  const outer = record(value);
  const account = record(record(outer?.account)?.account);
  if (!account) return status('unauthenticated', 'codex', 'Sign in to Codex to view quota');
  if (account.type === 'apiKey') return status('unsupported', 'codex', 'Quota only applies to Codex subscription logins');
  if (account.type !== 'chatgpt') return status('unsupported', 'codex', 'Codex account does not expose subscription quota');
  const response = record(outer?.rateLimits);
  const main = record(response?.rateLimits);
  if (!main) return status('error', 'codex', 'Invalid Codex rate limit response');
  const windows: ProviderQuotaWindow[] = [];
  const addSnapshot = (snapshot: RecordValue, label: string | null, id: string) => {
    for (const slot of ['primary', 'secondary'] as const) {
      const window = record(snapshot[slot]);
      if (!window) continue;
      const duration = number(window.windowDurationMins);
      windows.push({ id: `${id}:${slot}`, kind: duration !== null && duration <= 1440 ? 'session' : 'weekly',
        label, usedPercent: number(window.usedPercent), resetsAt: iso(window.resetsAt, true), windowMinutes: duration });
    }
  };
  addSnapshot(main, null, 'main');
  for (const [id, raw] of Object.entries(record(response?.rateLimitsByLimitId) ?? {})) {
    const snapshot = record(raw);
    if (!snapshot || (main.limitId != null && snapshot.limitId === main.limitId) || snapshot === main) continue;
    addSnapshot(snapshot, readOptionalString(snapshot.limitName) ?? null, id);
  }
  return { status: 'ok', source: 'codex', planType: readOptionalString(account.planType) ?? readOptionalString(main.planType) ?? null, windows };
}

/** Parses the ChatGPT usage endpoint's two windows; malformed payloads report error rather than fake zero usage. */
export function parseOpenAIQuota(value: unknown, source: string): QuotaData {
  const body = record(value);
  const limit = record(body?.rate_limit);
  if (!limit) return status('error', source, 'Invalid OpenAI quota response');
  const windows: ProviderQuotaWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const row = record(limit[`${slot}_window`]);
    if (!row) continue;
    const duration = number(row.limit_window_seconds);
    if (number(row.used_percent) === null || duration === null || !iso(row.reset_at, true)) {
      return status('error', source, 'Invalid OpenAI quota window');
    }
    windows.push({ id: slot, kind: duration <= 86400 ? 'session' : 'weekly', label: null,
      usedPercent: number(row.used_percent), resetsAt: iso(row.reset_at, true), windowMinutes: duration / 60 });
  }
  if (!windows.length) return status('error', source, 'OpenAI quota windows are missing');
  return { status: 'ok', source, planType: readOptionalString(body?.plan_type) ?? null, windows };
}

function defaultOpenCodeCredentials(): Array<{ integrationId: string | null; value: unknown }> {
  let db: Database.Database | null = null;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    return db.prepare(`SELECT integration_id AS integrationId, value FROM credential
      WHERE active IS NULL OR active != 0 ORDER BY time_created`).all() as Array<{ integrationId: string | null; value: unknown }>;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Creates an isolated quota service with injectable I/O and clock for deterministic provider tests. */
export function createProviderQuotaService(deps: QuotaDependencies = {}) {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const readClaudeCredentials = deps.readClaudeCredentials ?? (async () => {
    try { return JSON.parse(await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  });
  const readCredentials = deps.readOpenCodeCredentials ?? defaultOpenCodeCredentials;
  const readCodex = deps.readCodexRateLimits ?? (() => codexAppServer.readCodexRateLimits());
  const cache = new Map<LLMProvider, { data: ProviderQuota; expires: number }>();
  const pending = new Map<LLMProvider, Promise<ProviderQuota>>();

  /** Reads Claude Code's own login; OpenCode's `claude-cli-install` credential borrows the same login. */
  const loadClaude = async (source: string, signal: AbortSignal): Promise<QuotaData> => {
    const oauth = record(record(await readClaudeCredentials())?.claudeAiOauth);
    const fileToken = readOptionalString(oauth?.accessToken);
    const token = fileToken ?? readOptionalString(env.CLAUDE_CODE_OAUTH_TOKEN);
    if (!token) return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
      ? status('unsupported', source, 'Quota only applies to Claude subscription logins')
      : status('unauthenticated', source, 'Sign in to Claude to view quota');
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : Date.parse(String(oauth?.expiresAt ?? ''));
    if (fileToken && Number.isFinite(expiresAt) && expiresAt <= now()) {
      return status('unauthenticated', source, 'Claude token expired; token refreshes on the next Claude run');
    }
    const result = await fetchClaudeQuota(token, source, fetcher, signal);
    // The usage endpoint does not report the plan; the credentials file does.
    return result.status === 'ok' && fileToken
      ? { ...result, planType: readOptionalString(oauth?.subscriptionType) ?? result.planType }
      : result;
  };

  const load = async (provider: LLMProvider, signal: AbortSignal): Promise<QuotaData> => {
    if (provider === 'claude') return loadClaude('claude', signal);
    if (provider === 'codex') return parseCodexQuota(await readCodex());
    const credentials = readCredentials();
    for (const credential of credentials) {
      const integration = credential.integrationId?.toLowerCase();
      if (integration !== 'claude-code' && integration !== 'anthropic' && integration !== 'openai') continue;
      const source = `opencode:${integration}`;
      let value: unknown = credential.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value) as unknown; }
        catch { continue; } // One malformed credential must not hide another active integration.
      }
      const auth = record(value);
      const token = readOptionalString(auth?.accessToken) ?? readOptionalString(auth?.access_token)
        ?? readOptionalString(auth?.access) ?? readOptionalString(auth?.token);
      if (!token || (auth?.type !== undefined && auth.type !== 'oauth')) continue;
      if (integration !== 'openai') {
        const result = await fetchClaudeQuota(token, source, fetcher, signal);
        // A `claude-code` credential imported from the Claude CLI keeps a stale
        // copy of its token; OpenCode reuses the CLI login at run time, so read that.
        return result.status === 'unauthenticated' && integration === 'claude-code'
          ? loadClaude(source, signal)
          : result;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const accountId = readOptionalString(auth?.accountId);
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', { headers, signal });
      if (response.status === 401 || response.status === 403) return status('unauthenticated', source, 'OpenCode login is no longer authorized');
      if (!response.ok) return status('error', source, `OpenAI quota request failed (${response.status})`);
      return parseOpenAIQuota(await response.json(), source);
    }
    return status('unsupported', 'opencode', 'OpenCode provider does not expose quota');
  };

  return {
    /** Resolves quota once per provider for 60 seconds; refresh bypasses cached snapshots, not an in-flight read. */
    getQuota(provider: LLMProvider, options: { refresh?: boolean } = {}): Promise<ProviderQuota> {
      const running = pending.get(provider);
      if (running) return running;
      const cached = cache.get(provider);
      if (!options.refresh && cached && cached.expires > now()) return Promise.resolve(cached.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const request = (async () => {
        let result: QuotaData;
        try { result = await load(provider, controller.signal); }
        catch { result = status('error', provider, 'Could not read provider quota'); }
        finally { clearTimeout(timer); }
        // A transient failure (e.g. the usage endpoint's 429) keeps the last good
        // snapshot on screen instead of blanking it; its fetchedAt shows its age.
        const previous = cache.get(provider)?.data;
        if (result.status === 'error' && previous?.status === 'ok') {
          cache.set(provider, { data: previous, expires: now() + 60_000 });
          return previous;
        }
        const data: ProviderQuota = { provider, ...result, fetchedAt: new Date(now()).toISOString() };
        cache.set(provider, { data, expires: now() + 60_000 });
        return data;
      })();
      pending.set(provider, request);
      void request.finally(() => { if (pending.get(provider) === request) pending.delete(provider); });
      return request;
    },
  };
}

/** Shared instance consumed by the Providers HTTP route. */
export const providerQuotaService = createProviderQuotaService();
