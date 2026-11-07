import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProviderQuota } from '@/shared/hooks/useProviderQuota';
import type { LLMProvider } from '@/shared/types';
import { QuotaWindowList } from '@/shared/ui/QuotaWindowList';

/** Used by Settings' AccountContent to display the authenticated provider's usage limits. */
export function ProviderQuotaPanel({ provider }: { provider: LLMProvider }) {
  const { t } = useTranslation('settings');
  const { quota, loading, refresh } = useProviderQuota(provider);
  return (
    <section className="rounded-lg border border-border p-4" aria-label={t('quota.title')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="font-medium text-foreground">{t('quota.title')}</h4>
        {quota?.status !== 'unsupported' && (
          <button type="button" onClick={() => { void refresh(); }} disabled={loading} aria-label={t('quota.refresh')} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {quota?.status === 'ok' && quota.windows.length > 0 ? <QuotaWindowList windows={quota.windows} /> : (
        <p className="text-sm text-muted-foreground">
          {quota?.status === 'unsupported' ? t('quota.unsupported')
            : quota?.status === 'unauthenticated' ? t('quota.unauthenticated')
              : quota?.status === 'error' ? quota.message || t('quota.error')
                : loading ? t('agents.authStatus.checking') : t('quota.unknown')}
        </p>
      )}
    </section>
  );
}
