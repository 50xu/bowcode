import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { useClaudeSettingsPermissionRules } from '@/modules/settings/hooks/useClaudeSettingsPermissionRules';
import type { ClaudeSettingsPermissionSource } from '@/shared/types';
import { Button, Input, Select } from '@/shared/ui';

const RULE_GROUPS = [
  { key: 'allow', chipClassName: 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200' },
  { key: 'ask', chipClassName: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200' },
  { key: 'deny', chipClassName: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200' },
] as const;

function SettingsFileCard({ source, onRemove, saving }: { source: ClaudeSettingsPermissionSource; onRemove?: (category: 'allow' | 'ask' | 'deny', rule: string) => void; saving?: boolean }) {
  const { t } = useTranslation('settings');
  const hasRules = RULE_GROUPS.some(({ key }) => source[key].length > 0);

  return (
    <div className="space-y-2 border-t border-border px-4 py-3 first:border-t-0" data-testid={`claude-settings-file-${source.scope}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-sm font-medium text-foreground">{t(`permissions.settingsFiles.sources.${source.scope}`)}</span>
        <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={source.path}>{source.path}</span>
      </div>

      {source.status === 'invalid' && (
        <p className="text-xs text-muted-foreground">{t('permissions.settingsFiles.invalid')}</p>
      )}
      {source.status === 'missing' && (
        <p className="text-xs text-muted-foreground">{t('permissions.settingsFiles.missing')}</p>
      )}
      {source.status === 'ok' && !hasRules && (
        <p className="text-xs text-muted-foreground">{t('permissions.settingsFiles.empty')}</p>
      )}

      {RULE_GROUPS.filter(({ key }) => source[key].length > 0).map(({ key, chipClassName }) => (
        <div key={key} className="flex items-start gap-2" data-testid={`claude-settings-file-${source.scope}-${key}`}>
          <span className="w-12 shrink-0 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(`permissions.settingsFiles.groups.${key}`)}
          </span>
          <ul className="flex min-w-0 flex-wrap gap-1">
            {source[key].map((rule) => (
              <li key={rule} className={`max-w-full break-all rounded border px-1.5 py-0.5 font-mono text-xs ${chipClassName}`}>
                {rule}
                {onRemove && (
                  <button
                    type="button"
                    disabled={saving}
                    className="ml-1.5 font-sans"
                    aria-label={`${t('permissions.nativeRules.claude.remove')} ${rule}`}
                    onClick={() => onRemove(key, rule)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Used by PermissionsContent to show Claude's native rules and edit only the user file. */
export default function ClaudeSettingsFileRules() {
  const { t } = useTranslation('settings');
  const { sources, loadFailed, saving, saveError, changeUserRule } = useClaudeSettingsPermissionRules();
  // The new rule stays in the input until the server confirms the add.
  const [newRule, setNewRule] = useState('');
  // The selected group determines which list receives the new rule.
  const [category, setCategory] = useState<'allow' | 'ask' | 'deny'>('allow');

  // Missing managed files are normal outside managed installs.
  const visibleSources = (sources ?? []).filter((source) => source.scope === 'user' || source.status !== 'missing');

  const addRule = async () => {
    if (await changeUserRule('add', category, newRule.trim())) setNewRule('');
  };

  return (
    <div className="space-y-4" data-testid="claude-settings-file-rules">
      <SettingsSection title={t('permissions.settingsFiles.title')} description={t('permissions.settingsFiles.description')}>
        <SettingsCard>
          {loadFailed && (
            <p className="px-4 py-3 text-xs text-muted-foreground">{t('permissions.settingsFiles.loadFailed')}</p>
          )}
          {!loadFailed && sources === null && (
            <p className="px-4 py-3 text-xs text-muted-foreground">{t('permissions.settingsFiles.loading')}</p>
          )}
          {visibleSources.map((source) => (
            <div key={source.scope}>
              <SettingsFileCard
                source={source}
                saving={saving}
                onRemove={source.scope === 'user' && source.status !== 'invalid'
                  ? (group, rule) => { void changeUserRule('remove', group, rule); }
                  : undefined}
              />
              {source.scope === 'user' && source.status !== 'invalid' && (
                <form
                  className="flex min-w-0 items-center gap-2 px-4 pb-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!saving && newRule.trim()) void addRule();
                  }}
                >
                  <Input
                    aria-label={t('permissions.nativeRules.claude.rule')}
                    placeholder="Bash(npm run test:*)"
                    className="min-w-0 flex-1 font-mono"
                    value={newRule}
                    disabled={saving}
                    onChange={(event) => setNewRule(event.target.value)}
                  />
                  <Select
                    aria-label={t('permissions.nativeRules.claude.group')}
                    className="w-24"
                    value={category}
                    disabled={saving}
                    onChange={(event) => setCategory(event.target.value as typeof category)}
                  >
                    {RULE_GROUPS.map(({ key }) => (
                      <option key={key} value={key}>{t(`permissions.settingsFiles.groups.${key}`)}</option>
                    ))}
                  </Select>
                  <Button type="submit" size="sm" disabled={saving || !newRule.trim()}>
                    {saving ? t('saveStatus.saving') : t('permissions.actions.add')}
                  </Button>
                </form>
              )}
              {source.scope === 'user' && saveError && (
                <p role="alert" className="px-4 pb-3 text-xs text-destructive">{t('permissions.nativeRules.claude.saveFailed')}</p>
              )}
            </div>
          ))}
          <details className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('permissions.settingsFiles.details')}</summary>
            <p className="mt-2">{t('permissions.settingsFiles.projectNote')}</p>
          </details>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
