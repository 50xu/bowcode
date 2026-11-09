import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { ProviderAgentCreateInput, ProviderAgentScope } from '@/shared/types.js';

/** Used by provider routes to delegate agent file operations to the selected provider. */
export const providerAgentsService = {
  list(provider: string, workspacePath?: string) {
    return providerRegistry.resolveProvider(provider).agents.listAgents(workspacePath);
  },
  get(provider: string, scope: ProviderAgentScope, name: string, workspacePath?: string) {
    return providerRegistry.resolveProvider(provider).agents.getAgent(scope, name, workspacePath);
  },
  create(provider: string, input: ProviderAgentCreateInput) {
    return providerRegistry.resolveProvider(provider).agents.createAgent(input);
  },
  update(provider: string, scope: ProviderAgentScope, name: string, content: string, workspacePath?: string) {
    return providerRegistry.resolveProvider(provider).agents.updateAgent(scope, name, content, workspacePath);
  },
  delete(provider: string, scope: ProviderAgentScope, name: string, workspacePath?: string) {
    return providerRegistry.resolveProvider(provider).agents.deleteAgent(scope, name, workspacePath);
  },
};
