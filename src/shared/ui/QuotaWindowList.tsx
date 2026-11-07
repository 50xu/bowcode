import { useTranslation } from 'react-i18next';

import type { ProviderQuotaWindow } from '@/shared/types';

/** Returns the window's translated heading, preserving provider-specific labels as suffixes. */
export function quotaWindowLabel(window: ProviderQuotaWindow, t: (key: string, options?: Record<string, unknown>) => string): string {
  const base = window.kind === 'session' ? t('quota.currentSession', { hours: window.windowMinutes ? Math.round(window.windowMinutes / 60) : 5 })
    : window.kind === 'weekly' ? t('quota.weekly') : window.label || window.kind;
  return window.label && (window.kind === 'session' || window.kind === 'weekly') && window.label !== base
    ? `${base} · ${window.label}` : base;
}

/** Formats reset deadlines for both Settings and chat, using absolute local dates after 24 hours. */
export function quotaResetLabel(resetsAt: string | null, t: (key: string, options?: Record<string, unknown>) => string, now = Date.now(), locale?: string): string | null {
  if (!resetsAt) return null;
  const time = Date.parse(resetsAt);
  if (!Number.isFinite(time)) return null;
  const remaining = Math.max(0, time - now);
  if (remaining > 24 * 60 * 60 * 1000) {
    return t('quota.resetsOn', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time) });
  }
  const minutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? t('quota.resetsInHours', { hours, minutes: minutes % 60 }) : t('quota.resetsInMinutes', { minutes });
}

/** Returns the semantic usage colour shared by Settings bars and the composer ring. */
export function quotaTone(percent: number | null): string {
  return percent === null ? 'text-muted-foreground' : percent >= 85 ? 'text-red-500' : percent >= 60 ? 'text-amber-500' : 'text-emerald-500';
}

/** Used by Settings and chat's quota popover to show each reported usage window. */
export function QuotaWindowList({ windows }: { windows: ProviderQuotaWindow[] }) {
  const { t, i18n } = useTranslation('settings');
  return (
    <div className="space-y-3">
      {windows.map((window) => {
        const percent = window.usedPercent;
        const tone = quotaTone(percent);
        const reset = quotaResetLabel(window.resetsAt, t, Date.now(), i18n.language);
        return (
          <div key={window.id} className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-medium text-foreground">{quotaWindowLabel(window, t)}</span>
              <span className={`shrink-0 font-medium tabular-nums ${tone}`}>{percent === null ? t('quota.unknown') : t('quota.percentUsed', { percent: Math.round(percent) })}</span>
            </div>
            <div role="progressbar" aria-label={quotaWindowLabel(window, t)} aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full bg-current ${tone}`} style={{ width: `${Math.max(0, Math.min(percent ?? 0, 100))}%` }} />
            </div>
            {reset && <p className="text-muted-foreground">{reset}</p>}
          </div>
        );
      })}
    </div>
  );
}
