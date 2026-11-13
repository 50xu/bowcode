import { EditorView } from '@codemirror/view';
import { getChunks, unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { useTheme } from '@/shared/context/ThemeContext';
import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '@/modules/code-editor/hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '@/modules/code-editor/hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile, CodeEditorGotoTarget } from '@/shared/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, resolveEditorLanguage } from '@/modules/code-editor/utils/editorExtensions';
import CodeEditorFooter from '@/modules/code-editor/CodeEditorFooter';
import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';
import CodeEditorLoadingState from '@/modules/code-editor/CodeEditorLoadingState';
import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';
import CodeEditorBinaryFile from '@/modules/code-editor/CodeEditorBinaryFile';
import CodeEditorMediaPreview from '@/modules/code-editor/CodeEditorMediaPreview';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  // Reports whether the buffer differs from the file on disk, so the owner can
  // guard replacing this editor with another file the same way closing is.
  onUnsavedChangesChange?: (hasUnsavedChanges: boolean) => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

/** Rendered by the code-editor module's own EditorSidebar, and re-exported on the module barrel, as the full CodeMirror editor for one open file. */
export default function CodeEditor({
  file,
  onClose,
  onUnsavedChangesChange,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const paletteOps = usePaletteOps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const resolvedLanguage = useMemo(() => resolveEditorLanguage(file.name), [file.name]);
  // Loaded support belongs to this filename; old files must never colour a newly opened one.
  const [loadedLanguage, setLoadedLanguage] = useState<{ fileName: string; extension: Extension } | null>(null);
  // A short grace period avoids a plain-text flash for the first language load.
  const [languageWaitExpiredFor, setLanguageWaitExpiredFor] = useState<string | null>(null);
  // The view is shared with header navigation; changing the diff does not remount it.
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  // The selected diff index is independent of document edits and wraps on navigation.
  const [changeIndex, setChangeIndex] = useState(0);
  // Merge decorations can change after a transaction without a React render.
  const [changeCount, setChangeCount] = useState(0);
  // Updated by CodeMirror selection transactions for the slim status bar.
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const visibleChangeCount = editorView && showDiff ? changeCount : 0;
  const visibleChangeIndex = Math.min(changeIndex, Math.max(0, visibleChangeCount - 1));

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => setLanguageWaitExpiredFor(file.name), 300);
    void resolvedLanguage.load().then((extension) => {
      if (active) setLoadedLanguage({ fileName: file.name, extension });
    }).catch(() => {
      if (active) setLoadedLanguage({ fileName: file.name, extension: [] });
    });
    return () => { active = false; window.clearTimeout(timer); };
  }, [file.name, resolvedLanguage]);

  const handleViewChange = useCallback((view: EditorView | null) => {
    setEditorView(view);
    setChangeCount(view ? getChunks(view.state)?.chunks.length ?? 0 : 0);
  }, []);

  const navigateDiff = useCallback((direction: number) => {
    if (!editorView) return;
    const nextChunks = getChunks(editorView.state)?.chunks ?? [];
    if (!nextChunks.length) return;
    const next = (Math.min(changeIndex, nextChunks.length - 1) + direction + nextChunks.length) % nextChunks.length;
    setChangeIndex(next);
    editorView.dispatch({ effects: EditorView.scrollIntoView(nextChunks[next].fromB, { y: 'center' }) });
  }, [editorView, changeIndex]);

  // The code editor follows the app-wide theme; it has no theme of its own.
  const { isDarkMode } = useTheme();

  const {
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    previewKind,
    fileProjectId,
    hasUnsavedChanges,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  // Every way of closing (Escape, the header X, the binary and media views)
  // goes through here: a dirty buffer asks first, a clean one closes at once.
  const requestClose = useCallback(() => {
    if (
      hasUnsavedChanges
      && !window.confirm(t('unsavedChanges.confirmClose', 'You have unsaved changes. Close this file and discard them?'))
    ) {
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose, t]);

  // Cleared on unmount so a closed editor can never block the next open.
  useEffect(() => {
    onUnsavedChangesChange?.(hasUnsavedChanges);
    return () => onUnsavedChangesChange?.(false);
  }, [hasUnsavedChanges, onUnsavedChangesChange]);

  // The browser only shows its leave-page prompt while a listener is attached,
  // so one is registered for exactly as long as there is something to lose.
  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy trigger for browsers that ignore preventDefault() here (Chrome/Edge < 119).
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  // Keyed on the file object rather than on the line number: `useEditorSidebar`
  // builds a new one per open, so clicking the same `path:line` reference again
  // jumps again, while editing the open file never re-triggers the jump.
  const gotoTarget = useMemo<CodeEditorGotoTarget | null>(
    () => (file.line ? { line: file.line } : null),
    [file],
  );

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isHtmlPreviewFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  const openHtmlPreview = useCallback(() => {
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) return;

    previewWindow.opener = null;
    previewWindow.document.title = file.name;
    previewWindow.document.body.style.margin = '0';

    const iframe = previewWindow.document.createElement('iframe');
    iframe.title = file.name;
    iframe.sandbox.add('allow-forms', 'allow-modals', 'allow-popups', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:white';

    iframe.srcdoc = content;

    previewWindow.document.body.appendChild(iframe);
  }, [content, file.name]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose: requestClose,
    dependency: content,
  });

  if (loading || (!previewKind && !isBinary && languageWaitExpiredFor !== file.name && loadedLanguage?.fileName !== file.name)) {
    return <CodeEditorLoadingState file={file} isSidebar={isSidebar} />;
  }

  // Natively previewable media (image/pdf/audio/video) is rendered inline
  // instead of showing the generic "cannot be displayed" placeholder.
  if (previewKind) {
    return (
      <CodeEditorMediaPreview
        file={file}
        kind={previewKind}
        projectId={fileProjectId}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={requestClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        labels={{
          loading: t('filePreview.loading', 'Loading preview...'),
          error: t('filePreview.error', 'Unable to display this file.'),
          openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
          fullscreen: t('actions.fullscreen', 'Fullscreen'),
          exitFullscreen: t('actions.exitFullscreen', 'Exit fullscreen'),
          close: t('actions.close', 'Close'),
        }}
      />
    );
  }

  // Binary file display
  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={requestClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-background flex flex-col w-full h-full'
    : `bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            isSidebar={isSidebar}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onPopOut={onPopOut}
            showDiff={showDiff}
            changeIndex={visibleChangeIndex}
            changeCount={visibleChangeCount}
            onToggleDiff={() => { setChangeIndex(0); setShowDiff((previous) => !previous); }}
            onNavigateDiff={navigateDiff}
            isFullscreen={isFullscreen}
            isMarkdownFile={isMarkdownFile}
            isHtmlPreviewFile={isHtmlPreviewFile}
            markdownPreview={markdownPreview}
            saving={saving}
            saveSuccess={saveSuccess}
            hasUnsavedChanges={hasUnsavedChanges}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onOpenHtmlPreview={openHtmlPreview}
            onOpenSettings={() => paletteOps.openSettings('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={requestClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              changes: t('toolbar.changes'),
              previousChange: t('toolbar.previousChange'),
              nextChange: t('toolbar.nextChange'),
              hideDiff: t('toolbar.hideDiff'),
              showDiff: t('toolbar.showDiff'),
              collapse: t('toolbar.collapse'),
              expand: t('toolbar.expand'),
              popOut: t('toolbar.popOut'),
              copyPath: t('actions.copyPath', 'Copy file path'),
              pathCopied: t('actions.pathCopied', 'File path copied'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              previewHtml: t('actions.previewHtml', 'Open HTML preview in new tab'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saveShortcut: t('actions.saveShortcut'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
              unsavedChanges: t('unsavedChanges.indicator', 'Unsaved changes'),
            }}
          />

          {saveError && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {saveError}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
              language={loadedLanguage?.fileName === file.name ? loadedLanguage.extension : []}
              onViewChange={handleViewChange}
              onCursorChange={(line, column) => setCursor({ line, column })}
              onChunksChange={setChangeCount}
              gotoTarget={gotoTarget}
            />
          </div>

          <CodeEditorFooter
            content={content}
            line={cursor.line}
            column={cursor.column}
            language={resolvedLanguage.name}
            dirty={hasUnsavedChanges}
            labels={{
              line: t('status.line'), column: t('status.column'), lines: t('footer.lines'),
              saved: t('status.saved'), unsaved: t('unsavedChanges.indicator'),
            }}
          />
        </div>
      </div>
    </>
  );
}
