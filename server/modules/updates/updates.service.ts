import path from 'node:path';

import { isNewerVersion, selectLatestRelease } from '@/shared/utils.js';

const RELEASES_URL = 'https://api.github.com/repos/50xu/bowcode/releases/latest';
const BETA_RELEASES_URL = 'https://api.github.com/repos/50xu/bowcode/releases?per_page=30';
// One unauthenticated GitHub call per window stays far below the 60/hour limit.
const RELEASE_CACHE_TTL_MS = 15 * 60_000;
// Failures expire sooner so a brief network error does not hide a release.
const FAILED_CHECK_CACHE_TTL_MS = 60_000;

type Channel = 'stable' | 'beta';
type Release = { tag_name?: string; html_url?: string; draft?: boolean };
type UpdatesDependencies = {
  current: string;
  applicationRoot: string;
  homeDirectory: string;
  platform: string;
  uid: number;
  now(): number;
  fetchRelease(url: string): Promise<{ status: number; ok: boolean; json(): Promise<Release | Release[]> }>;
  getChannel(): Channel;
  setChannel(channel: Channel): void;
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
  type CachedRelease = { latest: string | null; releaseUrl: string | null; error?: string; checkedAt: string; expires: number };
  const cache: Partial<Record<Channel, CachedRelease>> = {};
  const lockPath = path.join(dependencies.homeDirectory, '.bowcode', 'update.lock');
  const installMode = dependencies.exists(path.join(dependencies.applicationRoot, '.git')) ? 'git' : 'npm';
  const unitPath = dependencies.platform === 'darwin'
    ? path.join(dependencies.homeDirectory, 'Library/LaunchAgents/dev.bowcode.plist')
    : path.join(dependencies.homeDirectory, '.config/systemd/user/bowcode.service');
  const canSelfUpdate = installMode === 'npm' && dependencies.exists(unitPath);

  async function check(options: { force?: boolean } = {}) {
    const channel = dependencies.getChannel();
    let cached = cache[channel];
    if (options.force || !cached || cached.expires <= dependencies.now()) {
      const checkedAt = new Date(dependencies.now()).toISOString();
      try {
        const response = await dependencies.fetchRelease(channel === 'beta' ? BETA_RELEASES_URL : RELEASES_URL);
        if (!response.ok) throw new Error(response.status === 404 ? 'No release found' : `GitHub returned ${response.status}`);
        const body = await response.json();
        const release = channel === 'beta' && Array.isArray(body) ? selectLatestRelease(body) : !Array.isArray(body) ? body : null;
        const latest = release?.tag_name?.replace(/^v/, '') ?? null;
        if (!latest && channel === 'beta') {
          cached = { latest: null, releaseUrl: null, checkedAt, expires: dependencies.now() + RELEASE_CACHE_TTL_MS };
        } else if (!latest || !selectLatestRelease([release!])) {
          throw new Error('Invalid release version');
        } else {
          cached = { latest, releaseUrl: release?.html_url ?? null, checkedAt, expires: dependencies.now() + RELEASE_CACHE_TTL_MS };
        }
      } catch (error) {
        cached = { latest: null, releaseUrl: null, error: error instanceof Error ? error.message : String(error), checkedAt, expires: dependencies.now() + FAILED_CHECK_CACHE_TTL_MS };
      }
      cache[channel] = cached;
    }
    return {
      channel,
      current: dependencies.current,
      latest: cached.latest,
      updateAvailable: cached.latest !== null && isNewerVersion(cached.latest, dependencies.current),
      installMode,
      canSelfUpdate,
      releaseUrl: cached.releaseUrl,
      checkedAt: cached.checkedAt,
      ...(cached.error ? { error: cached.error } : {}),
    };
  }

  return {
    /** `force` skips the per-channel cache for the user's explicit check. */
    check,
    /** Persists the channel and returns a fresh status for it. */
    async setChannel(channel: Channel) {
      dependencies.setChannel(channel);
      return check({ force: true });
    },
    /** Uses the current channel's cached or freshly checked target to start the updater. */
    async apply() {
      if (!canSelfUpdate) throw new Error('Self-update requires an npm installation with a managed service');
      const status = await check();
      if (!status.latest) throw new Error('No valid release available');
      dependencies.mkdir(path.dirname(lockPath));
      dependencies.openExclusive(lockPath);
      let logFd: number | undefined;
      try {
        const logDirectory = path.join(dependencies.homeDirectory, '.bowcode', 'logs');
        dependencies.mkdir(logDirectory);
        logFd = dependencies.openLog(path.join(logDirectory, 'update.log'));
        dependencies.spawnDetached(process.execPath, [dependencies.cliPath, 'update', '--version', status.latest], logFd);
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
