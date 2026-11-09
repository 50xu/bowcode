import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError, readObjectRecord, stripJsonComments, stripTrailingCommas } from '@/shared/utils.js';

const invalid = (message: string, code: string): AppError => new AppError(message, { code, statusCode: 400 });

const openCodeRoot = (): string => {
  const override = process.env.OPENCODE_CONFIG_DIR?.trim();
  return override && path.isAbsolute(override) ? override : path.join(os.homedir(), '.config', 'opencode');
};

const openCodeFile = async (): Promise<string> => {
  const root = openCodeRoot();
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(root, name);
    try {
      await access(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path.join(root, 'opencode.json');
};

const readConfig = async (file: string): Promise<Record<string, unknown>> => {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const value = readObjectRecord(JSON.parse(stripTrailingCommas(stripJsonComments(content))));
    if (value) return value;
  } catch { /* Invalid config must not be overwritten. */ }
  throw invalid('OpenCode config is not a JSON object.', 'INVALID_OPENCODE_CONFIG');
};

const codexRulesDirectory = (): string => {
  const override = process.env.CODEX_HOME?.trim();
  const root = override && path.isAbsolute(override) ? override : path.join(os.homedir(), '.codex');
  return path.join(root, 'rules');
};

const rulesPath = (name: string): string => {
  if (!/^[a-zA-Z0-9._-]+\.rules$/.test(name) || name.includes('..')) {
    throw invalid('Invalid Codex rules filename.', 'INVALID_RULES_FILENAME');
  }
  return path.join(codexRulesDirectory(), name);
};

/** Used by provider permission routes to read and update the user's OpenCode permission config without dropping other keys. */
export const openCodePermissionsService = {
  async read(): Promise<{ path: string; permission: unknown }> {
    const file = await openCodeFile();
    const config = await readConfig(file);
    return { path: file, permission: config.permission ?? null };
  },

  async update(permission: unknown): Promise<{ path: string; permission: unknown }> {
    if (permission !== null && typeof permission !== 'string' && !readObjectRecord(permission)) {
      throw invalid('Permission must be a string, object, or null.', 'INVALID_OPENCODE_PERMISSION');
    }
    const file = await openCodeFile();
    const config = await readConfig(file);
    if (permission === null) delete config.permission;
    else config.permission = permission;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { path: file, permission: config.permission ?? null };
  },
};

/** Used by provider permission routes to expose raw Codex .rules files, without interpreting their contents. */
export const codexRulesService = {
  async list(): Promise<Array<{ name: string; content: string }>> {
    let names: string[];
    try {
      names = await readdir(codexRulesDirectory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files = names.filter((name) => /^[a-zA-Z0-9._-]+\.rules$/.test(name) && !name.includes('..')).sort();
    return Promise.all(files.map(async (name) => ({ name, content: await readFile(rulesPath(name), 'utf8') })));
  },

  async read(name: string): Promise<{ name: string; content: string }> {
    return { name, content: await readFile(rulesPath(name), 'utf8') };
  },

  async save(name: string, content: string): Promise<{ name: string; content: string }> {
    const file = rulesPath(name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return { name, content };
  },
};
