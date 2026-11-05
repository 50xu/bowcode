import os from 'node:os';
import path from 'node:path';

//----------------- USER DATA DIRECTORY UTILITIES ------------
/** Resolves persistent app data for server bootstrap and storage; an explicit override takes precedence. */
export function getAppDataDir(
  homeDirectory: string = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.BOWCODE_DATA_DIR || path.join(homeDirectory, '.bowcode');
}
