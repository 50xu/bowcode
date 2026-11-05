import { Archive, Bell, Bot, ChevronRight, GitBranch, Info, Key, ListChecks, Mic, MonitorPlay, Palette, Puzzle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { APP_VERSION } from '@/shared/constants';
import { BrandMark } from '@/shared/ui';
import type { SettingsMainTab } from '@/shared/types';

type NavItem = {
  id: SettingsMainTab;
  labelKey: string;
  icon: typeof Bot;
  /** Tile colour of the icon in the phone list, iOS Settings style. */
  tint: string;
};

type NavGroup = {
  id: string;
  labelKey: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'agents',
    labelKey: 'navGroups.agents',
    items: [
      { id: 'agents', labelKey: 'mainTabs.agents', icon: Bot, tint: 'bg-orange-500' },
      { id: 'tasks', labelKey: 'mainTabs.tasks', icon: ListChecks, tint: 'bg-emerald-500' },
      { id: 'browser', labelKey: 'mainTabs.browser', icon: MonitorPlay, tint: 'bg-sky-500' },
      { id: 'plugins', labelKey: 'mainTabs.plugins', icon: Puzzle, tint: 'bg-violet-500' },
    ],
  },
  {
    id: 'general',
    labelKey: 'navGroups.general',
    items: [
      { id: 'appearance', labelKey: 'mainTabs.appearance', icon: Palette, tint: 'bg-blue-500' },
      { id: 'notifications', labelKey: 'mainTabs.notifications', icon: Bell, tint: 'bg-red-500' },
      { id: 'voice', labelKey: 'mainTabs.voice', icon: Mic, tint: 'bg-pink-500' },
      { id: 'sessions', labelKey: 'mainTabs.sessions', icon: Archive, tint: 'bg-stone-500' },
    ],
  },
  {
    id: 'account',
    labelKey: 'navGroups.account',
    items: [
      { id: 'git', labelKey: 'mainTabs.git', icon: GitBranch, tint: 'bg-orange-600' },
      { id: 'api', labelKey: 'mainTabs.apiTokens', icon: Key, tint: 'bg-amber-500' },
      { id: 'sync', labelKey: 'mainTabs.sync', icon: RefreshCw, tint: 'bg-teal-500' },
    ],
  },
  {
    id: 'about',
    labelKey: 'navGroups.about',
    items: [
      { id: 'about', labelKey: 'mainTabs.about', icon: Info, tint: 'bg-slate-500' },
    ],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

/** Used by Settings to title the open page with the same icon and label as its nav entry. */
export function getSettingsNavItem(tab: SettingsMainTab): NavItem {
  return NAV_ITEMS.find((item) => item.id === tab) ?? NAV_ITEMS[0];
}

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

/** Rendered by Settings on wide screens: the grouped page list down the left edge. */
export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');

  return (
    <aside className="hidden w-60 flex-shrink-0 flex-col border-r border-border bg-muted/30 md:flex">
      <div className="px-5 pb-2 pt-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{t('title')}</h2>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label={t('title')}>
        {NAV_GROUPS.filter((group) => group.id !== 'about').map((group) => (
          <div key={group.id} className="mt-3 first:mt-1">
            <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t(group.labelKey)}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onChange(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-150',
                    isActive
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('h-4 w-4 flex-shrink-0', isActive && 'text-primary')} />
                  {t(item.labelKey)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* About doubles as the brand footer, so the version is always one glance away. */}
      <button
        type="button"
        onClick={() => onChange('about')}
        aria-current={activeTab === 'about' ? 'page' : undefined}
        className={cn(
          'mx-3 mb-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
          activeTab === 'about' ? 'bg-accent' : 'hover:bg-accent/60',
        )}
      >
        <BrandMark size={24} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Bowcode</span>
          <span className="block text-[11px] tabular-nums text-muted-foreground">v{APP_VERSION}</span>
        </span>
        <Info className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </aside>
  );
}

type SettingsMobileListProps = {
  onSelect: (tab: SettingsMainTab) => void;
};

/** Rendered by Settings on phones as the first screen: iOS-style grouped rows that push a page. */
export function SettingsMobileList({ onSelect }: SettingsMobileListProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6 px-4 pb-8 pt-2">
      {NAV_GROUPS.map((group) => (
        <section key={group.id}>
          <h3 className="px-4 pb-1.5 text-[13px] uppercase tracking-wide text-muted-foreground">
            {t(group.labelKey)}
          </h3>
          <div className="overflow-hidden rounded-xl bg-card">
            {group.items.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className="flex min-h-[46px] w-full items-center gap-3 pl-4 text-left transition-colors active:bg-accent"
                >
                  <span className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] text-white', item.tint)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span
                    className={cn(
                      'flex min-h-[46px] flex-1 items-center gap-2 pr-3',
                      index > 0 && 'border-t border-border/70',
                    )}
                  >
                    <span className="flex-1 text-[16px] text-foreground">{t(item.labelKey)}</span>
                    {item.id === 'about' && (
                      <span className="text-[15px] tabular-nums text-muted-foreground">v{APP_VERSION}</span>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
