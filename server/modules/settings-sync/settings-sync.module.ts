import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appConfigDb, getConnection, getDatabasePath, githubTokensDb, notificationPreferencesDb, providerModelsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { getPluginsConfig, savePluginsConfig, scanPlugins } from '@/modules/plugins/index.js';
import { providerMcpService, providerModelsService } from '@/modules/providers/index.js';
import type { LLMProvider, ProviderMcpServer } from '@/shared/types.js';

import { createSettingsSyncRouter } from './settings-sync.routes.js';
import { createSettingsSyncService, readClaudeFiles } from './settings-sync.service.js';

const KEY = 'settings_sync_config';
async function readJson(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
const providers: LLMProvider[] = ['claude', 'codex', 'opencode'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const service = createSettingsSyncService({
  readConfig: () => appConfigDb.get(KEY),
  writeConfig: (value) => appConfigDb.set(KEY, value),
  deleteConfig: () => { getConnection().prepare('DELETE FROM app_config WHERE key = ?').run(KEY); },
  databasePath: getDatabasePath,
  token: (userId, id) => githubTokensDb.getGithubTokenById(userId, id)?.github_token ?? null,
  capture: async (userId) => {
    const preferences = userPreferencesDb.getPreferences(userId);
    const identity = userDb.getGitConfig(userId);
    const models = providers.flatMap((provider) => providerModelsDb.listCustomProviderModels(provider).map(({ provider: p, modelId, model, effort }) => ({ provider: p, id: modelId, model, effort })));
    const mcp: Record<string, unknown> = {};
    for (const name of providers) {
      mcp[name] = await providerMcpService.listProviderMcpServersForScope(name, 'user');
    }
    return {
      preferences, notifications: notificationPreferencesDb.getPreferences(userId),
      providerModels: models, plugins: Object.fromEntries((scanPlugins() as Array<{ name: string; enabled: boolean }>).map(({ name, enabled }) => [name, { enabled }])), 
      gitIdentity: { name: identity?.git_name ?? null, email: identity?.git_email ?? null }, mcp,
    };
  },
  readClaude: () => readClaudeFiles(),
  writeClaude: async (files) => {
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(os.homedir(), '.claude', relative);
      if (relative === 'settings.json') {
        const previous = await readJson(file);
        const incoming = JSON.parse(text) as Record<string, unknown>;
        await writeJson(file, { ...incoming, ...(previous.env ? { env: previous.env } : {}) });
      } else {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text, { mode: 0o600 });
      }
    }
  },
  apply: async (userId, snapshot) => {
    if (snapshot.preferences && typeof snapshot.preferences === 'object' && !Array.isArray(snapshot.preferences)) {
      userPreferencesDb.savePreferences(userId, object(snapshot.preferences));
    }
    if (snapshot.notifications && typeof snapshot.notifications === 'object') notificationPreferencesDb.updatePreferences(userId, object(snapshot.notifications));
    const identity = object(snapshot.gitIdentity);
    if (typeof identity.name === 'string' && typeof identity.email === 'string') userDb.updateGitConfig(userId, identity.name, identity.email);
    const missingPlugins: string[] = [];
    if (snapshot.plugins && typeof snapshot.plugins === 'object' && !Array.isArray(snapshot.plugins)) {
      const installed = object(getPluginsConfig());
      const available = new Set((scanPlugins() as Array<{ name: string }>).map((plugin) => plugin.name));
      for (const [name, options] of Object.entries(snapshot.plugins)) {
        if (!available.has(name)) { missingPlugins.push(name); continue; }
        const enabled = (options as Record<string, unknown>)?.enabled;
        if (typeof enabled === 'boolean') installed[name] = { ...object(installed[name]), enabled };
      }
      savePluginsConfig(installed);
    }
    if (Array.isArray(snapshot.providerModels)) {
      const desired = new Set<string>();
      for (const entry of snapshot.providerModels) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        if (!providers.includes(row.provider as LLMProvider) || typeof row.id !== 'string' || typeof row.model !== 'string' || !row.id.trim() || !row.model.trim()) continue;
        const provider = row.provider as LLMProvider;
        desired.add(`${provider}:${row.id}`);
        const input = { id: row.id, model: row.model };
        const existing = providerModelsDb.findCustomProviderModelByModelId(provider, row.id);
        if (existing) providerModelsDb.updateCustomProviderModel(provider, existing.recordId, input);
        else providerModelsDb.createCustomProviderModel(provider, input);
      }
      for (const provider of providers) {
        for (const model of providerModelsDb.listCustomProviderModels(provider)) {
          if (!desired.has(`${provider}:${model.modelId}`)) await providerModelsService.deleteCustomModel(provider, model.recordId);
        }
      }
    }
    for (const name of providers) {
      const incoming = object(snapshot.mcp)[name];
      if (!Array.isArray(incoming)) continue;
      for (const server of incoming as ProviderMcpServer[]) {
        if (!server || typeof server.name !== 'string' || !['stdio', 'http', 'sse'].includes(server.transport)) continue;
        await providerMcpService.upsertProviderMcpServer(name, { ...server, scope: 'user' });
      }
    }
    return { missingPlugins };
  },
});

/** Settings Sync router mounted by the server entrypoint after authentication. */
export const settingsSyncRoutes = createSettingsSyncRouter(service);
