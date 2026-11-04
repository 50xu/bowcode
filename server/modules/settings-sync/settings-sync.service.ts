import { mkdir, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { AppError } from '@/shared/utils.js';

type Category = 'preferences' | 'mcp' | 'providerModels' | 'notifications' | 'plugins' | 'gitIdentity' | 'claudeConfig';
type Include = Record<Category, boolean>;
type Config = { repoUrl: string; branch: string; githubTokenId: number | null; include: Include; lastSyncAt: string | null; lastAction: 'push' | 'pull' | null; lastError: string | null; lastCommit: string | null };
type Sources = {
  readConfig(): string | null; writeConfig(value: string): void; deleteConfig(): void; databasePath(): string;
  token(userId: number, id: number): string | null;
  capture(userId: number): Promise<Record<string, unknown>>;
  apply(userId: number, snapshot: Record<string, unknown>): Promise<{ missingPlugins: string[] }>;
  readClaude?(): Promise<Record<string, string>>;
  writeClaude?(files: Record<string, string>): Promise<void>;
};
const categories: Category[] = ['preferences', 'mcp', 'providerModels', 'notifications', 'plugins', 'gitIdentity', 'claudeConfig'];
const files: Record<Exclude<Category, 'mcp' | 'claudeConfig'>, string> = {
  preferences: 'app/preferences.json', notifications: 'app/notification-preferences.json',
  providerModels: 'app/provider-models.json', plugins: 'app/plugins.json', gitIdentity: 'app/git-identity.json',
};
const appClient = 'app/client.json';
const mcpNames = ['claude', 'codex', 'opencode'];
const failure = (message: string, code = 'INVALID_SYNC_CONFIG', statusCode = 400) => new AppError(message, { code, statusCode });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
const encode = (value: unknown) => JSON.stringify(sorted(value), null, 2) + '\n';

/** Validate remote and branch without allowing embedded credentials, flags or unsafe ref names. */
export function validateSyncConfig(input: unknown, previous?: Config): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('Invalid sync config');
  const data = input as Record<string, unknown>;
  if (typeof data.repoUrl !== 'string') throw failure('Repository URL is required');
  const repoUrl = data.repoUrl.trim();
  if (repoUrl.startsWith('-') || /[\s\x00-\x1f]/.test(repoUrl)) throw failure('Invalid repository URL');
  if (repoUrl.startsWith('https://')) {
    let url: URL;
    try { url = new URL(repoUrl); } catch { throw failure('Invalid repository URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || !url.pathname || url.pathname === '/') throw failure('Use a credential-free HTTPS URL');
  } else if (repoUrl.startsWith('ssh://')) {
    let url: URL;
    try { url = new URL(repoUrl); } catch { throw failure('Invalid repository URL'); }
    if (url.protocol !== 'ssh:' || url.password || url.search || url.hash || !url.hostname || !url.pathname || url.pathname === '/') throw failure('Invalid SSH URL');
  } else if (!/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(repoUrl) && !path.isAbsolute(repoUrl)) throw failure('Use HTTPS, SSH, scp-style SSH or an absolute local repository path');
  const branch = data.branch === undefined ? previous?.branch ?? 'main' : data.branch;
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || /(?:\.\.|@\{|\/\/|[\s~^:?*\\\[\]\x00-\x1f])/.test(branch)) throw failure('Invalid branch');
  const githubTokenId = data.githubTokenId === undefined ? previous?.githubTokenId ?? null : data.githubTokenId;
  if (githubTokenId !== null && (!Number.isSafeInteger(githubTokenId) || Number(githubTokenId) <= 0)) throw failure('Invalid GitHub token ID');
  const provided = data.include === undefined ? {} : object(data.include);
  if (data.include !== undefined && (data.include === null || Array.isArray(data.include) || typeof data.include !== 'object')) throw failure('Invalid categories');
  if (Object.keys(provided).some((key) => !categories.includes(key as Category))) throw failure('Invalid category');
  const include = Object.fromEntries(categories.map((key) => {
    if (provided[key] !== undefined && typeof provided[key] !== 'boolean') throw failure('Invalid category option');
    return [key, provided[key] ?? previous?.include[key] ?? (key !== 'claudeConfig')];
  })) as Include;
  return { repoUrl, branch, githubTokenId: githubTokenId as number | null, include,
    lastSyncAt: previous?.lastSyncAt ?? null, lastAction: previous?.lastAction ?? null,
    lastError: previous?.lastError ?? null, lastCommit: previous?.lastCommit ?? null };
}

/** Strip every MCP value in credential-bearing maps, regardless of key spelling. */
export function redactMcp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMcp);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['env', 'headers', 'envHttpHeaders'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).map((name) => [name, '<redacted>'])) : redactMcp(item)]));
}

/** Keep matching local MCP secrets; new remote redacted keys become empty strings. */
export function restoreMcp(incoming: unknown, local: unknown): unknown {
  if (incoming === '<redacted>') return typeof local === 'string' ? local : '';
  if (Array.isArray(incoming)) return incoming.map((item, index) => {
    const current = Array.isArray(local) && item && typeof item === 'object' && typeof object(item).name === 'string'
      ? local.find((candidate) => object(candidate).name === object(item).name) : Array.isArray(local) ? local[index] : undefined;
    return restoreMcp(item, current);
  });
  if (!incoming || typeof incoming !== 'object') return incoming;
  const current = object(local);
  return Object.fromEntries(Object.entries(incoming).map(([key, item]) => [key, restoreMcp(item, current[key])]));
}

/** Strips the injected token and any `user:pass@` URL credentials from git output. */
function redactGitOutput(text: string, token: string | null): string {
  let result = text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
  if (token) result = result.split(token).join('***');
  return result.slice(0, 500);
}

async function present(file: string) { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function git(args: string[], cwd: string, token: string | null): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CLOUDCLI_GITHUB_TOKEN"; }; f', CLOUDCLI_GITHUB_TOKEN: token });
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.on('error', (error) => reject(failure(`git ${args[0]} failed: ${redactGitOutput(error.message, token)}`, 'SYNC_GIT_ERROR', 502)));
    child.on('close', (code) => {
      if (code === 0) { resolve(output.trim()); return; }
      // Surface git's own reason (auth failure, non-fast-forward, missing repo)
      // so the user can act on it, with any credential material stripped.
      const detail = redactGitOutput(errorOutput.trim().split('\n').slice(-3).join(' '), token);
      reject(failure(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`, 'SYNC_GIT_ERROR', 502));
    });
  });
}
async function writeJson(root: string, file: string, value: unknown) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, encode(value), { mode: 0o600 });
}
async function readJson(root: string, file: string) { return JSON.parse(await readFile(path.join(root, file), 'utf8')) as unknown; }

/** Serialized sync orchestration; dependency-injected data sources allow isolated Git fixture tests. */
export function createSettingsSyncService(sources: Sources) {
  let busy = false;
  const repo = () => path.join(path.dirname(sources.databasePath()), 'settings-sync', 'repo');
  const current = () => { const raw = sources.readConfig(); return raw ? validateSyncConfig(JSON.parse(raw), JSON.parse(raw) as Config) : null; };
  const exclusive = async <T>(fn: () => Promise<T>) => {
    if (busy) throw failure('Settings sync is already running', 'SYNC_BUSY', 409);
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };
  const run = (userId: number, direction: 'push' | 'pull', client?: unknown) => exclusive(async () => {
    const config = current();
    if (!config) throw failure('Settings sync is not configured', 'SYNC_NOT_CONFIGURED');
    try {
      if (direction === 'push' && client !== undefined && (!client || typeof client !== 'object' || Array.isArray(client) || Buffer.byteLength(JSON.stringify(client), 'utf8') > 256 * 1024)) throw failure('Client settings must be an object of at most 256KB');
      const token = config.githubTokenId === null ? null : sources.token(userId, config.githubTokenId);
      if (config.githubTokenId !== null && !token) throw failure('GitHub token not found', 'GITHUB_TOKEN_NOT_FOUND', 404);
      const root = repo();
      await mkdir(path.dirname(root), { recursive: true });
      if (await present(path.join(root, '.git')) && await git(['remote', 'get-url', 'origin'], root, token) !== config.repoUrl) {
        if (await git(['status', '--porcelain'], root, token)) throw failure('Settings checkout has uncommitted changes', 'SYNC_DIRTY', 409);
        await rm(root, { recursive: true, force: true });
      }
      if (!await present(path.join(root, '.git'))) {
        if (await present(root)) await rm(root, { recursive: true, force: true });
        // Probe first: only a genuinely absent branch permits init. Authentication
        // or connectivity failures must not silently become a new empty repository.
        const branchRef = await git(['ls-remote', '--heads', config.repoUrl, config.branch], path.dirname(root), token);
        if (branchRef) await git(['clone', '--branch', config.branch, '--', config.repoUrl, root], path.dirname(root), token);
        else {
          await mkdir(root, { recursive: true });
          await git(['init', '-b', config.branch], root, token);
          await git(['remote', 'add', 'origin', config.repoUrl], root, token);
        }
      }
      if (await git(['status', '--porcelain'], root, token)) throw failure('Settings checkout has uncommitted changes', 'SYNC_DIRTY', 409);
      // A branch with no remote ref is a normal first push, not an error.
      const remoteBranch = await git(['ls-remote', '--heads', 'origin', config.branch], root, token);
      const localBranch = await git(['branch', '--list', config.branch], root, token);
      if (await git(['branch', '--show-current'], root, token) !== config.branch) {
        await git(localBranch ? ['checkout', config.branch] : ['checkout', '-b', config.branch], root, token);
      }
      if (remoteBranch) await git(['pull', '--rebase', 'origin', config.branch], root, token);
      if (direction === 'push') {
        const snapshot = await sources.capture(userId);
        for (const [category, file] of Object.entries(files) as Array<[keyof typeof files, string]>) if (config.include[category]) await writeJson(root, file, snapshot[category] ?? {});
        if (config.include.preferences) await writeJson(root, appClient, client ?? {});
        if (config.include.mcp) for (const name of mcpNames) await writeJson(root, `mcp/${name}.json`, redactMcp(object(snapshot.mcp)[name] ?? {}));
        // Rewritten from scratch so files deleted locally disappear from the repo too.
        if (config.include.claudeConfig && sources.readClaude) await rm(path.join(root, 'claude'), { recursive: true, force: true });
        if (config.include.claudeConfig && sources.readClaude) for (const [file, text] of Object.entries(await sources.readClaude())) {
          if (!/^(?:CLAUDE\.md|settings\.json|(?:agents|commands|skills)\/[\w.-]+(?:\/[\w.-]+)*)$/.test(file) || Buffer.byteLength(text, 'utf8') > 512 * 1024) continue;
          const output = file === 'settings.json' ? encode(Object.fromEntries(Object.entries(object(JSON.parse(text))).filter(([key]) => key !== 'env'))) : text;
          const dest = path.join(root, 'claude', file);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, output, { mode: 0o600 });
        }
        if (!await present(path.join(root, 'README.md'))) await writeFile(path.join(root, 'README.md'), '# CloudCLI Settings Sync\n\nSensitive MCP values are redacted. Keep this repository private.\n');
        await git(['add', '-A'], root, token);
        if (await git(['status', '--porcelain'], root, token)) {
          const identity = object(snapshot.gitIdentity);
          await git(['-c', `user.name=${typeof identity.name === 'string' && identity.name ? identity.name : 'CloudCLI Settings Sync'}`, '-c', `user.email=${typeof identity.email === 'string' && identity.email ? identity.email : 'settings-sync@localhost'}`, 'commit', '-m', `settings: sync from ${os.hostname()}`], root, token);
          await git(['push', '-u', 'origin', config.branch], root, token);
        }
      } else {
        if (!remoteBranch) throw failure('The configured branch has no settings to pull', 'SYNC_EMPTY_REMOTE', 404);
        const snapshot: Record<string, unknown> = {};
        for (const [category, file] of Object.entries(files) as Array<[keyof typeof files, string]>) if (config.include[category] && await present(path.join(root, file))) snapshot[category] = await readJson(root, file);
        let clientSettings: unknown = null;
        if (config.include.preferences && await present(path.join(root, appClient))) clientSettings = await readJson(root, appClient);
        if (config.include.mcp) {
          const local = object((await sources.capture(userId)).mcp);
          snapshot.mcp = {};
          for (const name of mcpNames) if (await present(path.join(root, `mcp/${name}.json`))) (snapshot.mcp as Record<string, unknown>)[name] = restoreMcp(await readJson(root, `mcp/${name}.json`), local[name]);
        }
        if (config.include.claudeConfig && sources.writeClaude && await present(path.join(root, 'claude'))) {
          const claude: Record<string, string> = {};
          const visit = async (directory: string) => { for (const entry of await readdir(path.join(root, 'claude', directory), { withFileTypes: true })) {
            const relative = path.posix.join(directory, entry.name);
            if (entry.isDirectory() && /^(agents|commands|skills)(?:\/[\w.-]+)*$/.test(relative)) await visit(relative);
            else if (entry.isFile() && /^(?:CLAUDE\.md|settings\.json|(?:agents|commands|skills)\/[\w.-]+(?:\/[\w.-]+)*)$/.test(relative)) {
              const file = path.join(root, 'claude', relative);
              if ((await lstat(file)).size <= 512 * 1024) claude[relative] = await readFile(file, 'utf8');
            }
          } };
          await visit('');
          await sources.writeClaude(claude);
        }
        const result = await sources.apply(userId, snapshot);
        config.lastSyncAt = new Date().toISOString(); config.lastAction = direction; config.lastError = null;
        config.lastCommit = await git(['rev-parse', '--short', 'HEAD'], root, token).catch(() => null);
        sources.writeConfig(JSON.stringify(config));
        return { client: clientSettings, applied: Object.keys(snapshot), missingPlugins: result.missingPlugins };
      }
      config.lastSyncAt = new Date().toISOString(); config.lastAction = direction; config.lastError = null;
      config.lastCommit = await git(['rev-parse', '--short', 'HEAD'], root, token);
      sources.writeConfig(JSON.stringify(config));
      return { success: true, commit: config.lastCommit };
    } catch (error) {
      config.lastError = error instanceof AppError ? error.message : 'Settings sync failed';
      sources.writeConfig(JSON.stringify(config));
      throw error;
    }
  });
  return {
    getConfig: async () => ({ config: current(), cloned: await present(path.join(repo(), '.git')) }),
    saveConfig: (input: unknown) => { const value = validateSyncConfig(input, current() ?? undefined); sources.writeConfig(JSON.stringify(value)); return value; },
    deleteConfig: () => exclusive(async () => { sources.deleteConfig(); await rm(path.dirname(repo()), { recursive: true, force: true }); return { success: true }; }),
    push: (userId: number, client?: unknown) => run(userId, 'push', client),
    pull: (userId: number) => run(userId, 'pull'),
  };
}

/** Read opt-in regular Claude files no larger than 512KB, never following symlinks. */
export async function readClaudeFiles(home = os.homedir()): Promise<Record<string, string>> {
  const base = path.join(home, '.claude');
  const output: Record<string, string> = {};
  const visit = async (relative: string) => {
    const directory = path.join(base, relative);
    if (!await present(directory) || !(await lstat(directory)).isDirectory()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && (/^(agents|commands|skills)$/.test(file) || /^(agents|commands|skills)\/[\w.-]+(?:\/[\w.-]+)*$/.test(file))) await visit(file);
      else if (entry.isFile() && (file === 'CLAUDE.md' || file === 'settings.json' || /^(agents|commands|skills)\/[\w.-]+(?:\/[\w.-]+)*$/.test(file))) {
        const stat = await lstat(path.join(base, file));
        if (stat.size <= 512 * 1024) output[file] = await readFile(path.join(base, file), 'utf8');
      }
    }
  };
  await visit('');
  return output;
}
