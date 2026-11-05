import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

//----------------- USER DATA DIRECTORY UTILITIES ------------
const fallbackDirectories = new Map<string, string>();

/**
 * Resolves persistent application data for server bootstrap, CLI, plugins,
 * attachments, browser profiles, and the local-server marker. An explicit
 * BOWCODE_DATA_DIR takes precedence; otherwise ~/.bowcode is used unless its
 * migration failed, in which case the existing ~/.cloudcli remains active.
 * The optional home and environment parameters allow tests to avoid real HOME.
 */
export function getAppDataDir(
  homeDirectory: string = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.BOWCODE_DATA_DIR || fallbackDirectories.get(homeDirectory) || path.join(homeDirectory, '.bowcode');
}

/**
 * One-time migration of ~/.cloudcli to ~/.bowcode, used by the server bootstrap
 * before any persistent stores initialize. If both exist, neither is changed.
 * On rename failure the old directory stays in use and startup continues. The
 * legacy path is symlinked back to the new directory on successful rename so
 * existing absolute references remain valid. An explicit data-dir override
 * bypasses this default-directory migration.
 */
export function migrateLegacyDataDirectory(
  homeDirectory: string = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.BOWCODE_DATA_DIR) return;
  const legacyDirectory = path.join(homeDirectory, '.cloudcli');
  const targetDirectory = path.join(homeDirectory, '.bowcode');
  if (fs.existsSync(targetDirectory) || !fs.existsSync(legacyDirectory)) {
    fallbackDirectories.delete(homeDirectory);
    return;
  }

  try {
    fs.renameSync(legacyDirectory, targetDirectory);
    fallbackDirectories.delete(homeDirectory);
  } catch (error) {
    fallbackDirectories.set(homeDirectory, legacyDirectory);
    console.warn('[Data] Could not move ~/.cloudcli to ~/.bowcode; continuing with existing data:', error);
    return;
  }

  try {
    fs.symlinkSync(targetDirectory, legacyDirectory, 'dir');
  } catch (error) {
    console.warn('[Data] Could not link ~/.cloudcli to ~/.bowcode:', error);
  }
}

/**
 * Moves former ~/.claude-code-ui plugin data into the active app-data directory.
 * Used by the server bootstrap after resolving the main data directory. Each
 * plugins entry is moved only when its destination is absent, so existing data
 * wins; the former parent directory and any unmatched entries remain intact.
 */
export function migrateLegacyPlugins(
  homeDirectory: string = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const legacyDirectory = path.join(homeDirectory, '.claude-code-ui');
  const targetDirectory = getAppDataDir(homeDirectory, environment);
  for (const name of ['plugins', 'plugins.json']) {
    const source = path.join(legacyDirectory, name);
    const destination = path.join(targetDirectory, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    try {
      fs.mkdirSync(targetDirectory, { recursive: true });
      fs.renameSync(source, destination);
    } catch (error) {
      console.warn(`[Data] Could not move legacy ${name} into app data:`, error);
    }
  }
}
