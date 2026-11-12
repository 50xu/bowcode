import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type { SchedulesDialog as SchedulesDialogComponent } from '@/modules/schedules/SchedulesDialog';

type SchedulesDialogProps = ComponentProps<typeof SchedulesDialogComponent>;

const SchedulesDialogContent = lazy(() =>
  import('@/modules/schedules/SchedulesDialog').then(({ SchedulesDialog }) => ({ default: SchedulesDialog })),
);

/** Used by sidebar to load schedule management only when its dialog is opened. */
export function SchedulesDialog(props: SchedulesDialogProps) {
  return (
    <Suspense fallback={null}>
      <SchedulesDialogContent {...props} />
    </Suspense>
  );
}
