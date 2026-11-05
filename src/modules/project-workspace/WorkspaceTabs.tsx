import { MessageSquare, SquareTerminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ActionMenu, Tooltip } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins, PluginIcon } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  /**
   * Desktop split view: tool tabs open a side panel next to the chat, so
   * clicking the open tool again closes it (back to chat alone).
   */
  toggleable?: boolean;
};

type BuiltInTab = { kind: 'builtin'; id: AppTab; labelKey: string; icon: LucideIcon };
type PluginTab = { kind: 'plugin'; id: AppTab; label: string; pluginName: string; iconFile: string };
type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat', labelKey: 'tabs.chat', icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: SquareTerminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch },
];
const BROWSER_TAB: BuiltInTab = { kind: 'builtin', id: 'browser', labelKey: 'tabs.browser', icon: MonitorPlay };
const TASKS_TAB: BuiltInTab = { kind: 'builtin', id: 'tasks', labelKey: 'tabs.tasks', icon: ClipboardCheck };

/** Rendered by WorkspaceHeader as compact icon tabs and a narrow-screen overflow menu. */
export default function WorkspaceTabs({ activeTab, setActiveTab, shouldShowTasksTab, shouldShowBrowserTab, toggleable = false }: WorkspaceTabsProps) {
  const selectTab = (id: AppTab) => setActiveTab(toggleable && id === activeTab && id !== 'chat' ? 'chat' : id);
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const tabs: TabDefinition[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
    ...plugins.filter((plugin) => plugin.enabled).map((plugin): PluginTab => ({
      kind: 'plugin', id: `plugin:${plugin.name}` as AppTab, label: plugin.displayName,
      pluginName: plugin.name, iconFile: plugin.icon,
    })),
  ];
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const label = (tab: TabDefinition) => tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;
  const icon = (tab: TabDefinition) => tab.kind === 'builtin'
    ? <tab.icon className="h-[18px] w-[18px]" />
    : <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="flex h-[18px] w-[18px] items-center justify-center [&>svg]:h-full [&>svg]:w-full" />;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
      : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  };

  return (
    <>
      <div role="tablist" aria-label={t('tabs.views', { defaultValue: 'Workspace views' })} className="scrollbar-hide hidden min-w-0 max-w-[calc(100vw-24rem)] items-center overflow-x-auto sm:flex">
        {tabs.map((tab) => (
          <Tooltip key={tab.id} content={label(tab)} position="bottom">
            <button type="button" role="tab" aria-label={label(tab)} aria-selected={tab.id === activeTab}
              tabIndex={tab.id === activeTab ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={handleTabKeyDown}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${tab.id === activeTab ? 'text-primary' : 'text-muted-foreground'}`}>
              {icon(tab)}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="flex items-center sm:hidden">
        <span role="tab" aria-selected="true" aria-label={label(active)} title={label(active)} className="flex h-10 w-9 items-center justify-center text-primary">
          {icon(active)}
        </span>
        <ActionMenu label={t('search.modeMore', { defaultValue: 'More views' })} ariaLabel={t('search.modeMore', { defaultValue: 'More views' })}
          icon={MoreHorizontal} iconOnly portal variant="ghost" size="sm"
          triggerClassName="h-10 w-9 rounded-[10px] p-0 text-muted-foreground [&_svg]:size-[18px]"
          items={tabs.filter((tab) => tab.id !== activeTab).map((tab) => ({
            key: tab.id, label: label(tab), icon: tab.kind === 'builtin' ? tab.icon : undefined,
            onSelect: () => setActiveTab(tab.id),
          }))} />
      </div>
    </>
  );
}
