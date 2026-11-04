import { Settings, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '@/shared/types';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Rendered by SidebarContent as the settings and version group at the bottom of the sidebar. */
export default function SidebarFooter({ updateAvailable, restartRequired, releaseInfo, latestVersion, currentVersion, onShowVersionModal, onShowSettings, t }: SidebarFooterProps) {
  return (
    <div className="hairline-bottom flex-shrink-0 border-t border-border px-3 py-2" style={{ paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))' }}>
      {restartRequired && (
        <div className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs text-amber-600">
          <AlertTriangle className="h-4 w-4" />{t('version.restartRequired')}
        </div>
      )}
      <div className="hairline overflow-hidden rounded-xl bg-card">
        {updateAvailable && (
          <button className="flex min-h-11 w-full items-center gap-3 border-b border-border px-3 text-left text-primary" onClick={onShowVersionModal}>
            <ArrowUpCircle className="h-5 w-5" />
            <span className="min-w-0 flex-1 truncate text-sm">{releaseInfo?.title || `v${latestVersion}`}</span>
          </button>
        )}
        <button className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-foreground hover:bg-accent" onClick={onShowSettings}>
          <Settings className="h-5 w-5 text-muted-foreground" />
          <span className="text-[17px]">{t('actions.settings')}</span>
        </button>
      </div>
      <div className="pt-2 text-center text-xs text-muted-foreground">CloudCLI v{currentVersion}</div>
    </div>
  );
}
