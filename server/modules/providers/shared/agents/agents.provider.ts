import { readdir, readFile, mkdir, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';

import * as toml from '@iarna/toml';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type { IProviderAgents } from '@/shared/interfaces.js';
import type { ProviderAgent, ProviderAgentCreateInput, ProviderAgentScope } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const invalid = (message: string, statusCode = 400): AppError => new AppError(message, {
  code: 'PROVIDER_AGENT_INVALID',
  statusCode,
});

const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} is required.`);
  }
  return value.trim();
};

const optional = (value: unknown, field: string): string | null => {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string.`);
  }
  return value;
};

/** Used by the provider registry to manage native agent files in user and project scopes. */
export abstract class AgentsProvider implements IProviderAgents {
  protected abstract readonly format: 'markdown' | 'toml';
  protected abstract readonly extension: string;
  protected abstract userRoot(): string;
  protected abstract projectRoot(workspacePath: string): string;

  protected legacyRoots(_scope: ProviderAgentScope, _workspacePath?: string): string[] {
    return [];
  }

  protected abstract parse(name: string, content: string): Pick<ProviderAgent, 'description' | 'model'>;
  protected abstract serialize(input: ProviderAgentCreateInput): string;

  private roots(scope: ProviderAgentScope, workspacePath?: string): string[] {
    if (scope !== 'user' && scope !== 'project') {
      throw invalid('Invalid agent scope.');
    }
    if (scope === 'project' && (typeof workspacePath !== 'string' || !workspacePath.trim())) {
      throw invalid('workspacePath is required for project agents.');
    }
    return [
      scope === 'user' ? this.userRoot() : this.projectRoot(path.resolve(workspacePath!)),
      ...this.legacyRoots(scope, workspacePath),
    ];
  }

  private filename(name: string): string {
    if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..') {
      throw invalid('Invalid agent name.');
    }
    return `${name}${this.extension}`;
  }

  private async find(scope: ProviderAgentScope, name: string, workspacePath?: string): Promise<string> {
    const filename = this.filename(name);
    for (const root of this.roots(scope, workspacePath)) {
      const filePath = path.join(root, filename);
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) {
          throw invalid('Agent file must be a regular file.');
        }
        return filePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    throw invalid('Agent not found.', 404);
  }

  private record(scope: ProviderAgentScope, name: string, filePath: string, content: string): ProviderAgent {
    return { name, scope, filePath, format: this.format, ...this.parse(name, content) };
  }

  async listAgents(workspacePath?: string): Promise<ProviderAgent[]> {
    const agents: ProviderAgent[] = [];
    for (const scope of (workspacePath ? ['user', 'project'] : ['user']) as ProviderAgentScope[]) {
      // A broken project root must not hide agents already found in the user scope.
      let roots: string[];
      try {
        roots = this.roots(scope, workspacePath);
      } catch {
        continue;
      }
      for (const root of roots) {
        let entries;
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isFile() || !entry.name.endsWith(this.extension)) {
            continue;
          }
          const name = entry.name.slice(0, -this.extension.length);
          if (!NAME.test(name) || name === '.' || name === '..'
            || agents.some(agent => agent.scope === scope && agent.name === name)) {
            continue;
          }
          const filePath = path.join(root, entry.name);
          try {
            agents.push(this.record(scope, name, filePath, await readFile(filePath, 'utf8')));
          } catch {
            // Invalid files do not hide valid siblings.
          }
        }
      }
    }
    return agents;
  }

  async getAgent(scope: ProviderAgentScope, name: string, workspacePath?: string): Promise<ProviderAgent & { content: string }> {
    const filePath = await this.find(scope, name, workspacePath);
    const content = await readFile(filePath, 'utf8');
    return { ...this.record(scope, name, filePath, content), content };
  }

  async createAgent(input: ProviderAgentCreateInput): Promise<ProviderAgent> {
    const filename = this.filename(input.name);
    const roots = this.roots(input.scope, input.workspacePath);
    required(input.description, 'description');
    required(input.instructions, 'instructions');
    optional(input.model, 'model');
    for (const root of roots) {
      try {
        await lstat(path.join(root, filename));
        throw invalid('Agent already exists.', 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const content = this.serialize(input);
    this.parse(input.name, content);
    const filePath = path.join(roots[0]!, filename);
    await mkdir(roots[0]!, { recursive: true });
    if (!(await lstat(roots[0]!)).isDirectory()) {
      throw invalid('Agent directory must be a directory.');
    }
    try {
      await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw invalid('Agent already exists.', 409);
      }
      throw error;
    }
    return this.record(input.scope, input.name, filePath, content);
  }

  async updateAgent(scope: ProviderAgentScope, name: string, content: string, workspacePath?: string): Promise<ProviderAgent> {
    const filePath = await this.find(scope, name, workspacePath);
    if (typeof content !== 'string') {
      throw invalid('content is required.');
    }
    const agent = this.record(scope, name, filePath, content);
    await writeFile(filePath, content, 'utf8');
    return agent;
  }

  async deleteAgent(scope: ProviderAgentScope, name: string, workspacePath?: string): Promise<void> {
    await unlink(await this.find(scope, name, workspacePath));
  }
}

/** Used by Claude and OpenCode agent providers to parse native YAML definitions. */
export function parseMarkdownAgent(name: string, content: string, claude: boolean): Pick<ProviderAgent, 'description' | 'model'> {
  try {
    const parsed = parseFrontMatter(content);
    if (!content.startsWith('---')) {
      throw invalid('YAML frontmatter is required.');
    }
    const data = parsed.data as Record<string, unknown>;
    if (claude && data.name !== name) {
      throw invalid('Agent name must match the file name.');
    }
    if (!claude && data.mode != null && !['primary', 'subagent', 'all'].includes(String(data.mode))) {
      throw invalid('Invalid agent mode.');
    }
    return { description: required(data.description, 'description'), model: optional(data.model, 'model') };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalid('Invalid agent frontmatter.');
  }
}

/** Used by the Codex agent provider to parse native TOML definitions. */
export function parseTomlAgent(name: string, content: string): Pick<ProviderAgent, 'description' | 'model'> {
  try {
    const data = toml.parse(content);
    if (data.name !== name) {
      throw invalid('Agent name must match the file name.');
    }
    required(data.developer_instructions, 'developer_instructions');
    return { description: required(data.description, 'description'), model: optional(data.model, 'model') };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalid('Invalid agent TOML.');
  }
}
