import { Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { playChatCompletionSound } from '@/shared/utils';
import type { NotificationPreferencesState } from '@/shared/types';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
  isDesktop?: boolean;
  desktopNotifications?: {
    enabled: boolean;
    supported: boolean;
    connectedCount?: number;
    targetCount?: number;
    lastError?: string | null;
  } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
};

/** Rendered by Settings for the "notifications" tab, covering notification channels and events. */
export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
  isDesktop = false,
  desktopNotifications = null,
  onEnableDesktopNotifications,
  onDisableDesktopNotifications,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  const setChannel = (key: keyof NotificationPreferencesState['channels'], value: boolean) =>
    onNotificationPreferencesChange({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, [key]: value },
    });
  const setEvent = (key: keyof NotificationPreferencesState['events'], value: boolean) =>
    onNotificationPreferencesChange({
      ...notificationPreferences,
      events: { ...notificationPreferences.events, [key]: value },
    });

  const deliveryRow = isDesktop ? (
    <SettingsRow
      label={t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
      description={
        desktopNotifications?.supported === false
          ? t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })
          : desktopNotifications?.lastError || undefined
      }
    >
      <SettingsToggle
        checked={Boolean(desktopNotifications?.enabled)}
        disabled={desktopNotifications?.supported === false}
        ariaLabel={t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
        onChange={(value) => (value ? onEnableDesktopNotifications?.() : onDisableDesktopNotifications?.())}
      />
    </SettingsRow>
  ) : (
    <SettingsRow
      label={t('notifications.webPush.title')}
      description={
        !pushSupported
          ? t('notifications.webPush.unsupported')
          : pushDenied
            ? t('notifications.webPush.denied')
            : isPushSubscribed
              ? t('notifications.webPush.enabled')
              : undefined
      }
    >
      {isPushLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <SettingsToggle
          checked={isPushSubscribed}
          disabled={!pushSupported || pushDenied}
          ariaLabel={t('notifications.webPush.title')}
          onChange={(value) => (value ? onEnablePush() : onDisablePush())}
        />
      )}
    </SettingsRow>
  );

  return (
    <div className="space-y-8">
      <SettingsSection title={t('notifications.channels', { defaultValue: 'Delivery' })}>
        <SettingsCard divided>
          {deliveryRow}
          <SettingsRow
            label={t('notifications.sound.title', { defaultValue: 'Sound' })}
            description={t('notifications.sound.description', { defaultValue: 'Play a short tone when a chat run finishes.' })}
          >
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground"
                aria-label={t('notifications.sound.test', { defaultValue: 'Test sound' })}
                title={t('notifications.sound.test', { defaultValue: 'Test sound' })}
                onClick={() => {
                  void playChatCompletionSound({ force: true });
                }}
              >
                <Play className="h-4 w-4" />
              </Button>
              <SettingsToggle
                checked={notificationPreferences.channels.sound}
                ariaLabel={t('notifications.sound.title', { defaultValue: 'Sound' })}
                onChange={(value) => setChannel('sound', value)}
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('notifications.events.title')}>
        <SettingsCard divided>
          <SettingsRow label={t('notifications.events.actionRequired')}>
            <SettingsToggle
              checked={notificationPreferences.events.actionRequired}
              ariaLabel={t('notifications.events.actionRequired')}
              onChange={(value) => setEvent('actionRequired', value)}
            />
          </SettingsRow>
          <SettingsRow label={t('notifications.events.stop')}>
            <SettingsToggle
              checked={notificationPreferences.events.stop}
              ariaLabel={t('notifications.events.stop')}
              onChange={(value) => setEvent('stop', value)}
            />
          </SettingsRow>
          <SettingsRow label={t('notifications.events.error')}>
            <SettingsToggle
              checked={notificationPreferences.events.error}
              ariaLabel={t('notifications.events.error')}
              onChange={(value) => setEvent('error', value)}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
