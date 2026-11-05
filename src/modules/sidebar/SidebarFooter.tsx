import { Settings, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';

// Reuse the last sidebar check across remounts; never request more than once an hour.
let lastChecked = 0;
let cachedAvailable = false;
let pendingCheck: Promise<boolean> | null = null;


type SidebarFooterProps = {
  restartRequired: boolean;
  currentVersion: string;
  onShowSettings: () => void;
  t: TFunction;
};

/**
 * Rendered by SidebarContent at the bottom of the sidebar: one quiet row that
 * opens Settings, styled like the rows above it rather than as a separate card,
 * with the running version tucked in at the right.
 */
export default function SidebarFooter({ restartRequired, currentVersion, onShowSettings, t }: SidebarFooterProps) {
  // Only a confirmed available update lights the settings indicator.
  const [updateAvailable, setUpdateAvailable] = useState(cachedAvailable);

  useEffect(() => {
    let active = true;
    if (Date.now() - lastChecked < 60 * 60 * 1000) return;
    pendingCheck ??= api.updates.get()
      .then((status) => {
        cachedAvailable = status.updateAvailable;
        lastChecked = Date.now();
        return cachedAvailable;
      })
      .catch(() => {
        lastChecked = Date.now();
        return cachedAvailable;
      })
      .finally(() => { pendingCheck = null; });
    void pendingCheck.then((available) => {
      if (active) setUpdateAvailable(available);
    });
    return () => { active = false; };
  }, []);

  return (
    <div
      className="shrink-0 border-t border-border px-2 pt-1.5"
      style={{ paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))' }}
    >
      {restartRequired && (
        <div className="flex min-h-9 items-center gap-2 px-2.5 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('version.restartRequired')}
        </div>
      )}
      <button
        type="button"
        onClick={onShowSettings}
        className="group flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent max-md:h-11 max-md:text-[15px]"
      >
        <Settings className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:rotate-45" />
        <span className="min-w-0 flex-1 truncate">{t('actions.settings')}</span>
        {updateAvailable && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title={t('version.updateAvailable')} aria-label={t('version.updateAvailable')} />
        )}
        {currentVersion && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">v{currentVersion}</span>
        )}
      </button>
    </div>
  );
}
