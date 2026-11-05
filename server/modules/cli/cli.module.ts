import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

// eslint-disable-next-line boundaries/no-unknown -- Early bootstrap helper is not classified by the legacy boundary map.
import { getAppDataDir } from '@/shared/data-directory.js';
import type { CliApplication, CliPackageMetadata } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCliService } from './cli.service.js';
import { createSandboxCommandService } from './sandbox.service.js';
import { createUpdateCommand } from './update.service.js';
import { createServiceCommand } from './service.service.js';

/**
 * Creates the production CLI application for the executable entrypoint. This is
 * the CLI module's single composition root: it reads package metadata and wires
 * all concrete Node filesystem, subprocess, environment, clock, and module-start
 * adapters before passing them into otherwise isolated services.
 */
export function createCliApplication(): CliApplication {
  const applicationRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
  const packageMetadataJson = JSON.parse(
    fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'),
  ) as { version: string; homepage?: string; bugs?: { url?: string } };
  const packageMetadata: CliPackageMetadata = {
    version: packageMetadataJson.version,
    homepage: packageMetadataJson.homepage,
    bugsUrl: packageMetadataJson.bugs?.url,
  };
  const fileSystem = {
    pathExists: (filePath: string) => fs.existsSync(filePath),
    getFileStats: (filePath: string) => {
      const stats = fs.statSync(filePath);
      return { size: stats.size, modifiedAt: stats.mtime };
    },
  };
  const output = {
    log: (message?: string) => console.log(message),
    error: (message?: string) => console.error(message),
  };
  const homeDirectory = os.homedir();
  const sandboxService = createSandboxCommandService({
    homeDirectory,
    fileSystem,
    output,
    runSandboxCommand: (argumentsList, inheritOutput = false) => {
      const result = execFileSync('sbx', argumentsList, {
        encoding: 'utf8',
        stdio: inheritOutput ? 'inherit' : 'pipe',
      });
      return result || '';
    },
    spawnDetachedSandbox: (argumentsList) => {
      const childProcess = spawn('sbx', argumentsList, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      childProcess.unref();
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });

  return createCliService({
    applicationRoot,
    defaultDatabasePath: path.join(getAppDataDir(homeDirectory), 'auth.db'),
    homeDirectory,
    packageMetadata,
    environment: process.env,
    fileSystem,
    output,
    sandboxService,
    updateCommand: createUpdateCommand({
      root: applicationRoot, current: packageMetadata.version, platform: process.platform,
      uid: process.getuid?.() ?? 0, home: homeDirectory, exists: fs.existsSync,
      releaseLock: () => {
        if (process.env.BOWCODE_UPDATE_LOCK !== '1') return;
        try { fs.unlinkSync(path.join(homeDirectory, '.bowcode/update.lock')); } catch { /* already removed */ }
      },
      log: output.log, error: output.error,
      fetchRelease: async (url) => {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'bowcode-cli', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        return { ok: response.ok, status: response.status, json: () => response.json() as Promise<{ tag_name?: string }> };
      },
      spawn: (command, args) => new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', shell: false, env: { ...process.env, BOWCODE_UPDATE_LOCK: '' } });
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }),
      exec: async (command, args) => new Promise((resolve) => {
        const child = nodeSpawn(command, args, { stdio: 'ignore', shell: false });
        child.once('error', () => resolve(false));
        child.once('close', (code) => resolve(code === 0));
      }),
    }),
    serviceCommand: createServiceCommand({
      platform: process.platform, home: homeDirectory, uid: process.getuid?.() ?? 0,
      nodePath: process.execPath, cliPath: path.join(applicationRoot, 'dist-server/server/modules/cli/cli.js'),
      pathEnv: process.env.PATH || '', exists: fs.existsSync,
      read: (filePath) => fs.readFileSync(filePath, 'utf8'),
      write: (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
      mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }), remove: fs.unlinkSync,
      log: output.log, error: output.error,
      exec: async (command, args) => new Promise((resolve) => {
        const child = nodeSpawn(command, args, { stdio: 'ignore', shell: false });
        child.once('error', () => resolve(false));
        child.once('close', (code) => resolve(code === 0));
      }),
    }),
    startServer: async () => {
      // The server executable is an entrypoint rather than a feature module,
      // so it has no barrel contract to import through.
      // eslint-disable-next-line boundaries/no-unknown
      await import('../../index.js');
    },
    startBrowserUseMcp: async () => {
      const { startBrowserUseMcp } = await import('../browser-use/index.js');
      await startBrowserUseMcp();
    },
  });
}
