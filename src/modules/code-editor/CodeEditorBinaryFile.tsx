import { useTranslation } from 'react-i18next';

import type { CodeEditorFile } from '@/shared/types';
import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';

type CodeEditorBinaryFileProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  title: string;
  message: string;
};

/** Rendered by CodeEditor inside the code-editor module when the opened file is binary and cannot be edited as text. */
export default function CodeEditorBinaryFile({
  file,
  isSidebar,
  isFullscreen,
  onClose,
  onToggleFullscreen,
  title,
  message,
}: CodeEditorBinaryFileProps) {
  const { t } = useTranslation('codeEditor');
  const header = <CodeEditorHeader file={file} previewOnly isSidebar={isSidebar} isExpanded={false} isFullscreen={isFullscreen} isMarkdownFile={false} isHtmlPreviewFile={false} markdownPreview={false} showDiff={false} changeIndex={0} changeCount={0} saving={false} saveSuccess={false} hasUnsavedChanges={false} onToggleMarkdownPreview={() => {}} onOpenHtmlPreview={() => {}} onToggleDiff={() => {}} onNavigateDiff={() => {}} onToggleExpand={null} onPopOut={null} onOpenSettings={() => {}} onDownload={() => {}} onSave={() => {}} onToggleFullscreen={onToggleFullscreen} onClose={onClose} labels={{ fullscreen: t('actions.fullscreen'), exitFullscreen: t('actions.exitFullscreen'), close: t('actions.close') }} />;
  const binaryContent = (
    <div className="flex h-full w-full flex-col items-center justify-center bg-background p-8 text-muted-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div>
          <h3 className="mb-2 text-lg font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <button
          onClick={onClose}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Close
        </button>
      </div>
    </div>
  );

  if (isSidebar) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        {header}
        {binaryContent}
      </div>
    );
  }

  const containerClassName = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-background flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4';

  const innerClassName = isFullscreen
    ? 'bg-background flex flex-col w-full h-full'
    : 'bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl md:w-full md:max-w-2xl md:h-auto md:max-h-[60vh]';

  return (
    <div className={containerClassName}>
      <div className={innerClassName}>
        {header}
        {binaryContent}
      </div>
    </div>
  );
}
