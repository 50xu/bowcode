import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Code2, Copy, Download, ExternalLink, Eye, EyeOff, Maximize2, Minimize2, Save, Settings, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { copyTextToClipboard } from '@/shared/utils';
import { Button, Tooltip } from '@/shared/ui';
import type { CodeEditorFile } from '@/shared/types';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isExpanded: boolean;
  isFullscreen: boolean;
  isMarkdownFile: boolean;
  isHtmlPreviewFile: boolean;
  markdownPreview: boolean;
  showDiff: boolean;
  changeIndex: number;
  changeCount: number;
  saving: boolean;
  saveSuccess: boolean;
  hasUnsavedChanges: boolean;
  onToggleMarkdownPreview: () => void;
  onOpenHtmlPreview: () => void;
  onToggleDiff: () => void;
  onNavigateDiff: (direction: number) => void;
  onToggleExpand: (() => void) | null;
  onPopOut: (() => void) | null;
  onOpenSettings: () => void;
  onDownload: () => void;
  onSave: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  labels: Record<string, string>;
  previewOnly?: boolean;
  previewActions?: ReactNode;
};

/** Used by CodeEditor to provide one compact React toolbar for editing, diff navigation and layout. */
export default function CodeEditorHeader(props: CodeEditorHeaderProps) {
  const { file, labels } = props;
  const { t } = useTranslation('codeEditor');
  // Copy feedback stays visible briefly without changing the path itself.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current); }, []);

  const copyPath = async () => {
    if (!(await copyTextToClipboard(file.path))) return;
    setCopiedPath(file.path);
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
    copyResetTimeoutRef.current = setTimeout(() => setCopiedPath(null), 2000);
  };

  const action = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip content={label} position="bottom" key={label}>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon}</Button>
    </Tooltip>
  );

  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <h3 className="shrink-0 truncate text-sm font-medium text-foreground">{file.name}</h3>
        {props.hasUnsavedChanges && <span role="img" aria-label={labels.unsavedChanges} title={labels.unsavedChanges} className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
        <Tooltip content={copiedPath === file.path ? (labels.pathCopied ?? t('actions.pathCopied')) : (labels.copyPath ?? t('actions.copyPath'))}>
          <button type="button" onClick={copyPath} className="group flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground" aria-label={copiedPath === file.path ? (labels.pathCopied ?? t('actions.pathCopied')) : (labels.copyPath ?? t('actions.copyPath'))}>
            <span className="min-w-0 truncate text-xs [direction:rtl]" title={file.path}>{file.path}</span>
            {copiedPath === file.path ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
          </button>
        </Tooltip>
        {file.diffInfo && <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{labels.showingChanges ?? t('header.showingChanges')}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.previewActions}
        {!props.previewOnly && props.isMarkdownFile && action(props.markdownPreview ? labels.editMarkdown : labels.previewMarkdown, props.markdownPreview ? <Code2 /> : <Eye />, props.onToggleMarkdownPreview)}
        {!props.previewOnly && props.isHtmlPreviewFile && action(labels.previewHtml, <Eye />, props.onOpenHtmlPreview)}
        {!props.previewOnly && file.diffInfo && <>
          {props.showDiff && <>
            <span className="px-1 text-xs text-muted-foreground" aria-label={labels.changes}>{props.changeCount ? `${props.changeIndex + 1} / ${props.changeCount}` : '0 / 0'}</span>
            {action(labels.previousChange, <ChevronUp />, () => props.onNavigateDiff(-1), !props.changeCount)}
            {action(labels.nextChange, <ChevronDown />, () => props.onNavigateDiff(1), !props.changeCount)}
          </>}
          {action(props.showDiff ? labels.hideDiff : labels.showDiff, props.showDiff ? <EyeOff /> : <Eye />, props.onToggleDiff)}
        </>}
        {!props.previewOnly && <>
          <span className="mx-1 h-4 w-px bg-border" />
          {action(labels.download, <Download />, props.onDownload)}
          {action(props.saveSuccess ? labels.saved : props.saving ? labels.saving : labels.saveShortcut, props.saveSuccess ? <Check /> : <Save />, props.onSave, props.saving)}
          <span className="mx-1 h-4 w-px bg-border" />
          {action(labels.settings, <Settings />, props.onOpenSettings)}
        </>}
        {props.isSidebar && props.onToggleExpand && action(props.isExpanded ? labels.collapse : labels.expand, props.isExpanded ? <Minimize2 /> : <Maximize2 />, props.onToggleExpand)}
        {props.isSidebar && props.onPopOut && action(labels.popOut, <ExternalLink />, props.onPopOut)}
        {!props.isSidebar && action(props.isFullscreen ? labels.exitFullscreen : labels.fullscreen, props.isFullscreen ? <Minimize2 /> : <Maximize2 />, props.onToggleFullscreen)}
        {action(labels.close, <X />, props.onClose)}
      </div>
    </div>
  );
}
