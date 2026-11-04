import { Settings, Sparkles, PanelLeftOpen, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  onShowVersionModal: () => void;
  t: TFunction;
};

/** Rendered by Sidebar instead of SidebarContent when the panel is collapsed to its icon rail. */
export default function SidebarCollapsed({ onExpand, onShowSettings, updateAvailable, restartRequired, onShowVersionModal, t }: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background py-2">
      <button onClick={onExpand} className="flex h-10 w-10 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent" aria-label={t('common:versionUpdate.ariaLabels.showSidebar')} title={t('common:versionUpdate.ariaLabels.showSidebar')}>
        <PanelLeftOpen className="h-5 w-5" />
      </button>
      <div className="my-1 w-8 border-t border-border" />
      <button onClick={onShowSettings} className="flex h-10 w-10 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent" aria-label={t('actions.settings')} title={t('actions.settings')}>
        <Settings className="h-5 w-5" />
      </button>
      {restartRequired && <div className="flex h-10 w-10 items-center justify-center text-amber-500" aria-label={t('version.restartRequired')} title={t('version.restartRequired')}><AlertTriangle className="h-5 w-5" /></div>}
      {updateAvailable && <button onClick={onShowVersionModal} className="flex h-10 w-10 items-center justify-center rounded-[10px] text-primary hover:bg-accent" aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')} title={t('common:versionUpdate.ariaLabels.updateAvailable')}><Sparkles className="h-5 w-5" /></button>}
    </div>
  );
}
