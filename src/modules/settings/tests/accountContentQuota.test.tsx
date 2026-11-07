import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

import '@/modules/i18n';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type { ProviderAuthStatus } from '@/shared/types';

// OpenCode has no quota of its own — it bills whichever account it is signed
// in with — so its account tab must not show a usage-limits panel.

const { quota } = vi.hoisted(() => ({ quota: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: { providers: { cliStatus: () => new Promise<Response>(() => {}), quota } },
  };
});

const connected: ProviderAuthStatus = {
  authenticated: true, email: 'claude-code credentials', method: 'credentials_store', error: null, loading: false,
};

describe('AccountContent usage limits', () => {
  it('does not show or fetch quota for OpenCode', () => {
    render(<AccountContent agent="opencode" authStatus={connected} onLogin={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Usage limits' })).toBeNull();
    expect(quota).not.toHaveBeenCalled();
  });

  it('shows the usage-limits panel for Claude', () => {
    render(<AccountContent agent="claude" authStatus={connected} onLogin={() => {}} />);
    expect(screen.getByRole('region', { name: 'Usage limits' })).toBeTruthy();
  });
});
