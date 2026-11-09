import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import { Button, Input, Select } from '@/shared/ui';

type CodexRulesResponse = { data: { files: { name: string; content: string }[] } };

type RuleFile = { name: string; content: string };

/** Used by the settings permissions panel to edit the native Codex rule file as text. */
export default function CodexRuleFileEditor() {
  const { t } = useTranslation('settings');
  // Holds all native rule files; only the selected file is edited at a time.
  const [files, setFiles] = useState<RuleFile[] | null>(null);
  // Keeps the selected file stable when its text changes.
  const [selectedName, setSelectedName] = useState('default.rules');
  // Holds an unsaved draft without persisting each keystroke.
  const [content, setContent] = useState('');
  // Distinguishes creating a file from selecting an existing one.
  const [creating, setCreating] = useState(false);
  // Reports a failed initial read independently of a failed save.
  const [loadError, setLoadError] = useState(false);
  // Locks the editor during a write to avoid overlapping saves.
  const [saving, setSaving] = useState(false);
  // Keeps the unsaved draft visible after a failed write.
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await readApiJson<CodexRulesResponse>(await api.providers.codexRules());
        if (!cancelled) {
          setFiles(payload.data.files);
          const initial = payload.data.files.find((file) => file.name === 'default.rules') ?? payload.data.files[0];
          setSelectedName(initial?.name ?? 'default.rules');
          setContent(initial?.content ?? '');
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.rules$/.test(selectedName) || selectedName.includes('..')) return;
    setSaving(true);
    setSaveError(false);
    try {
      const payload = await readApiJson<{ data: RuleFile }>(await api.providers.saveCodexRules(selectedName, content));
      setContent(payload.data.content);
      setFiles((previous) => [...(previous ?? []).filter((file) => file.name !== selectedName), payload.data].sort((a, b) => a.name.localeCompare(b.name)));
      setCreating(false);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="codex-rule-file-editor">
      <SettingsSection title={t('permissions.nativeRules.codex.title')} description={t('permissions.nativeRules.codex.description')}>
        <SettingsCard>
          <details className="px-4 py-3 text-sm text-muted-foreground">
            <summary className="cursor-pointer">{t('permissions.nativeRules.modeNote')}</summary>
            <p className="mt-2 font-mono text-xs">{t('permissions.nativeRules.codex.directory')}</p>
          </details>
          {loadError && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{t('permissions.nativeRules.codex.loadFailed')}</p>}
          {!loadError && files === null && <p className="px-4 pb-3 text-sm text-muted-foreground">{t('permissions.nativeRules.loading')}</p>}
          {files !== null && (
            <>
              <SettingsRow label={t('permissions.nativeRules.codex.file')} stacked className="border-t border-border">
                <Select
                  aria-label={t('permissions.nativeRules.codex.file')}
                  value={creating ? '__new__' : selectedName}
                  onChange={(event) => {
                    const next = files.find((file) => file.name === event.target.value);
                    setSelectedName(next?.name ?? 'default.rules');
                    setContent(next?.content ?? '');
                    setCreating(!next);
                  }}
                >
                  {files.map((file) => (
                    <option key={file.name} value={file.name}>{file.name}</option>
                  ))}
                  <option value="__new__">{t('permissions.nativeRules.codex.newFile')}</option>
                </Select>
              </SettingsRow>
              {creating && (
                <div className="px-4 pb-3">
                  <Input
                    aria-label={t('permissions.nativeRules.codex.fileName')}
                    value={selectedName}
                    onChange={(event) => setSelectedName(event.target.value)}
                  />
                </div>
              )}
              <div className="px-4 pb-3">
                <textarea
                  aria-label={t('permissions.nativeRules.codex.title')}
                  className="min-h-48 w-full rounded-md border border-input bg-background p-3 font-mono text-sm"
                  spellCheck={false}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    const selected = files.find((file) => file.name === selectedName);
                    setContent(selected?.content ?? '');
                    if (creating) {
                      setSelectedName(files[0]?.name ?? 'default.rules');
                      setContent(files[0]?.content ?? '');
                      setCreating(false);
                    }
                    setSaveError(false);
                  }}
                >
                  {t('actions.cancelChanges')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.rules$/.test(selectedName) || selectedName.includes('..')}
                  onClick={() => void save()}
                >
                  {saving ? t('saveStatus.saving') : t('actions.saveChanges')}
                </Button>
              </div>
            </>
          )}
          {saveError && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{t('permissions.nativeRules.codex.saveFailed')}</p>}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
