import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type TaskMasterPanelComponent from '@/modules/task-master/TaskMasterPanel';

type TaskMasterPanelProps = ComponentProps<typeof TaskMasterPanelComponent>;

const TaskMasterPanelContent = lazy(() => import('@/modules/task-master/TaskMasterPanel'));

/** Used by project-workspace to load the Tasks panel only when its tab is rendered. */
export function TaskMasterPanel(props: TaskMasterPanelProps) {
  return (
    <Suspense fallback={null}>
      <TaskMasterPanelContent {...props} />
    </Suspense>
  );
}
