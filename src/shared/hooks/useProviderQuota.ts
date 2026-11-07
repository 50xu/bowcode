import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, ProviderQuota } from '@/shared/types';

const unsupportedProviders = new Map<LLMProvider, ProviderQuota>();

/** Used by Settings and chat to poll the selected provider's quota, skipping unsupported providers for this browser session. */
export function useProviderQuota(provider: LLMProvider): {
  quota: ProviderQuota | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  // Keeps only the current provider's last snapshot so a provider switch never shows the previous account's usage.
  const [snapshot, setSnapshot] = useState<{ provider: LLMProvider; quota: ProviderQuota } | null>(null);
  // Tracks in-flight reads to show a spinner on initial load and manual refresh.
  const [loadingProvider, setLoadingProvider] = useState<LLMProvider | null>(null);

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    const unsupported = unsupportedProviders.get(provider);
    if (unsupported && !force) {
      setSnapshot({ provider, quota: unsupported });
      return;
    }
    setLoadingProvider(provider);
    try {
      const quota = await api.providers.quota(provider, force, signal);
      if (signal?.aborted) return;
      if (quota.status === 'unsupported') unsupportedProviders.set(provider, quota);
      setSnapshot({ provider, quota });
    } catch (error) {
      if (signal?.aborted) return;
      setSnapshot({ provider, quota: {
        provider,
        status: 'error',
        source: null,
        planType: null,
        windows: [],
        fetchedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : undefined,
      } });
    } finally {
      if (!signal?.aborted) setLoadingProvider(null);
    }
  }, [provider]);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    const timer = window.setInterval(() => { void load(false, controller.signal); }, 5 * 60 * 1000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return {
    quota: snapshot?.provider === provider ? snapshot.quota : null,
    loading: loadingProvider === provider,
    refresh,
  };
}
