import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type { TerminalView as TerminalViewComponent } from '@/modules/terminal/TerminalView';

type TerminalViewProps = ComponentProps<typeof TerminalViewComponent>;

const TerminalViewContent = lazy(() => import('@/modules/terminal/TerminalView').then(({ TerminalView }) => ({ default: TerminalView })));

/** Used by project-workspace, provider-auth and task-master to load terminal sessions only when the terminal is shown. */
export function TerminalView(props: TerminalViewProps) {
  return (
    <Suspense fallback={<div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground" role="status">Loading terminal…</div>}>
      <TerminalViewContent {...props} />
    </Suspense>
  );
}
