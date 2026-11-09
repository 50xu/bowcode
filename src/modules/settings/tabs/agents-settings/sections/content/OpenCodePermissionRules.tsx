import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { api, readApiJson } from '@/shared/api';
import { Button, Input, Select } from '@/shared/ui';

type Action = 'allow' | 'ask' | 'deny';
type PatternRules = Record<string, Action>;
type Permission = string | Record<string, unknown> | null;
type RulesResponse = { data: { path: string; permission: Permission } };

const ACTIONS: Action[] = ['allow', 'ask', 'deny'];
const TOOLS = [
  'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'webfetch',
  'websearch', 'external_directory', 'skill', 'todowrite',
];
const PATTERN_TOOLS = ['bash', 'edit', 'external_directory'];

function isAction(value: unknown): value is Action {
  return ACTIONS.includes(value as Action);
}

function isPatternRules(value: unknown): value is PatternRules {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(isAction);
}

/** Used by the provider Permissions panel to edit native OpenCode rules without exposing other config keys. */
export default function OpenCodePermissionRules() {
  const { t } = useTranslation('settings');
  // Retains every native tool key, including unknown or unsupported rules, across edits.
  const [permission, setPermission] = useState<Permission>(null);
  // Distinguishes a loaded config without rules from a pending request.
  const [loaded, setLoaded] = useState(false);
  // Displays the actual config file selected by the backend (JSON or JSONC).
  const [filePath, setFilePath] = useState('');
  // The draft pattern is kept outside the saved permission until Add is clicked.
  const [pattern, setPattern] = useState('');
  // Chooses the tool for the draft pattern without changing saved rules.
  const [patternTool, setPatternTool] = useState('bash');
  // Chooses the action for the draft pattern without changing saved rules.
  const [patternAction, setPatternAction] = useState<Action>('ask');
  // Holds a failed read or write message without hiding the current draft.
  const [error, setError] = useState('');
  // Prevents overlapping writes from overwriting each other.
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await readApiJson<RulesResponse>(await api.providers.opencodePermissionRules());
        if (!cancelled) {
          setPermission(response.data.permission);
          setFilePath(response.data.path);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setError(t('permissions.nativeRules.opencode.loadFailed'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const rules = permission && typeof permission === 'object' && !Array.isArray(permission)
    ? permission
    : {};
  const globalAction = typeof permission === 'string' ? permission : '';
  const patternRows = PATTERN_TOOLS.flatMap((tool) => {
    const value = rules[tool];
    return isPatternRules(value)
      ? Object.entries(value).map(([name, action]) => ({ tool, name, action }))
      : [];
  });
  const preservedKeys = Object.keys(rules).filter((tool) =>
    !TOOLS.includes(tool) || (rules[tool] !== undefined && !isAction(rules[tool]) && !isPatternRules(rules[tool])));
  const selectedRules = rules[patternTool];
  const canAddPattern = !saving && !globalAction && pattern.trim() &&
    (selectedRules === undefined || isAction(selectedRules) || isPatternRules(selectedRules)) &&
    !(isPatternRules(selectedRules) && selectedRules[pattern.trim()]);

  const changeTool = (tool: string, value: unknown) => {
    const next = { ...rules };
    if (value === null) {
      delete next[tool];
    } else {
      next[tool] = value;
    }
    setPermission(next);
  };

  const changePattern = (tool: string, name: string, value: Action | null) => {
    const existing = rules[tool];
    const next = isPatternRules(existing) ? { ...existing } : {};
    if (value === null) {
      delete next[name];
    } else {
      next[name] = value;
    }
    changeTool(tool, Object.keys(next).length ? next : null);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await readApiJson<RulesResponse>(
        await api.providers.saveOpencodePermissionRules(permission),
      );
      setPermission(response.data.permission);
      setFilePath(response.data.path);
    } catch {
      setError(t('permissions.nativeRules.opencode.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const actionOptions = (includeInherit: boolean) => (
    <>
      {includeInherit && <option value="">{t('permissions.nativeRules.opencode.inherit')}</option>}
      {ACTIONS.map((action) => (
        <option key={action} value={action}>
          {t(`permissions.settingsFiles.groups.${action}`)}
        </option>
      ))}
    </>
  );

  return (
    <div className="space-y-3" data-testid="opencode-permission-rules">
      <SettingsSection title={t('permissions.nativeRules.opencode.title')} description={t('permissions.nativeRules.opencode.description')}>
        <SettingsCard>
          <div className="flex min-w-0 items-center gap-2 px-4 py-3">
            <span className="shrink-0 text-sm font-medium text-foreground">{t('permissions.nativeRules.opencode.file')}</span>
            {filePath && (
              <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={filePath}>{filePath}</span>
            )}
          </div>
          {error && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error}</p>}
          {!loaded && !error && <p className="px-4 pb-3 text-xs text-muted-foreground">{t('permissions.nativeRules.loading')}</p>}
          {loaded && (
            <>
              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                <span className="text-sm font-medium text-foreground">{t('permissions.nativeRules.opencode.globalAction')}</span>
                <Select
                  aria-label={t('permissions.nativeRules.opencode.globalAction')}
                  className="w-28"
                  value={globalAction}
                  onChange={(event) => setPermission(event.target.value || null)}
                  disabled={saving || (globalAction !== '' && !isAction(globalAction))}
                >
                  {actionOptions(true)}
                </Select>
              </div>
              {globalAction && !isAction(globalAction) && (
                <p className="px-4 pb-2 font-mono text-xs text-muted-foreground">{globalAction}</p>
              )}
              <div className="grid grid-cols-1 border-t border-border px-4 py-2 sm:grid-cols-2 sm:gap-x-6">
                {TOOLS.map((tool) => {
                  const value = rules[tool];
                  const unsupported = value !== undefined && !isAction(value) && !isPatternRules(value);
                  return (
                    <div key={tool} className="flex min-h-11 min-w-0 items-center justify-between gap-3">
                      <span className="truncate font-mono text-sm" title={tool}>{tool}</span>
                      <Select
                        aria-label={tool}
                        className="w-28"
                        value={isAction(value) ? value : ''}
                        disabled={saving || Boolean(globalAction) || unsupported}
                        onChange={(event) => changeTool(tool, event.target.value || null)}
                      >
                        {actionOptions(true)}
                      </Select>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-2 border-t border-border px-4 py-3">
                <h4 className="text-sm font-medium text-foreground">{t('permissions.nativeRules.opencode.patternRules')}</h4>
                {patternRows.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('permissions.nativeRules.opencode.noPatterns')}</p>
                )}
                {patternRows.map(({ tool, name, action }) => (
                  <div key={`${tool}:${name}`} className="flex min-w-0 items-center gap-2">
                    <code className="w-28 shrink-0 truncate text-xs" title={tool}>{tool}</code>
                    <code className="min-w-0 flex-1 truncate text-xs" title={name}>{name}</code>
                    <Select
                      aria-label={`${tool} ${name}`}
                      className="w-28"
                      value={action}
                      disabled={saving || Boolean(globalAction)}
                      onChange={(event) => changePattern(tool, name, event.target.value as Action)}
                    >
                      {actionOptions(false)}
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={saving || Boolean(globalAction)}
                      aria-label={`${t('permissions.nativeRules.opencode.remove')} ${tool} ${name}`}
                      onClick={() => changePattern(tool, name, null)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <div className="flex min-w-0 items-center gap-2">
                  <Select
                    aria-label={t('permissions.nativeRules.opencode.tool')}
                    className="w-28"
                    value={patternTool}
                    disabled={saving || Boolean(globalAction)}
                    onChange={(event) => setPatternTool(event.target.value)}
                  >
                    {PATTERN_TOOLS.map((tool) => <option key={tool} value={tool}>{tool}</option>)}
                  </Select>
                  <Input
                    aria-label={t('permissions.nativeRules.opencode.pattern')}
                    placeholder="git status *"
                    className="min-w-0 flex-1 font-mono"
                    value={pattern}
                    disabled={saving || Boolean(globalAction)}
                    onChange={(event) => setPattern(event.target.value)}
                  />
                  <Select
                    aria-label={t('permissions.nativeRules.opencode.action')}
                    className="w-28"
                    value={patternAction}
                    disabled={saving || Boolean(globalAction)}
                    onChange={(event) => setPatternAction(event.target.value as Action)}
                  >
                    {actionOptions(false)}
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canAddPattern}
                    onClick={() => {
                      changePattern(patternTool, pattern.trim(), patternAction);
                      setPattern('');
                    }}
                  >
                    {t('permissions.nativeRules.opencode.add')}
                  </Button>
                </div>
              </div>
              {preservedKeys.length > 0 && (
                <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  {t('permissions.nativeRules.opencode.preservedKeys', { keys: preservedKeys.join(', ') })}
                </p>
              )}
              <div className="flex justify-end border-t border-border px-4 py-3">
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || (globalAction !== '' && !isAction(globalAction))}
                  onClick={() => void save()}
                >
                  {saving ? t('saveStatus.saving') : t('actions.saveChanges')}
                </Button>
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
