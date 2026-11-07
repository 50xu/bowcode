import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuotaWindowList, quotaResetLabel, quotaTone } from '@/shared/ui/QuotaWindowList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'quota.currentSession': `Current session (${values?.hours}h)`,
      'quota.weekly': 'Weekly',
      'quota.percentUsed': `${values?.percent}% used`,
      'quota.resetsInHours': `Resets in ${values?.hours}h ${values?.minutes}m`,
      'quota.resetsInMinutes': `Resets in ${values?.minutes}m`,
      'quota.resetsOn': `Resets on ${values?.date}`,
      'quota.unknown': 'Unavailable',
    }[key] ?? key),
    i18n: { language: 'en' },
  }),
}));

describe('quota windows', () => {
  it('shows localized session and weekly labels, usage and reset time', () => {
    render(<QuotaWindowList windows={[
      { id: 'session', kind: 'session', label: null, usedPercent: 62, resetsAt: new Date(Date.now() + 3 * 3600000 + 12 * 60000).toISOString(), windowMinutes: 300 },
      { id: 'weekly', kind: 'weekly', label: 'Fable', usedPercent: 90, resetsAt: null, windowMinutes: null },
    ]} />);
    expect(screen.getByText('Current session (5h)')).toBeTruthy();
    expect(screen.getByText('Weekly · Fable')).toBeTruthy();
    expect(screen.getByText('62% used')).toBeTruthy();
    expect(screen.getByText('90% used')).toBeTruthy();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0].querySelector('div')?.className).toContain('bg-current text-amber-500');
    expect(bars[1].querySelector('div')?.className).toContain('bg-current text-red-500');
  });

  it('formats near and distant deadlines and semantic thresholds', () => {
    const t = (key: string, values?: Record<string, unknown>) => `${key}: ${JSON.stringify(values)}`;
    expect(quotaResetLabel(new Date(3 * 3600000 + 12 * 60000).toISOString(), t, 0)).toContain('"hours":3');
    expect(quotaResetLabel(new Date(25 * 3600000).toISOString(), t, 0)).toContain('quota.resetsOn');
    expect(quotaTone(59)).toBe('text-emerald-500');
    expect(quotaTone(60)).toBe('text-amber-500');
    expect(quotaTone(85)).toBe('text-red-500');
  });
});
