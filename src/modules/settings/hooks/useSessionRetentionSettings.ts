import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  SessionRetentionPreview,
  SessionRetentionRun,
  SessionRetentionSettings,
  SessionRetentionStatus,
} from '@/shared/types';

type ErrorKey = 'loadFailed' | 'saveFailed' | 'previewFailed' | 'runFailed';

/**
 * Loads, saves, previews and runs the server-side inactive-session cleanup.
 *
 * Used by the settings module's Sessions tab. Every change is persisted on the
 * server immediately (there is no draft state), and the preview is re-read
 * after each save or run so the count always matches the saved settings.
 */
export function useSessionRetentionSettings() {
  // Saved settings and last-run outcome as the server reports them; null until the first load.
  const [status, setStatus] = useState<SessionRetentionStatus | null>(null);
  // What the saved settings would select right now; refreshed after every save or run.
  const [preview, setPreview] = useState<SessionRetentionPreview | null>(null);
  // Separate busy flags: saving disables the controls, running disables the run button only.
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(true);
  // Translation key (under `sessionRetention.errors`) of the last failure, cleared by the next action.
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);

  // Callers that refresh an existing preview raise `isPreviewLoading` first;
  // the initial load starts with it already raised.
  const loadPreview = useCallback(async () => {
    try {
      const payload = await readApiJson<{ data: SessionRetentionPreview }>(await api.sessionRetention.preview());
      setPreview(payload.data);
    } catch {
      setErrorKey('previewFailed');
    } finally {
      setIsPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await readApiJson<{ data: SessionRetentionStatus }>(await api.sessionRetention.settings());
        if (!cancelled) {
          setStatus(payload.data);
        }
      } catch {
        if (!cancelled) {
          setErrorKey('loadFailed');
        }
      }
      if (!cancelled) {
        await loadPreview();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  const saveSettings = useCallback(async (patch: Partial<SessionRetentionSettings>) => {
    setIsSaving(true);
    setErrorKey(null);
    try {
      const payload = await readApiJson<{ data: SessionRetentionStatus }>(
        await api.sessionRetention.saveSettings(patch),
      );
      setStatus(payload.data);
      setIsPreviewLoading(true);
      await loadPreview();
    } catch {
      setErrorKey('saveFailed');
    } finally {
      setIsSaving(false);
    }
  }, [loadPreview]);

  const runNow = useCallback(async (): Promise<SessionRetentionRun | null> => {
    setIsRunning(true);
    setErrorKey(null);
    try {
      const payload = await readApiJson<{ data: SessionRetentionRun }>(await api.sessionRetention.runNow());
      setStatus((previous) => (previous ? { ...previous, lastRun: payload.data } : previous));
      setIsPreviewLoading(true);
      await loadPreview();
      return payload.data;
    } catch {
      setErrorKey('runFailed');
      return null;
    } finally {
      setIsRunning(false);
    }
  }, [loadPreview]);

  return {
    status,
    preview,
    isSaving,
    isRunning,
    isPreviewLoading,
    errorKey,
    saveSettings,
    runNow,
  };
}
