import os from 'node:os';
import path from 'node:path';

import { AgentsProvider, parseMarkdownAgent } from '@/modules/providers/shared/agents/agents.provider.js';
import type { ProviderAgent, ProviderAgentCreateInput } from '@/shared/types.js';

/** Used by the provider registry to manage Claude's native Markdown agents. */
export class ClaudeAgentsProvider extends AgentsProvider {
  protected readonly format = 'markdown';
  protected readonly extension = '.md';

  protected userRoot(): string {
    return path.join(os.homedir(), '.claude', 'agents');
  }

  protected projectRoot(workspacePath: string): string {
    return path.join(workspacePath, '.claude', 'agents');
  }

  protected parse(name: string, content: string): Pick<ProviderAgent, 'description' | 'model'> {
    return parseMarkdownAgent(name, content, true);
  }

  protected serialize(input: ProviderAgentCreateInput): string {
    const yaml = [`name: ${JSON.stringify(input.name)}`, `description: ${JSON.stringify(input.description)}`];
    if (input.model) {
      yaml.push(`model: ${JSON.stringify(input.model)}`);
    }
    return `---\n${yaml.join('\n')}\n---\n\n${input.instructions}\n`;
  }
}
