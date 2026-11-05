import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import SettingsSidebar, { SettingsMobileList, getSettingsNavItem } from '@/modules/settings/SettingsSidebar';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '@/modules/settings/tabs/api-settings/CredentialsSettingsTab';
import VoiceSettingsTab from '@/modules/settings/tabs/VoiceSettingsTab';
import GitSettingsTab from '@/modules/settings/tabs/git-settings/GitSettingsTab';
import BrowserUseSettingsTab from '@/modules/settings/tabs/browser-use-settings/BrowserUseSettingsTab';
import NotificationsSettingsTab from '@/modules/settings/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '@/modules/settings/tabs/tasks-settings/TasksSettingsTab';
import { PluginSettingsTab } from '@/modules/plugins';
import AboutTab from '@/modules/settings/tabs/AboutTab';
import SyncSettingsTab from '@/modules/settings/tabs/sync-settings/SyncSettingsTab';
import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';
import { useWebPush } from '@/modules/settings/hooks/useWebPush';
import type { AgentSettingsProject, SettingsMainTab } from '@/shared/types';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: AgentSettingsProject[];
  initialTab?: string;
};

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

/** Exported as the settings module's public entry point and rendered by the sidebar module as its settings dialog. */
function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).bowcodeDesktopNotifications || null)
  ), []);
  // Phones open on the grouped page list unless a caller asked for a specific page.
  const [showMobileList, setShowMobileList] = useState(() => initialTab === 'agents' || initialTab === 'tools');
  // Settings auto-save once right after they load; the "Saved" badge is only
  // meaningful after the user has actually changed something.
  const [hasInteracted, setHasInteracted] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setShowMobileList(initialTab === 'agents' || initialTab === 'tools');
      setHasInteracted(false);
    }
  }, [isOpen, initialTab]);

  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  // Escape closes Settings, matching the other modals in the app. Layers that open
  // on top of it — nested modals, dropdown menus — mark themselves with
  // `data-escape-layer` and get the Escape first, so dismissing a menu never also
  // pulls Settings out from under the user.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[data-escape-layer]')) {
        return;
      }
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // A click only counts as "outside" when it both started and ended on the backdrop:
  // releasing on the backdrop after selecting text inside the panel must not close it.
  const backdropMouseDownRef = useRef(false);

  const handleBackdropMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    backdropMouseDownRef.current = event.target === event.currentTarget;
  }, []);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const startedOnBackdrop = backdropMouseDownRef.current;
      backdropMouseDownRef.current = false;
      if (startedOnBackdrop && event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  const navItem = getSettingsNavItem(activeTab);
  const PageIcon = navItem.icon;
  const openPage = (tab: SettingsMainTab) => {
    setActiveTab(tab);
    setShowMobileList(false);
  };

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-6"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      {/* Marked as a modal dialog so layers underneath, like the code editor, leave its Escape alone. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        className="flex h-full w-full overflow-hidden bg-background shadow-2xl max-md:bg-muted dark:max-md:bg-background md:h-[min(880px,90vh)] md:max-w-5xl md:rounded-2xl md:border md:border-border"
      >
        <SettingsSidebar activeTab={activeTab} onChange={openPage} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Phone, first screen: the grouped list of pages. */}
          {showMobileList && (
            <div className="flex min-h-0 flex-1 flex-col md:hidden">
              <div className="flex h-12 flex-shrink-0 items-center justify-end px-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-10 rounded-lg px-3 text-[16px] font-semibold text-primary active:opacity-60"
                >
                  {t('actions.done', { defaultValue: 'Done' })}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <h1 className="px-5 pb-3 text-[32px] font-bold tracking-tight text-foreground">{t('title')}</h1>
                <SettingsMobileList onSelect={openPage} />
              </div>
            </div>
          )}

          <div className={cn('flex min-h-0 flex-1 flex-col', showMobileList && 'max-md:hidden')}>
            {/* Phone page bar: back to the list, page title, done. */}
            <div className="grid h-12 flex-shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-background px-1 md:hidden">
              <button
                type="button"
                onClick={() => setShowMobileList(true)}
                className="flex h-10 items-center gap-0.5 justify-self-start rounded-lg pl-1 pr-2 text-[16px] text-primary active:opacity-60"
              >
                <ChevronLeft className="h-6 w-6" />
                {t('title')}
              </button>
              <h2 className="truncate text-[16px] font-semibold text-foreground">{t(navItem.labelKey)}</h2>
              <button
                type="button"
                onClick={onClose}
                className="h-10 justify-self-end rounded-lg px-3 text-[16px] font-semibold text-primary active:opacity-60"
              >
                {t('actions.done', { defaultValue: 'Done' })}
              </button>
            </div>

            {/* Desktop page header */}
            <div className="hidden flex-shrink-0 items-start gap-3 border-b border-border px-6 py-4 md:flex">
              <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PageIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold leading-tight tracking-tight text-foreground">{t(navItem.labelKey)}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(`pageDescriptions.${activeTab}`, { defaultValue: '' })}
                </p>
              </div>
              {saveStatus && hasInteracted && (
                <span
                  role="status"
                  className={cn(
                    'animate-in fade-in mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                    saveStatus === 'success' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 text-red-600',
                  )}
                >
                  {saveStatus === 'success' && <Check className="h-3 w-3" />}
                  {saveStatus === 'success' ? t('saveStatus.saved', { defaultValue: 'Saved' }) : t('saveStatus.error')}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label={t('actions.close', { defaultValue: 'Close' })}
                className="-mr-2 h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            {/* Content */}
            <main
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
              onPointerDownCapture={() => setHasInteracted(true)}
              onKeyDownCapture={() => setHasInteracted(true)}
            >
              <div
                key={activeTab}
                className="settings-content-enter mx-auto min-w-0 max-w-3xl space-y-6 overflow-x-hidden p-4 md:space-y-8 md:p-6"
                style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
              >
                {activeTab === 'appearance' && (
                  <AppearanceSettingsTab
                    projectSortOrder={projectSortOrder}
                    onProjectSortOrderChange={setProjectSortOrder}
                    codeEditorSettings={codeEditorSettings}
                    onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                    onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                    onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                    onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                  />
                )}

                {activeTab === 'git' && <GitSettingsTab />}

                {activeTab === 'agents' && (
                  <AgentsSettingsTab
                    providerAuthStatus={providerAuthStatus}
                    onProviderLogin={openLoginForProvider}
                    claudePermissions={claudePermissions}
                    onClaudePermissionsChange={setClaudePermissions}
                    codexPermissionMode={codexPermissionMode}
                    onCodexPermissionModeChange={setCodexPermissionMode}
                    projects={projects}
                  />
                )}

                {activeTab === 'tasks' && <TasksSettingsTab />}

                {activeTab === 'browser' && <BrowserUseSettingsTab />}

                {activeTab === 'notifications' && (
                  <NotificationsSettingsTab
                    notificationPreferences={notificationPreferences}
                    onNotificationPreferencesChange={setNotificationPreferences}
                    pushPermission={pushPermission}
                    isPushSubscribed={isPushSubscribed}
                    isPushLoading={isPushLoading}
                    onEnablePush={handleEnablePush}
                    onDisablePush={handleDisablePush}
                    isDesktop={Boolean(desktopNotificationsBridge)}
                    desktopNotifications={desktopNotificationsState}
                    onEnableDesktopNotifications={handleEnableDesktopNotifications}
                    onDisableDesktopNotifications={handleDisableDesktopNotifications}
                  />
                )}

                {activeTab === 'api' && <CredentialsSettingsTab />}

                {activeTab === 'voice' && <VoiceSettingsTab />}

                {activeTab === 'plugins' && <PluginSettingsTab />}

                {activeTab === 'sync' && <SyncSettingsTab />}

                {activeTab === 'about' && <AboutTab />}
              </div>
            </main>
          </div>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;
