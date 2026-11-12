import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type BrowserUsePanelComponent from '@/modules/browser-use/BrowserUsePanel';

type BrowserUsePanelProps = ComponentProps<typeof BrowserUsePanelComponent>;

const BrowserUsePanelContent = lazy(() => import('@/modules/browser-use/BrowserUsePanel'));

/** Used by project-workspace to load browser controls only when the Browser tab is rendered. */
export function BrowserUsePanel(props: BrowserUsePanelProps) {
  return (
    <Suspense fallback={null}>
      <BrowserUsePanelContent {...props} />
    </Suspense>
  );
}
