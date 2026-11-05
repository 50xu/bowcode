import path from 'node:path';

import { isNewerVersion } from '@/shared/utils.js';

const RELEASES_URL = 'https://api.github.com/repos/50xu/bowcode/releases/latest';

type Release = { tag_name?: string; html_url?: string };
type UpdatesDependencies = {
  current: string;
  applicationRoot: string;
  homeDirectory: string;
  platform: string;
  uid: number;
  now(): number;
  fetchRelease(url: string): Promise<{ status: number; ok: boolean; json(): Promise<Release> }>;
  exists(filePath: string): boolean;
  mkdir(directory: string): void;
  openExclusive(filePath: string): void;
  remove(filePath: string): void;
  openLog(filePath: string): number;
  closeLog(fd: number): void;
  spawnDetached(command: string, args: string[], logFd: number): void;
  cliPath: string;
};

/** The Updates API uses this injected service to check GitHub releases and launch a guarded update. */
export function createUpdatesService(dependencies: UpdatesDependencies) {
  let cached: { latest: string | null; releaseUrl: string | null; error?: string; checkedAt: string; expires: number } | null = null;
  const lockPath = path.join(dependencies.homeDirectory, '.bowcode', 'update.lock');
  const installMode = dependencies.exists(path.join(dependencies.applicationRoot, '.git')) ? 'git' : 'npm';
  const unitPath = dependencies.platform === 'darwin'
    ? path.join(dependencies.homeDirectory, 'Library/LaunchAgents/dev.bowcode.plist')
    : path.join(dependencies.homeDirectory, '.config/systemd/user/bowcode.service');
  const canSelfUpdate = installMode === 'npm' && dependencies.exists(unitPath);

  return {
    async check() {
      if (!cached || cached.expires <= dependencies.now()) {
        const checkedAt = new Date(dependencies.now()).toISOString();
        try {
          const response = await dependencies.fetchRelease(RELEASES_URL);
          if (!response.ok) throw new Error(response.status === 404 ? 'No release found' : `GitHub returned ${response.status}`);
          const release = await response.json();
          const latest = release.tag_name?.replace(/^v/, '') ?? null;
          if (!latest || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(latest)) throw new Error('Invalid release version');
          cached = { latest, releaseUrl: release.html_url ?? null, checkedAt, expires: dependencies.now() + 3_600_000 };
        } catch (error) {
          cached = { latest: null, releaseUrl: null, error: error instanceof Error ? error.message : String(error), checkedAt, expires: dependencies.now() + 3_600_000 };
        }
      }
      return {
        current: dependencies.current,
        latest: cached.latest,
        updateAvailable: cached.latest !== null && isNewerVersion(cached.latest, dependencies.current),
        installMode,
        canSelfUpdate,
        releaseUrl: cached.releaseUrl,
        checkedAt: cached.checkedAt,
        ...(cached.error ? { error: cached.error } : {}),
      };
    },
    apply() {
      if (!canSelfUpdate) throw new Error('Self-update requires an npm installation with a managed service');
      dependencies.mkdir(path.dirname(lockPath));
      dependencies.openExclusive(lockPath);
      let logFd: number | undefined;
      try {
        const logDirectory = path.join(dependencies.homeDirectory, '.bowcode', 'logs');
        dependencies.mkdir(logDirectory);
        logFd = dependencies.openLog(path.join(logDirectory, 'update.log'));
        dependencies.spawnDetached(process.execPath, [dependencies.cliPath, 'update'], logFd);
        return { started: true };
      } catch (error) {
        dependencies.remove(lockPath);
        throw error;
      } finally {
        if (logFd !== undefined) dependencies.closeLog(logFd);
      }
    },
  };
}
