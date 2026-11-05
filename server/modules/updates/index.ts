import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createUpdatesRouter } from './updates.routes.js';
import { createUpdatesService } from './updates.service.js';

const root = findApplicationRoot(getModuleDirectory(import.meta.url));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

// updatesRoutes: server entrypoint mounts this behind token authentication.
export const updatesRoutes = createUpdatesRouter(createUpdatesService({
  current: metadata.version,
  applicationRoot: root,
  homeDirectory: os.homedir(),
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  now: () => Date.now(),
  fetchRelease: async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'bowcode-cli', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, ok: response.ok, json: () => response.json() as Promise<{ tag_name?: string; html_url?: string }> };
  },
  exists: fs.existsSync,
  mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
  openExclusive: (filePath) => { fs.closeSync(fs.openSync(filePath, 'wx')); },
  remove: fs.unlinkSync,
  openLog: (filePath) => fs.openSync(filePath, 'a'),
  closeLog: fs.closeSync,
  spawnDetached: (command, args, logFd) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, BOWCODE_UPDATE_LOCK: '1' } });
    child.unref();
  },
  cliPath: path.join(root, 'dist-server/server/modules/cli/cli.js'),
}));
