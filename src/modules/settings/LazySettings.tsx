import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type SettingsComponent from '@/modules/settings/Settings';

type SettingsProps = ComponentProps<typeof SettingsComponent>;

const SettingsContent = lazy(() => import('@/modules/settings/Settings'));

/** Used by sidebar to load the settings dialog only when it is opened. */
export function Settings(props: SettingsProps) {
  return (
    <Suspense fallback={null}>
      <SettingsContent {...props} />
    </Suspense>
  );
}
