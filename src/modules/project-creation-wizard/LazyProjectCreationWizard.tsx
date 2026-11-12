import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type ProjectCreationWizardComponent from '@/modules/project-creation-wizard/ProjectCreationWizard';

type ProjectCreationWizardProps = ComponentProps<typeof ProjectCreationWizardComponent>;

const ProjectCreationWizardContent = lazy(() => import('@/modules/project-creation-wizard/ProjectCreationWizard'));

/** Used by sidebar to load the project creation wizard only when it is opened. */
export function ProjectCreationWizard(props: ProjectCreationWizardProps) {
  return (
    <Suspense fallback={null}>
      <ProjectCreationWizardContent {...props} />
    </Suspense>
  );
}
