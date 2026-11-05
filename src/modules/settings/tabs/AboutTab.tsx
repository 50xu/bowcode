import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_VERSION, PROJECT_REPO_URL } from '@/shared/constants';
import { api, readApiJson, ApiRequestError } from '@/shared/api';
import type { AppUpdateStatus } from '@/shared/types';
import { BrandMark } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

/**
 * Rendered by Settings to show the app's identity, source repository and license.
 */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  // The server's update eligibility and available release control this row.
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null);
  // A failed check should not be mistaken for an up-to-date installation.
  const [checkError, setCheckError] = useState<string | null>(null);
  // The apply request may disconnect as the server restarts; keep this state until reload.
  const [updating, setUpdating] = useState(false);
  // Prevent overlapping manual checks while one request is in flight.
  const [checking, setChecking] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Only the explicit button forces a fresh GitHub lookup; the mount check may use the cache.
  const checkUpdates = useCallback(async (force = false) => {
    try {
      const status = await api.updates.get({ force });
      if (mounted.current) {
        setUpdate(status);
        setCheckError(status.error ?? null);
      }
    } catch (error) {
      if (mounted.current) setCheckError(error instanceof Error ? error.message : t('about.update.checkFailed'));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [t]);

  useEffect(() => {
    // The request resolves asynchronously; it is safe to update state when it returns.
    const timer = window.setTimeout(() => { void checkUpdates(); }, 0);
    return () => window.clearTimeout(timer);
  }, [checkUpdates]);

  async function applyUpdate() {
    if (!update?.canSelfUpdate || !update.updateAvailable || updating ||
      !window.confirm(t('about.update.confirm'))) return;
    setUpdating(true);
    try {
      const response = await api.updates.apply();
      if (!response.ok) await readApiJson(response);
    } catch (error) {
      // A dropped connection can mean the server is already restarting, but an
      // explicit refusal means no update started and should allow another attempt.
      if (error instanceof ApiRequestError) {
        if (mounted.current) setUpdating(false);
      }
      if (mounted.current) setCheckError(error instanceof Error ? error.message : t('about.update.applyFailed'));
    }
  }

  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await api.updates.health();
        if (!response.ok) return;
        const health = await response.json() as { version?: string };
        if (health.version && health.version !== update?.current) window.location.reload();
      } catch {
        // The server is temporarily unavailable during replacement.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [updating, update]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        <BrandMark size={72} className="shadow-lg" />
        <div>
          <div className="text-2xl font-semibold tracking-tight text-foreground">Bowcode</div>
          <div className="mt-1 text-sm tabular-nums text-muted-foreground">
            {t('about.version', { defaultValue: 'Version {{version}}', version: APP_VERSION })}
          </div>
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">{t('about.tagline')}</p>
      </div>

      <SettingsCard divided>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 text-sm">
          <div className="min-w-48 flex-1 space-y-1">
            <div className="text-foreground">{t('about.update.title')}</div>
            <p role="status" className="text-muted-foreground">
              {updating ? t('about.update.updating') : checking && !update ? t('about.update.checking')
                : checkError ? t('about.update.checkFailed')
                  : update?.updateAvailable ? t('about.update.available', { version: update.latest })
                    : update ? t('about.update.upToDate') : t('about.update.checking')}
            </p>
            {checkError && <p role="alert" className="text-red-600 dark:text-red-400">{checkError}</p>}
            {update?.updateAvailable && !update.canSelfUpdate && (
              <p className="text-muted-foreground">
                {update.installMode === 'git' ? t('about.update.manualGit') : t('about.update.manualPackage')}
              </p>
            )}
            {update?.updateAvailable && update.releaseUrl && (
              <a href={update.releaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                {t('about.update.releaseNotes')} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
          {update?.updateAvailable && update.canSelfUpdate && (
            <button type="button" disabled={updating || checking} onClick={() => { void applyUpdate(); }} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">
              {t('about.update.updateNow')}
            </button>
          )}
          <button type="button" disabled={checking || updating} onClick={() => { setChecking(true); void checkUpdates(true); }} className="rounded-md border border-border px-3 py-1.5 text-foreground disabled:opacity-50">
            {t('about.update.checkAgain')}
          </button>
        </div>
        <a
          href={PROJECT_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3.5 text-sm text-foreground transition-colors hover:bg-accent/50"
        >
          <GitHubIcon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">{t('about.source', { defaultValue: 'Source code' })}</span>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </a>
        <div className="space-y-1 px-4 py-3.5 text-sm">
          <div className="text-foreground">{t('about.license', { defaultValue: 'License' })}</div>
          <p className="text-muted-foreground">{t('about.licensed')}</p>
        </div>
      </SettingsCard>
    </div>
  );
}
