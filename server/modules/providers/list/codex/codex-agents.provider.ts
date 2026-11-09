import os from 'node:os';
import path from 'node:path';

import * as toml from '@iarna/toml';

import { AgentsProvider, parseTomlAgent } from '@/modules/providers/shared/agents/agents.provider.js';
import type { ProviderAgent, ProviderAgentCreateInput } from '@/shared/types.js';

/** Used by the provider registry to manage Codex's native TOML agents. */
export class CodexAgentsProvider extends AgentsProvider {
  protected readonly format = 'toml';
  protected readonly extension = '.toml';

  protected userRoot(): string {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents');
  }

  protected projectRoot(workspacePath: string): string {
    return path.join(workspacePath, '.codex', 'agents');
  }

  protected parse(name: string, content: string): Pick<ProviderAgent, 'description' | 'model'> {
    return parseTomlAgent(name, content);
  }

  protected serialize(input: ProviderAgentCreateInput): string {
    return toml.stringify({
      name: input.name,
      description: input.description,
      developer_instructions: input.instructions,
      ...(input.model ? { model: input.model } : {}),
    });
  }
}
