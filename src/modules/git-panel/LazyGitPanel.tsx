import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type GitPanelComponent from '@/modules/git-panel/GitPanel';

type GitPanelProps = ComponentProps<typeof GitPanelComponent>;

const GitPanelContent = lazy(() => import('@/modules/git-panel/GitPanel'));

/** Used by project-workspace to load the source-control panel only when its tab is rendered. */
export function GitPanel(props: GitPanelProps) {
  return (
    <Suspense fallback={null}>
      <GitPanelContent {...props} />
    </Suspense>
  );
}
