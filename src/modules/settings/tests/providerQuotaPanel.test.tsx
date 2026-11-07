import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProviderQuotaPanel } from '@/modules/settings/tabs/agents-settings/sections/content/ProviderQuotaPanel';

vi.mock('@/shared/hooks/useProviderQuota', () => ({
  useProviderQuota: () => ({
    loading: false,
    refresh: vi.fn(),
    quota: {
      provider: 'claude', status: 'ok', source: 'claude', planType: 'pro', fetchedAt: new Date().toISOString(),
      windows: [{ id: 'weekly', kind: 'weekly', label: 'Fable', usedPercent: 86, resetsAt: null, windowMinutes: null }],
    },
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'quota.title': 'Usage limits', 'quota.refresh': 'Refresh', 'quota.weekly': 'Weekly',
      'quota.percentUsed': `${values?.percent}% used`,
    }[key] ?? key),
    i18n: { language: 'en' },
  }),
}));

describe('ProviderQuotaPanel', () => {
  it('renders provider-specific window rows and a refresh action', () => {
    render(<ProviderQuotaPanel provider="claude" />);
    expect(screen.getByText('Weekly · Fable')).toBeTruthy();
    expect(screen.getByText('86% used')).toBeTruthy();
    expect(screen.getByRole('progressbar').querySelector('div')?.className).toContain('text-red-500');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});
