import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useSettingsSync } from '@/modules/settings/hooks/useSettingsSync';
import { Button, Input } from '@/shared/ui';

const CATEGORIES = ['preferences', 'notifications', 'providerModels', 'plugins', 'gitIdentity', 'mcp', 'claudeConfig'] as const;

/** Rendered by Settings to configure and operate repository-backed settings sync. */
export default function SyncSettingsTab() {
  const { t } = useTranslation('settings');
  const { config, setConfig, tokens, status, busy, message, missingPlugins, save, push, pull, disconnect } = useSettingsSync();
  return (
    <div className="space-y-6">
      <SettingsSection title={t('sync.repositorySection', { defaultValue: 'Repository' })} description={t('sync.description')}>
        <SettingsCard divided>
          <SettingsRow stacked label={t('sync.repository')} description={t('sync.repositoryHint')}>
            <Input className="w-full" type="text" value={config.repoUrl} placeholder="https://github.com/owner/settings.git" onChange={(event) => setConfig({ ...config, repoUrl: event.target.value })} />
          </SettingsRow>
          <SettingsRow stacked label={t('sync.branch')}>
            <Input className="w-full" value={config.branch} onChange={(event) => setConfig({ ...config, branch: event.target.value })} />
          </SettingsRow>
          <SettingsRow stacked label={t('sync.token')} description={t('sync.tokenHint')}>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={config.githubTokenId ?? ''} onChange={(event) => setConfig({ ...config, githubTokenId: event.target.value ? Number(event.target.value) : null })}>
              <option value="">{t('sync.noToken')}</option>
              {tokens.map((token) => <option key={token.id} value={token.id}>{token.credential_name}</option>)}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t('sync.categories')}>
        <SettingsCard divided>
          {CATEGORIES.map((category) => (
            <SettingsRow key={category} label={t(`sync.${category}`)}>
              <SettingsToggle checked={config.include[category]} onChange={(checked) => setConfig({ ...config, include: { ...config.include, [category]: checked } })} ariaLabel={t(`sync.${category}`)} />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t('sync.status')}>
        <SettingsCard className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">{(status?.cloned ?? config.cloned) ? t('sync.connected') : t('sync.notConnected')}</p>
          {status?.lastSyncAt && <p className="text-sm">{t('sync.lastSync')}: {new Date(status.lastSyncAt).toLocaleString()}</p>}
          {status?.lastAction && <p className="text-sm">{t('sync.lastAction')}: {status.lastAction}</p>}
          {status?.lastCommit && <p className="break-all text-sm">{t('sync.lastCommit')}: {status.lastCommit}</p>}
          {status?.lastError && <p role="alert" className="text-sm text-destructive">{status.lastError}</p>}
          {message && <p role="status" className="text-sm">{message}</p>}
          {missingPlugins.length > 0 && <div className="space-y-2 text-sm"><p>{t('sync.missingPlugins', { names: missingPlugins.join(', ') })}</p><Button onClick={() => window.location.reload()}>{t('sync.reload')}</Button></div>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !config.repoUrl.trim() || !config.branch.trim()} onClick={() => void save()}>{t('sync.save')}</Button>
            <Button variant="outline" disabled={busy || !config.repoUrl.trim()} onClick={() => void push()}>{t('sync.push')}</Button>
            <Button variant="outline" disabled={busy || !config.repoUrl.trim()} onClick={() => void pull()}>{t('sync.pull')}</Button>
            <Button variant="ghost" disabled={busy || !config.repoUrl.trim()} onClick={() => void disconnect()}>{t('sync.disconnect')}</Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
