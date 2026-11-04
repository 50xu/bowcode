import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { SETTINGS_SYNC_LOCAL_STORAGE_KEYS } from '@/shared/constants';
import type { GithubCredentialItem } from '@/shared/types';

type SyncCategory = 'preferences' | 'notifications' | 'providerModels' | 'plugins' | 'gitIdentity' | 'mcp' | 'claudeConfig';
type SyncConfig = {
  repoUrl: string;
  branch: string;
  githubTokenId: number | null;
  include: Record<SyncCategory, boolean>;
  cloned?: boolean;
};
type SyncStatus = { lastSyncAt?: string | null; lastAction?: string | null; lastCommit?: string | null; lastError?: string | null; cloned?: boolean };
const DEFAULT_INCLUDE: Record<SyncCategory, boolean> = {
  preferences: true, notifications: true, providerModels: true, plugins: true,
  gitIdentity: true, mcp: true, claudeConfig: false,
};
const EMPTY_CONFIG: SyncConfig = { repoUrl: '', branch: 'main', githubTokenId: null, include: DEFAULT_INCLUDE };
type ConfigResponse = { config?: (Partial<SyncConfig> & SyncStatus) | null; cloned?: boolean };
type TokensResponse = { credentials?: GithubCredentialItem[] };
type PullResponse = { client?: Record<string, string | null>; applied?: unknown; missingPlugins?: string[] };

export function useSettingsSync() {
  const { t } = useTranslation('settings');
  // Keep connection details and category choices editable until explicitly saved.
  const [config, setConfig] = useState<SyncConfig>(EMPTY_CONFIG);
  // Token metadata is used to select an existing credential without exposing its secret.
  const [tokens, setTokens] = useState<GithubCredentialItem[]>([]);
  // The server's last operation is presented separately from editable form values.
  const [status, setStatus] = useState<SyncStatus | null>(null);
  // Prevent concurrent sync operations while a request is running.
  const [busy, setBusy] = useState(false);
  // Show failures and operation confirmation to the user.
  const [message, setMessage] = useState('');
  // Hold missing plugin names until the user explicitly chooses to reload.
  const [missingPlugins, setMissingPlugins] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      api.settingsSync.config().then((response) => readApiJson<ConfigResponse>(response)),
      api.settings.credentials('github_token').then((response) => readApiJson<TokensResponse>(response)),
    ]).then(([saved, credentials]) => {
      if (!mounted) return;
      if (saved.config) setConfig({ ...EMPTY_CONFIG, ...saved.config, include: { ...DEFAULT_INCLUDE, ...saved.config.include } });
      setStatus(saved.config ? { ...saved.config, cloned: saved.cloned } : null);
      setTokens((credentials.credentials ?? []).filter((token) => token.is_active));
    }).catch((error: unknown) => {
      if (mounted) setMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { mounted = false; };
  }, []);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(detail);
      setStatus((previous) => ({ ...previous, lastError: detail }));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const result = await readApiJson<SyncConfig & SyncStatus>(await api.settingsSync.save(config));
    setConfig({ ...config, ...result, include: { ...config.include, ...result.include } });
    setStatus(result);
  }, t('sync.saved'));

  const refreshStatus = async () => {
    const saved = await readApiJson<ConfigResponse>(await api.settingsSync.config());
    setStatus(saved.config ? { ...saved.config, cloned: saved.cloned } : null);
  };

  const push = () => run(async () => {
    const client: Record<string, string> = {};
    if (config.include.preferences) {
      for (const key of SETTINGS_SYNC_LOCAL_STORAGE_KEYS) {
        try {
          const value = localStorage.getItem(key);
          if (value !== null) client[key] = value;
        } catch { /* Storage may be unavailable for one key; continue with the rest. */ }
      }
    }
    await readApiJson(await api.settingsSync.push(client));
    await refreshStatus();
  }, t('sync.pushed'));

  const pull = () => run(async () => {
    const result = await readApiJson<PullResponse>(await api.settingsSync.pull());
    // A remote snapshot cannot introduce arbitrary browser storage, including auth tokens.
    for (const key of SETTINGS_SYNC_LOCAL_STORAGE_KEYS) {
      try {
        const value = result.client?.[key];
        if (typeof value === 'string') localStorage.setItem(key, value);
        else if (value === null) localStorage.removeItem(key);
      } catch { /* A blocked storage entry must not prevent applying the others. */ }
    }
    await refreshStatus();
    if (result.missingPlugins?.length) setMissingPlugins(result.missingPlugins);
    else window.setTimeout(() => window.location.reload(), 800);
  }, t('sync.pulledReloading'));

  const disconnect = () => run(async () => {
    await readApiJson(await api.settingsSync.disconnect());
    setConfig(EMPTY_CONFIG);
    setStatus(null);
    setMissingPlugins([]);
  }, t('sync.disconnected'));

  return { config, setConfig, tokens, status, busy, message, missingPlugins, save, push, pull, disconnect };
}
