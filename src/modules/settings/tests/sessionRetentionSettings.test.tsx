import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import SessionRetentionSettingsTab from '@/modules/settings/tabs/session-retention-settings/SessionRetentionSettingsTab';
import type { SessionRetentionPreview, SessionRetentionSettings } from '@/shared/types';

const calls: string[] = [];
const state: { settings: SessionRetentionSettings; preview: SessionRetentionPreview } = {
  settings: { enabled: false, inactiveDays: 30, action: 'archive', skipStarredProjects: true },
  preview: { cutoff: '2026-01-01T00:00:00.000Z', total: 0, batchLimit: 100, sessions: [] },
};

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      sessionRetention: {
        settings: async () => json({ settings: state.settings, lastRun: null }),
        saveSettings: async (patch: Partial<SessionRetentionSettings>) => {
          calls.push(`save:${JSON.stringify(patch)}`);
          state.settings = { ...state.settings, ...patch };
          return json({ settings: state.settings, lastRun: null });
        },
        preview: async () => json(state.preview),
        runNow: async () => {
          calls.push('run');
          return json({
            trigger: 'manual', action: state.settings.action, inactiveDays: 30,
            cutoff: '2026-01-01T00:00:00.000Z', startedAt: '2026-02-01T00:00:00.000Z',
            finishedAt: '2026-02-01T00:00:00.000Z', archived: 2, deleted: 0, deletedFromDisk: 0,
            skippedBusy: 0, failed: 0, remaining: 0,
          });
        },
      },
    },
  };
});

describe('SessionRetentionSettingsTab', () => {
  beforeEach(() => {
    calls.length = 0;
    state.settings = { enabled: false, inactiveDays: 30, action: 'archive', skipStarredProjects: true };
    state.preview = {
      cutoff: '2026-01-01T00:00:00.000Z',
      total: 2,
      batchLimit: 100,
      sessions: [
        { sessionId: 's1', provider: 'claude', title: 'Nightly report', projectPath: '/p', projectName: 'Demo', isArchived: false, lastActivity: '2025-11-01T00:00:00.000Z' },
        { sessionId: 's2', provider: 'codex', title: 'Old fix', projectPath: '/p', projectName: 'Demo', isArchived: false, lastActivity: '2025-11-02T00:00:00.000Z' },
      ],
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the preview count, the oldest sessions and that nothing has run yet', async () => {
    render(<SessionRetentionSettingsTab />);
    expect(await screen.findByText('2 sessions would be archived.')).toBeTruthy();
    expect(screen.getByText('Nightly report')).toBeTruthy();
    expect(screen.getByText('No cleanup has run yet.')).toBeTruthy();
  });

  it('does not switch to delete unless the user confirms, and warns once it does', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<SessionRetentionSettingsTab />);
    const actionSelect = await screen.findByRole('combobox', { name: 'Action' });

    fireEvent.change(actionSelect, { target: { value: 'delete' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);

    fireEvent.change(actionSelect, { target: { value: 'delete' } });
    await waitFor(() => expect(calls).toEqual(['save:{"action":"delete"}']));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText('2 sessions would be permanently deleted.')).toBeTruthy();
  });

  it('runs the cleanup after confirmation and shows the result as the last run', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SessionRetentionSettingsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run cleanup now' }));
    await waitFor(() => expect(calls).toEqual(['run']));
    expect(await screen.findByText(/2 archived/)).toBeTruthy();
  });
});
