import os from 'node:os';
import path from 'node:path';

import { AgentsProvider, parseMarkdownAgent } from '@/modules/providers/shared/agents/agents.provider.js';
import type { ProviderAgent, ProviderAgentCreateInput, ProviderAgentScope } from '@/shared/types.js';

/** Used by the provider registry for OpenCode's Markdown agents and legacy discovery. */
export class OpenCodeAgentsProvider extends AgentsProvider {
  protected readonly format = 'markdown';
  protected readonly extension = '.md';

  protected userRoot(): string {
    return path.join(os.homedir(), '.config', 'opencode', 'agents');
  }

  protected projectRoot(workspacePath: string): string {
    return path.join(workspacePath, '.opencode', 'agents');
  }

  protected legacyRoots(scope: ProviderAgentScope, workspacePath?: string): string[] {
    return [scope === 'user'
      ? path.join(os.homedir(), '.config', 'opencode', 'agent')
      : path.join(path.resolve(workspacePath!), '.opencode', 'agent')];
  }

  protected parse(name: string, content: string): Pick<ProviderAgent, 'description' | 'model'> {
    return parseMarkdownAgent(name, content, false);
  }

  protected serialize(input: ProviderAgentCreateInput): string {
    const yaml = [`description: ${JSON.stringify(input.description)}`];
    if (input.model) {
      yaml.push(`model: ${JSON.stringify(input.model)}`);
    }
    return `---\n${yaml.join('\n')}\n---\n\n${input.instructions}\n`;
  }
}
