import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  stripJsonComments,
  stripTrailingCommas,
} from '@/shared/utils.js';

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readOpenCodeConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

const writeOpenCodeConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const resolveOpenCodeConfigPath = async (scope: McpScope, workspacePath: string): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user'
    ? path.join(os.homedir(), '.config', 'opencode')
    : workspacePath;
  const jsonPath = path.join(root, 'opencode.json');
  const jsoncPath = path.join(root, 'opencode.jsonc');

  if (await fileExists(jsonPath)) {
    return { filePath: jsonPath, exists: true };
  }

  if (await fileExists(jsoncPath)) {
    return { filePath: jsoncPath, exists: true };
  }

  return { filePath: jsonPath, exists: false };
};

/** Keys of the v2 `mcp` object that are settings, not (deprecated) server names. */
const OPENCODE_MCP_RESERVED_KEYS = new Set(['servers', 'timeout']);

/**
 * Converts a server entry to OpenCode v2's `mcp.servers` shape: `enabled:
 * false` becomes `disabled: true`, a numeric `timeout` (ms per request)
 * becomes `{ execution }`, and a string `command` plus `args` becomes one
 * command array. Returns null for entries that are not a local or remote
 * server, such as a bare `{ enabled }` override.
 */
const toOpenCodeV2ServerConfig = (rawConfig: unknown): Record<string, unknown> | null => {
  const config = readObjectRecord(rawConfig);
  if (!config) {
    return null;
  }

  const isLocal = config.type === 'local' || config.command !== undefined;
  const isRemote = !isLocal && (config.type === 'remote' || typeof config.url === 'string');
  if (!isLocal && !isRemote) {
    return null;
  }

  const { enabled, timeout, args, ...rest } = config;
  const converted: Record<string, unknown> = { ...rest, type: isLocal ? 'local' : 'remote' };
  if (isLocal && typeof config.command === 'string') {
    converted.command = [config.command, ...(readStringArray(args) ?? [])];
  }
  if (enabled === false) {
    converted.disabled = true;
  }
  if (typeof timeout === 'number') {
    converted.timeout = { execution: timeout };
  } else if (timeout !== undefined) {
    converted.timeout = timeout;
  }

  return converted;
};

export class OpenCodeMcpProvider extends McpProvider {
  constructor() {
    super('opencode', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    const mcp = readObjectRecord(config.mcp) ?? {};
    const servers: Record<string, unknown> = {};
    // Deprecated top-level `mcp.<name>` entries first, so a v2 `mcp.servers`
    // entry of the same name wins.
    for (const [name, rawConfig] of Object.entries(mcp)) {
      if (!OPENCODE_MCP_RESERVED_KEYS.has(name)) {
        servers[name] = rawConfig;
      }
    }

    return { ...servers, ...(readObjectRecord(mcp.servers) ?? {}) };
  }

  /**
   * Writes every server into v2's `mcp.servers`, converting deprecated
   * top-level `mcp.<name>` entries on the way and dropping them from the top
   * level. `mcp.timeout` is kept. A bare `{ enabled }` override of a server
   * defined elsewhere has no v2 form, so it stays where it is.
   */
  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    const previousMcp = readObjectRecord(config.mcp) ?? {};
    const nextMcp: Record<string, unknown> = {};
    const nextServers: Record<string, unknown> = {};

    for (const [name, rawConfig] of Object.entries(servers)) {
      const converted = toOpenCodeV2ServerConfig(rawConfig);
      if (converted) {
        nextServers[name] = converted;
      } else if (!OPENCODE_MCP_RESERVED_KEYS.has(name)) {
        nextMcp[name] = rawConfig;
      }
    }

    if (previousMcp.timeout !== undefined) {
      nextMcp.timeout = previousMcp.timeout;
    }
    nextMcp.servers = nextServers;
    config.mcp = nextMcp;
    await writeOpenCodeConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
