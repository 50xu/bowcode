import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useSessionRetentionSettings } from '@/modules/settings/hooks/useSessionRetentionSettings';
import type { SessionRetentionAction, SessionRetentionRun } from '@/shared/types';

/** Threshold presets offered in the picker; a stored value outside this list is shown as an extra option. */
const INACTIVE_DAY_PRESETS = [7, 14, 30, 60, 90, 180, 365];

const SELECT_CLASS_NAME =
  'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary max-w-[11rem] sm:w-48 sm:max-w-none';

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Rendered by Settings for the "sessions" tab: the automatic cleanup of long-inactive sessions. */
export default function SessionRetentionSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    status,
    preview,
    isSaving,
    isRunning,
    isPreviewLoading,
    errorKey,
    saveSettings,
    runNow,
  } = useSessionRetentionSettings();

  const settings = status?.settings ?? null;
  const isDelete = settings?.action === 'delete';
  const dayOptions = settings && !INACTIVE_DAY_PRESETS.includes(settings.inactiveDays)
    ? [...INACTIVE_DAY_PRESETS, settings.inactiveDays].sort((a, b) => a - b)
    : INACTIVE_DAY_PRESETS;

  const handleEnabledChange = (enabled: boolean) => {
    // Turning on automatic deletion is the moment data starts disappearing
    // unattended, so it is confirmed even though the action was confirmed before.
    if (enabled && isDelete && !window.confirm(t('sessionRetention.confirmEnableDelete', { count: settings?.inactiveDays ?? 0 }))) {
      return;
    }
    void saveSettings({ enabled });
  };

  const handleActionChange = (action: SessionRetentionAction) => {
    if (action === 'delete' && !window.confirm(t('sessionRetention.confirmDeleteAction'))) {
      return;
    }
    void saveSettings({ action });
  };

  const handleRunNow = () => {
    const count = preview?.total ?? 0;
    const confirmKey = isDelete ? 'sessionRetention.confirmRunDelete' : 'sessionRetention.confirmRunArchive';
    if (!window.confirm(t(confirmKey, { count: Math.min(count, preview?.batchLimit ?? count) }))) {
      return;
    }
    void runNow();
  };

  const describeRun = (run: SessionRetentionRun) => [
    run.action === 'archive'
      ? t('sessionRetention.lastRun.archived', { count: run.archived })
      : t('sessionRetention.lastRun.deleted', { count: run.deleted }),
    run.skippedBusy > 0 ? t('sessionRetention.lastRun.skippedBusy', { count: run.skippedBusy }) : null,
    run.failed > 0 ? t('sessionRetention.lastRun.failed', { count: run.failed }) : null,
    run.remaining > 0 ? t('sessionRetention.lastRun.remaining', { count: run.remaining }) : null,
  ].filter(Boolean).join(' · ');

  if (!settings) {
    return (
      <SettingsCard className="p-4">
        {errorKey ? (
          <p className="text-sm text-destructive">{t(`sessionRetention.errors.${errorKey}`)}</p>
        ) : (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('sessionRetention.loading')}
          </div>
        )}
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('sessionRetention.sectionTitle')}
        description={t('sessionRetention.sectionDescription')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('sessionRetention.autoTitleLabel')}
            description={t('sessionRetention.autoTitleDescription')}
          >
            <SettingsToggle
              checked={settings.autoTitleSessions}
              onChange={(autoTitleSessions) => void saveSettings({ autoTitleSessions })}
              ariaLabel={t('sessionRetention.autoTitleLabel')}
              disabled={isSaving}
            />
          </SettingsRow>
          <SettingsRow
            label={t('sessionRetention.enableLabel')}
            description={t('sessionRetention.enableDescription')}
          >
            <SettingsToggle
              checked={settings.enabled}
              onChange={handleEnabledChange}
              ariaLabel={t('sessionRetention.enableLabel')}
              disabled={isSaving}
            />
          </SettingsRow>

          <SettingsRow
            label={t('sessionRetention.thresholdLabel')}
            description={t('sessionRetention.thresholdDescription')}
          >
            <select
              value={settings.inactiveDays}
              disabled={isSaving}
              onChange={(event) => void saveSettings({ inactiveDays: Number(event.target.value) })}
              aria-label={t('sessionRetention.thresholdLabel')}
              className={SELECT_CLASS_NAME}
            >
              {dayOptions.map((days) => (
                <option key={days} value={days}>{t('sessionRetention.days', { count: days })}</option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('sessionRetention.actionLabel')}
            description={isDelete ? t('sessionRetention.actionDeleteDescription') : t('sessionRetention.actionArchiveDescription')}
          >
            <select
              value={settings.action}
              disabled={isSaving}
              onChange={(event) => handleActionChange(event.target.value as SessionRetentionAction)}
              aria-label={t('sessionRetention.actionLabel')}
              className={SELECT_CLASS_NAME}
            >
              <option value="archive">{t('sessionRetention.actions.archive')}</option>
              <option value="delete">{t('sessionRetention.actions.delete')}</option>
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('sessionRetention.skipStarredLabel')}
            description={t('sessionRetention.skipStarredDescription')}
          >
            <SettingsToggle
              checked={settings.skipStarredProjects}
              onChange={(skipStarredProjects) => void saveSettings({ skipStarredProjects })}
              ariaLabel={t('sessionRetention.skipStarredLabel')}
              disabled={isSaving}
            />
          </SettingsRow>
        </SettingsCard>

        {isDelete && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{t('sessionRetention.deleteWarning')}</p>
          </div>
        )}

        <p className="px-1 text-xs text-muted-foreground">{t('sessionRetention.neverTouched')}</p>
      </SettingsSection>

      <SettingsSection
        title={t('sessionRetention.previewTitle')}
        description={t('sessionRetention.previewDescription')}
      >
        <SettingsCard className="space-y-3 p-4">
          {isPreviewLoading && !preview ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('sessionRetention.loading')}
            </div>
          ) : preview ? (
            <>
              <p className="text-sm font-medium text-foreground" data-testid="session-retention-count">
                {isDelete
                  ? t('sessionRetention.previewCountDelete', { count: preview.total })
                  : t('sessionRetention.previewCountArchive', { count: preview.total })}
              </p>
              {preview.total > preview.batchLimit && (
                <p className="text-xs text-muted-foreground">
                  {t('sessionRetention.batchNote', { count: preview.batchLimit })}
                </p>
              )}
              {preview.sessions.length > 0 && (
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {preview.sessions.map((session) => (
                    <li key={session.sessionId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate text-foreground">{session.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {session.projectName ?? session.projectPath ?? ''}
                          {session.isArchived ? ` · ${t('sessionRetention.archivedBadge')}` : ''}
                        </div>
                      </div>
                      <div className="shrink-0 text-xs text-muted-foreground">
                        {formatDateTime(session.lastActivity)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              variant={isDelete ? 'destructive' : 'default'}
              size="sm"
              disabled={isRunning || isSaving || !preview || preview.total === 0}
              onClick={handleRunNow}
            >
              {isRunning && <Loader2 className="animate-spin" />}
              {t('sessionRetention.runNow')}
            </Button>
            {errorKey && <span className="text-sm text-destructive">{t(`sessionRetention.errors.${errorKey}`)}</span>}
          </div>

          <p className="text-xs text-muted-foreground" data-testid="session-retention-last-run">
            {status?.lastRun
              ? t('sessionRetention.lastRun.label', {
                time: formatDateTime(status.lastRun.finishedAt),
                summary: describeRun(status.lastRun),
              })
              : t('sessionRetention.lastRun.never')}
          </p>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
