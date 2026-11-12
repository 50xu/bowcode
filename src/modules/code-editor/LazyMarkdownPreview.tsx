import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

import type MarkdownPreviewComponent from '@/modules/code-editor/markdown/MarkdownPreview';

type MarkdownPreviewProps = ComponentProps<typeof MarkdownPreviewComponent>;

const MarkdownPreviewContent = lazy(() => import('@/modules/code-editor/markdown/MarkdownPreview'));

/** Used by prd-editor and CodeEditorSurface to load rendered markdown only when preview is visible. */
export function MarkdownPreview(props: MarkdownPreviewProps) {
  return (
    <Suspense fallback={null}>
      <MarkdownPreviewContent {...props} />
    </Suspense>
  );
}
