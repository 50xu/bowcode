import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ClaudeSettingsFileRules from '@/modules/settings/tabs/agents-settings/sections/content/ClaudeSettingsFileRules';
import { Button, Input, Select } from '@/shared/ui';
import type { AgentProvider } from '@/shared/types';
import { api } from '@/shared/api';
import OpenCodePermissionRules from '@/modules/settings/tabs/agents-settings/sections/content/OpenCodePermissionRules';
import CodexRuleFileEditor from '@/modules/settings/tabs/agents-settings/sections/content/CodexRuleFileEditor';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

const COMMON_CLAUDE_TOOLS = [
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Write',
  'Read',
  'Edit',
  'Glob',
  'Grep',
  'MultiEdit',
  'Task',
  'TodoWrite',
  'TodoRead',
  'WebFetch',
  'WebSearch',
];

const addUnique = (items: string[], value: string): string[] => {
  const normalizedValue = value.trim();
  if (!normalizedValue || items.includes(normalizedValue)) {
    return items;
  }

  return [...items, normalizedValue];
};

const removeValue = (items: string[], value: string): string[] => (
  items.filter((item) => item !== value)
);

type ClaudePermissionsProps = {
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
  allowedTools: string[];
  onAllowedToolsChange: (value: string[]) => void;
  disallowedTools: string[];
  onDisallowedToolsChange: (value: string[]) => void;
};

function ClaudePermissions({
  skipPermissions,
  onSkipPermissionsChange,
  allowedTools,
  onAllowedToolsChange,
  disallowedTools,
  onDisallowedToolsChange,
}: ClaudePermissionsProps) {
  const { t } = useTranslation('settings');
  const [newAllowedTool, setNewAllowedTool] = useState('');
  const [newDisallowedTool, setNewDisallowedTool] = useState('');

  const handleAddAllowedTool = (tool: string) => {
    const updated = addUnique(allowedTools, tool);
    if (updated.length === allowedTools.length) {
      return;
    }

    onAllowedToolsChange(updated);
    setNewAllowedTool('');
  };

  const handleAddDisallowedTool = (tool: string) => {
    const updated = addUnique(disallowedTools, tool);
    if (updated.length === disallowedTools.length) {
      return;
    }

    onDisallowedToolsChange(updated);
    setNewDisallowedTool('');
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t('permissions.title')}>
        <SettingsCard>
          <SettingsRow label={t('permissions.skipPermissions.label')} description={t('permissions.skipPermissions.claudeDescription')}>
            <SettingsToggle
              checked={skipPermissions}
              onChange={onSkipPermissionsChange}
              ariaLabel={t('permissions.skipPermissions.label')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('permissions.allowedTools.title')} description={t('permissions.allowedTools.description')}>
        <SettingsCard className="space-y-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newAllowedTool}
            onChange={(event) => setNewAllowedTool(event.target.value)}
            placeholder={t('permissions.allowedTools.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddAllowedTool(newAllowedTool);
              }
            }}
            className="flex-1"
          />
          <Button
            onClick={() => handleAddAllowedTool(newAllowedTool)}
            disabled={!newAllowedTool.trim()}
            size="sm"
          >
            <Plus className="mr-2 h-4 w-4 sm:mr-0" />
            <span className="sm:hidden">{t('permissions.actions.add')}</span>
          </Button>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('permissions.allowedTools.quickAdd')}</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {COMMON_CLAUDE_TOOLS.map((tool) => (
              <Button
                key={tool}
                variant="outline"
                size="sm"
                onClick={() => handleAddAllowedTool(tool)}
                disabled={allowedTools.includes(tool)}
                className="h-8 text-xs"
              >
                {tool}
              </Button>
            ))}
          </div>
        </details>

        <div className="divide-y divide-border rounded-lg border border-border">
          {allowedTools.map((tool) => (
            <div key={tool} className="flex items-center justify-between gap-2 px-3 py-1">
              <span className="min-w-0 break-all font-mono text-xs text-foreground">{tool}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAllowedToolsChange(removeValue(allowedTools, tool))}
                aria-label={`${t('permissions.nativeRules.opencode.remove')} ${tool}`}
                className="h-7 w-7 p-1 text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {allowedTools.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('permissions.allowedTools.empty')}
            </div>
          )}
        </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('permissions.blockedTools.title')} description={t('permissions.blockedTools.description')}>
        <SettingsCard className="space-y-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newDisallowedTool}
            onChange={(event) => setNewDisallowedTool(event.target.value)}
            placeholder={t('permissions.blockedTools.placeholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddDisallowedTool(newDisallowedTool);
              }
            }}
            className="flex-1"
          />
          <Button
            onClick={() => handleAddDisallowedTool(newDisallowedTool)}
            disabled={!newDisallowedTool.trim()}
            size="sm"
          >
            <Plus className="mr-2 h-4 w-4 sm:mr-0" />
            <span className="sm:hidden">{t('permissions.actions.add')}</span>
          </Button>
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          {disallowedTools.map((tool) => (
            <div key={tool} className="flex items-center justify-between gap-2 px-3 py-1">
              <span className="min-w-0 break-all font-mono text-xs text-foreground">{tool}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDisallowedToolsChange(removeValue(disallowedTools, tool))}
                aria-label={`${t('permissions.nativeRules.opencode.remove')} ${tool}`}
                className="h-7 w-7 p-1 text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {disallowedTools.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('permissions.blockedTools.empty')}
            </div>
          )}
        </div>
        </SettingsCard>
      </SettingsSection>

      <details className="rounded-xl border border-border bg-card/50 p-4 text-sm">
        <summary className="cursor-pointer font-medium text-foreground">{t('permissions.toolExamples.title')}</summary>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li><code className="rounded bg-muted px-1">"Bash(git log:*)"</code> {t('permissions.toolExamples.bashGitLog')}</li>
          <li><code className="rounded bg-muted px-1">"Bash(git diff:*)"</code> {t('permissions.toolExamples.bashGitDiff')}</li>
          <li><code className="rounded bg-muted px-1">"Write"</code> {t('permissions.toolExamples.write')}</li>
          <li><code className="rounded bg-muted px-1">"Bash(rm:*)"</code> {t('permissions.toolExamples.bashRm')}</li>
        </ul>
      </details>

      {/* Below the examples, so they stay next to the two inputs whose syntax they explain. */}
      <ClaudeSettingsFileRules />

    </div>
  );
}

type PermissionsContentProps = {
  agent: AgentProvider;
  defaultPermissionMode?: string;
  onDefaultPermissionModeChange?: (mode: string) => void;
  skipPermissions?: boolean;
  onSkipPermissionsChange?: (value: boolean) => void;
  allowedTools?: string[];
  onAllowedToolsChange?: (value: string[]) => void;
  disallowedTools?: string[];
  onDisallowedToolsChange?: (value: string[]) => void;
};

const FALLBACK_MODES: Record<AgentProvider, string[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/** Rendered by AgentCategoryContentSection for each provider's new-chat mode and native rules. */
export default function PermissionsContent({
  agent,
  defaultPermissionMode = '',
  onDefaultPermissionModeChange = () => {},
  skipPermissions = false,
  onSkipPermissionsChange = () => {},
  allowedTools = [],
  onAllowedToolsChange = () => {},
  disallowedTools = [],
  onDisallowedToolsChange = () => {},
}: PermissionsContentProps) {
  const { t } = useTranslation('settings');
  // Capability modes are loaded from the backend, with a first-paint fallback.
  const [modes, setModes] = useState(FALLBACK_MODES[agent]);

  useEffect(() => {
    setModes(FALLBACK_MODES[agent]);
    let cancelled = false;
    if (typeof api.providers.capabilities !== 'function') {
      return () => { cancelled = true; };
    }
    void api.providers.capabilities().then(async (response) => {
      const payload = await response.json() as {
        data?: { providers?: Array<{ provider: string; permissionModes: string[] }> };
      };
      const providerModes = payload.data?.providers?.find((item) => item.provider === agent)?.permissionModes;
      if (!cancelled && providerModes?.length) {
        setModes(providerModes);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent]);

  return (
    <div className="space-y-6">
      <SettingsSection title={t('permissions.defaultMode.section', { defaultValue: 'Defaults' })}>
        <SettingsCard>
          <SettingsRow
            label={t('permissions.defaultMode.title')}
            description={defaultPermissionMode
              ? t(`permissions.defaultMode.modes.${defaultPermissionMode}.description`)
              : t('permissions.defaultMode.description')}
            stacked
          >
            <Select
              name={`${agent}-default-permission-mode`}
              aria-label={t('permissions.defaultMode.title')}
              value={defaultPermissionMode}
              onChange={(event) => onDefaultPermissionModeChange(event.target.value)}
              className="w-full"
            >
              {['', ...modes].map((mode) => (
                <option key={mode} value={mode}>
                  {mode ? t(`permissions.defaultMode.modes.${mode}.title`) : t('permissions.defaultMode.remember.title')}
                </option>
              ))}
            </Select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      {agent === 'claude' && (
        <ClaudePermissions
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={onSkipPermissionsChange}
          allowedTools={allowedTools}
          onAllowedToolsChange={onAllowedToolsChange}
          disallowedTools={disallowedTools}
          onDisallowedToolsChange={onDisallowedToolsChange}
        />
      )}
      {agent === 'codex' && <CodexRuleFileEditor />}
      {agent === 'opencode' && <OpenCodePermissionRules />}
    </div>
  );
}
