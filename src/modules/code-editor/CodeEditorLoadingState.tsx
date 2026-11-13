import type { CodeEditorFile } from '@/shared/types';
import { Shimmer } from '@/shared/ui';

type CodeEditorLoadingStateProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
};

/** Used by LazyEditorSidebar and CodeEditor to keep the same file layout while chunks or content load. */
export default function CodeEditorLoadingState({ file, isSidebar }: CodeEditorLoadingStateProps) {
  return (
    <div className={isSidebar ? 'flex h-full w-full flex-col bg-background' : 'fixed inset-0 z-9999 md:flex md:items-center md:justify-center md:bg-black/50 md:p-4'} role="status" aria-label={`Loading ${file.name}`}>
      <div className={isSidebar ? 'flex h-full w-full flex-col' : 'flex h-full w-full flex-col bg-background md:h-[80vh] md:max-h-[80vh] md:max-w-6xl md:rounded-lg'}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="max-w-[60%] shrink-0 truncate text-sm font-medium">{file.name}</span>
          <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground [direction:rtl]" title={file.path}><span dir="ltr">{file.path.endsWith(file.name) ? (file.path.slice(0, -file.name.length).replace(/[\\/]+$/, '') || '/') : file.path}</span></span>
        </div>
        <div className="flex-1 space-y-3 overflow-hidden px-5 py-5 font-mono text-xs" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <Shimmer key={index} as="div" className="w-fit">{'▁'.repeat(12 + ((index * 7) % 36))}</Shimmer>
          ))}
        </div>
        <div className="h-6 shrink-0 border-t border-border" />
      </div>
    </div>
  );
}
