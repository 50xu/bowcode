import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ClaudeSettingsPermissionSource } from '@/shared/types';

type ClaudeSettingsPermissionsResponse = {
  data?: { sources?: ClaudeSettingsPermissionSource[] };
};

/**
 * Used by ClaudeSettingsFileRules (Claude permissions panel) to load the
 * permission rules the Claude CLI reads from its own settings files and edit
 * the user's rules without changing administrator-managed settings.
 */
export function useClaudeSettingsPermissionRules() {
  // The files live on the server; null until it answers, so the panel shows a
  // loading line instead of claiming there are no rules.
  const [sources, setSources] = useState<ClaudeSettingsPermissionSource[] | null>(null);
  // The request itself failed (server unreachable or too old for the route),
  // which is different from one file being unreadable.
  const [loadFailed, setLoadFailed] = useState(false);
  // Blocks repeated writes and gives the editor a progress indicator.
  const [saving, setSaving] = useState(false);
  // Keeps write errors distinct from the initial read failure.
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await api.providers.claudeSettingsPermissions();
        const payload = await readApiJson<ClaudeSettingsPermissionsResponse>(response);
        if (!cancelled) {
          setSources(payload.data?.sources ?? []);
        }
      } catch (error) {
        console.error('Error loading Claude settings-file permission rules:', error);
        if (!cancelled) {
          setLoadFailed(true);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const changeUserRule = async (action: 'add' | 'remove', category: 'allow' | 'ask' | 'deny', rule: string): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    setSaveError(false);
    try {
      const response = action === 'add'
        ? await api.providers.addClaudeSettingsPermissionRule(category, rule)
        : await api.providers.removeClaudeSettingsPermissionRule(category, rule);
      const payload = await readApiJson<{ data: { source: ClaudeSettingsPermissionSource } }>(response);
      setSources((previous) => previous?.map((source) => source.scope === 'user' ? payload.data.source : source) ?? null);
      return true;
    } catch (error) {
      console.error('Error changing Claude settings-file permission rule:', error);
      setSaveError(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { sources, loadFailed, saving, saveError, changeUserRule };
}
