import { SlidersHorizontal } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, Project, ProjectSession } from '@/shared/types';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by WorkspaceMain as the single-row workspace navigation bar. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onRenameSession,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="hairline-bottom sticky top-0 z-30 flex shrink-0 items-end bg-background/80 px-1 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80 sm:px-3">
      <div className="flex h-11 w-full min-w-0 items-center gap-1">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:max-w-[min(38%,24rem)]">
          <WorkspaceTitle
            // Desktop keeps the chat on screen with tools beside it, so the
            // title stays the conversation's.
            activeTab={isMobile ? activeTab : 'chat'}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
            onRenameSession={onRenameSession}
          />
          <WorkspaceConnectionStatus />
        </div>
        <div className="flex min-w-0 shrink-0 items-center justify-end sm:ml-auto">
          <WorkspaceTabs
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
            toggleable={!isMobile}
          />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('workspace:toggle-quick-settings'))}
            aria-label={t('quickSettings.title', { defaultValue: 'Quick settings' })}
            title={t('quickSettings.title', { defaultValue: 'Quick settings' })}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>
    </header>
  );
}
