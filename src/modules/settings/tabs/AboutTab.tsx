import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { APP_VERSION, PROJECT_REPO_URL } from '@/shared/constants';
import { BrandMark } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

const UPSTREAM_URL = 'https://github.com/siteboon/claudecodeui';

/**
 * Rendered by Settings to show the app's identity, source repository and license.
 * The upstream attribution is required by the Section 7 terms in LICENSE — keep it.
 */
export default function AboutTab() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        <BrandMark size={72} className="shadow-lg" />
        <div>
          <div className="text-2xl font-semibold tracking-tight text-foreground">Bowcode</div>
          <div className="mt-1 text-sm tabular-nums text-muted-foreground">
            {t('about.version', { defaultValue: 'Version {{version}}', version: APP_VERSION })}
          </div>
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">{t('about.tagline')}</p>
      </div>

      <SettingsCard divided>
        <a
          href={PROJECT_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3.5 text-sm text-foreground transition-colors hover:bg-accent/50"
        >
          <GitHubIcon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">{t('about.source', { defaultValue: 'Source code' })}</span>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </a>
        <div className="space-y-1 px-4 py-3.5 text-sm">
          <div className="text-foreground">{t('about.license', { defaultValue: 'License' })}</div>
          <p className="text-muted-foreground">{t('about.licensed')}</p>
        </div>
        <div className="space-y-1 px-4 py-3.5 text-sm">
          <div className="text-foreground">{t('about.origin', { defaultValue: 'Origin' })}</div>
          <p className="text-muted-foreground">
            {t('about.basedOn', { defaultValue: 'A modified fork of' })}{' '}
            <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              CloudCLI UI ({UPSTREAM_URL})
            </a>
            . {t('about.notAffiliated', { defaultValue: 'Not affiliated with or endorsed by Siteboon AI B.V.' })}
          </p>
        </div>
      </SettingsCard>
    </div>
  );
}
