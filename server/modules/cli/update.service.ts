import path from 'node:path';

import { isNewerVersion, selectLatestRelease } from '@/shared/utils.js';

type UpdateDependencies = {
  root: string;
  current: string;
  platform: string;
  uid: number;
  home: string;
  exists(filePath: string): boolean;
  releaseLock?(): void;
  fetchRelease(url: string): Promise<{ ok: boolean; status: number; json(): Promise<{ tag_name?: string; draft?: boolean } | Array<{ tag_name?: string; draft?: boolean }>> }>;
  spawn(command: string, args: string[]): Promise<number>;
  exec(command: string, args: string[]): Promise<boolean>;
  log(message: string): void;
  error(message: string): void;
};

/** CLI dispatcher uses this service to check releases and update an npm installation. */
export function createUpdateCommand(deps: UpdateDependencies) {
  const installMode = deps.exists(path.join(deps.root, '.git')) ? 'git' : 'npm';
  return async (args: string[]): Promise<number> => {
    const checkOnly = args.includes('--check');
    const channelIndex = args.indexOf('--channel');
    const channel = channelIndex === -1 ? 'stable' : args[channelIndex + 1];
    if (channel !== 'stable' && channel !== 'beta') {
      deps.error('Invalid channel (expected stable or beta)');
      deps.releaseLock?.();
      return 1;
    }
    const versionIndex = args.indexOf('--version');
    const requested = versionIndex === -1 ? undefined : args[versionIndex + 1];
    if (versionIndex !== -1 && (!requested || !/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(requested))) {
      deps.error('Invalid version (expected vX.Y.Z)');
      deps.releaseLock?.();
      return 1;
    }
    let latest: string | null = null;
    if (!requested || checkOnly) {
      try {
        const result = await deps.fetchRelease(channel === 'beta'
          ? 'https://api.github.com/repos/50xu/bowcode/releases?per_page=30'
          : 'https://api.github.com/repos/50xu/bowcode/releases/latest');
        if (result.ok) {
          const body = await result.json();
          const release = channel === 'beta' && Array.isArray(body) ? selectLatestRelease(body) : !Array.isArray(body) ? selectLatestRelease([body]) : null;
          latest = release?.tag_name?.replace(/^v/, '') ?? null;
        } else if (result.status !== 404) throw new Error(`GitHub returned ${result.status}`);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : String(error));
        if (!checkOnly) {
          deps.releaseLock?.();
          return 1;
        }
      }
    }
    if (checkOnly) {
      deps.log(`current: ${deps.current}\nlatest: ${latest ?? 'none'}\nupdateAvailable: ${latest !== null && isNewerVersion(latest, deps.current)}`);
      return 0;
    }
    if (installMode === 'git') {
      deps.error('Git installation: update with git pull && npm ci && npm run build');
      deps.releaseLock?.();
      return 1;
    }
    const target = requested?.replace(/^v/, '') ?? latest;
    if (!target || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(target)) {
      deps.error('No valid release available');
      deps.releaseLock?.();
      return 1;
    }
    const suffix = path.join('lib', 'node_modules', 'bowcode');
    if (!deps.root.endsWith(suffix)) {
      deps.error('Cannot determine global npm prefix from package root');
      deps.releaseLock?.();
      return 1;
    }
    const prefix = deps.root.slice(0, -suffix.length).replace(/\/$/, '');
    const url = `https://github.com/50xu/bowcode/releases/download/v${target}/bowcode-${target}.tgz`;
    try {
      const result = await deps.spawn('npm', ['install', '-g', '--prefix', prefix, url, '--allow-scripts=bowcode,bcrypt,better-sqlite3,node-pty', '--no-fund', '--no-audit']);
      if (result !== 0) return result;
      // Release the API lock before a service restart can terminate this CLI.
      deps.releaseLock?.();
      if (deps.platform === 'linux') {
        if (await deps.exec('systemctl', ['--user', 'is-active', '--quiet', 'bowcode.service'])) {
          await deps.exec('systemctl', ['--user', 'restart', 'bowcode.service']);
        }
      } else if (deps.platform === 'darwin') {
        if (await deps.exec('launchctl', ['print', `gui/${deps.uid}/dev.bowcode`])) {
          await deps.exec('launchctl', ['kickstart', '-k', `gui/${deps.uid}/dev.bowcode`]);
        }
      }
      deps.log(`Updated to ${target}`);
      return 0;
    } finally {
      deps.releaseLock?.();
    }
  };
}
