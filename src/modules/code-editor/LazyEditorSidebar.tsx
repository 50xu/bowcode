import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type EditorSidebarComponent from '@/modules/code-editor/EditorSidebar';
import CodeEditorLoadingState from '@/modules/code-editor/CodeEditorLoadingState';

type EditorSidebarProps = ComponentProps<typeof EditorSidebarComponent>;

const EditorSidebarContent = lazy(() => import('@/modules/code-editor/EditorSidebar'));

/** Used by project-workspace to defer loading the editor sidebar until a file is opened. */
export function EditorSidebar(props: EditorSidebarProps) {
  if (!props.editingFile) return null;

  const docked = !props.isMobile;
  const flexWidth = props.editorExpanded || (props.fillSpace && !props.hasManualWidth);
  return (
    <Suspense fallback={(
      <div className={docked ? `h-full min-w-0 ${flexWidth ? 'flex-1' : ''}` : 'contents'} style={docked && !flexWidth ? { width: props.editorWidth } : undefined}>
        <CodeEditorLoadingState file={props.editingFile} isSidebar={docked} />
      </div>
    )}>
      <EditorSidebarContent {...props} />
    </Suspense>
  );
}
