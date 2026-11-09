import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { AgentProvider, ProviderAgentCreatePayload, ProviderAgentDefinition } from '@/shared/types';

const unwrap = async <T>(response: Response): Promise<T> => {
  const body = await readApiJson<{ success: boolean; data: T }>(response);
  if (!body.success) {
    throw new Error(`Agent request failed (${response.status})`);
  }
  return body.data;
};

/** Used by ProviderAgents and settings category tabs to load native agent definitions. */
export function useProviderAgents(provider: AgentProvider, workspacePath?: string) {
  // Tracks the visible native agent definitions for the active provider and workspace.
  const [agents, setAgents] = useState<ProviderAgentDefinition[]>([]);
  // Exposes request failures without hiding the last successfully loaded list.
  const [error, setError] = useState<string | null>(null);
  // Distinguishes first load and refresh from an empty result.
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await unwrap<{ agents: ProviderAgentDefinition[] }>(await api.providers.agents(provider, workspacePath));
      setAgents(result.agents);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [provider, workspacePath]);

  useEffect(() => {
    setAgents([]);
    void refresh();
  }, [refresh]);

  const create = async (payload: ProviderAgentCreatePayload) => {
    await unwrap(await api.providers.createAgent(provider, payload));
    await refresh();
  };
  const read = async (agent: ProviderAgentDefinition) => unwrap<ProviderAgentDefinition & { content: string }>(
    await api.providers.agent(provider, agent.scope, agent.name, workspacePath),
  );
  const update = async (agent: ProviderAgentDefinition, content: string) => {
    await unwrap(await api.providers.updateAgent(provider, agent.scope, agent.name, { workspacePath, content }));
    await refresh();
  };
  const remove = async (agent: ProviderAgentDefinition) => {
    await unwrap(await api.providers.deleteAgent(provider, agent.scope, agent.name, workspacePath));
    await refresh();
  };

  return { agents, error, loading, refresh, create, read, update, remove };
}
