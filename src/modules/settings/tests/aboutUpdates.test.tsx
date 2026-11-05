import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import AboutTab from '@/modules/settings/tabs/AboutTab';
import { api } from '@/shared/api';
import type { api as ApiType } from '@/shared/api';

vi.mock('@/shared/api', async (importOriginal) => {
  const original = await importOriginal<{ api: typeof ApiType }>();
  return {
    ...original,
    api: {
      ...original.api,
      updates: {
        get: vi.fn(),
        apply: vi.fn(),
        health: vi.fn(),
      },
    },
  };
});

const status = {
  current: '1.0.0', latest: '1.1.0', updateAvailable: true,
  installMode: 'npm', canSelfUpdate: true,
  releaseUrl: 'https://example.com/releases/1.1.0', checkedAt: new Date().toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

it('shows an available update and release notes, and checks again on demand', async () => {
  vi.mocked(api.updates.get).mockResolvedValue(status);
  render(<AboutTab />);
  expect(await screen.findByText('Version 1.1.0 available')).toBeTruthy();
  expect(screen.getByRole('link', { name: /View release notes/ }).getAttribute('href')).toBe(status.releaseUrl);
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(api.updates.get).toHaveBeenCalledTimes(2));
});

it('requires confirmation before applying an update', async () => {
  vi.mocked(api.updates.get).mockResolvedValue(status);
  vi.stubGlobal('confirm', vi.fn(() => false));
  render(<AboutTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(api.updates.apply).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('gives instructions instead of an update button when self-update is unavailable', async () => {
  vi.mocked(api.updates.get).mockResolvedValue({ ...status, installMode: 'git', canSelfUpdate: false });
  render(<AboutTab />);
  expect(await screen.findByText(/git pull && npm ci && npm run build/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
});
