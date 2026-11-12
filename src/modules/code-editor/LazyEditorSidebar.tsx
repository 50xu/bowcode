import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type EditorSidebarComponent from '@/modules/code-editor/EditorSidebar';

type EditorSidebarProps = ComponentProps<typeof EditorSidebarComponent>;

const EditorSidebarContent = lazy(() => import('@/modules/code-editor/EditorSidebar'));

/** Used by project-workspace to defer loading the editor sidebar until a file is opened. */
export function EditorSidebar(props: EditorSidebarProps) {
  if (!props.editingFile) return null;

  return (
    <Suspense fallback={<div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground" role="status">Loading editor…</div>}>
      <EditorSidebarContent {...props} />
    </Suspense>
  );
}
