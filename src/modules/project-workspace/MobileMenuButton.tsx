import { useTranslation } from 'react-i18next';

import { useMobileMenuHandlers } from '@/modules/project-workspace/hooks/useMobileMenuHandlers';

type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

/** Rendered by WorkspaceHeader and WorkspaceStateView to open the sidebar drawer on mobile. */
export default function MobileMenuButton({ onMenuClick, compact = false }: MobileMenuButtonProps) {
  const { t } = useTranslation();
  const { handleMobileMenuClick, handleMobileMenuTouchEnd } = useMobileMenuHandlers(onMenuClick);

  const buttonClasses = compact
    ? 'flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground rounded-[10px] hover:bg-accent pwa-menu-button'
    : 'flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground rounded-[10px] hover:bg-accent touch-manipulation active:scale-95 pwa-menu-button shrink-0';

  return (
    <button
      onClick={handleMobileMenuClick}
      onTouchEnd={handleMobileMenuTouchEnd}
      className={buttonClasses}
      aria-label={t('misc.openMenu')}
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}
