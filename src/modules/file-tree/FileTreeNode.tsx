import type { DragEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, Upload } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { FileTreeNode as FileTreeNodeType } from '@/shared/types';
import { Input } from '@/shared/ui';
import FileContextMenu from '@/modules/file-tree/FileContextMenu';

type FileTreeNodeProps = {
  item: FileTreeNodeType;
  level: number;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  // Drag-and-drop upload targeting
  dropTarget?: string | null;
  onItemDragOver?: (event: DragEvent<HTMLDivElement>, targetPath: string) => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement | null>;
  operationLoading?: boolean;
};

type TreeItemIconProps = {
  item: FileTreeNodeType;
  isOpen: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

// A file dropped onto a file row should land next to it, in its parent folder.
function getParentDirectoryPath(itemPath: string) {
  const segments = itemPath.split(/[\\/]/);
  segments.pop();
  return segments.join('/');
}

function TreeItemIcon({ item, isOpen, renderFileIcon }: TreeItemIconProps) {
  if (item.type === 'directory') {
    return (
      <span className="flex shrink-0 items-center gap-0.5">
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground/70 transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
        {isOpen ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-blue-500" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </span>
    );
  }

  return <span className="ml-[18px] flex shrink-0 items-center">{renderFileIcon(item.name)}</span>;
}

/** Rendered by FileTreeList for each file or directory row, including its context menu and inline rename input. */
export default function FileTreeNode({
  item,
  level,
  expandedDirs,
  loadingDirs,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onUpload,
  onRefresh,
  dropTarget,
  onItemDragOver,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
}: FileTreeNodeProps) {
  const { t } = useTranslation();
  const isDirectory = item.type === 'directory';
  const isOpen = isDirectory && expandedDirs.has(item.path);
  const hasChildren = Boolean(isDirectory && (item.hasChildren || item.children?.length || item.truncated));
  const isRenaming = renamingItem?.path === item.path;
  const dragTargetPath = isDirectory ? item.path : getParentDirectoryPath(item.path);
  const isDropTarget = isDirectory && dropTarget === item.path;

  const nameClassName = cn(
    'text-[13px] leading-tight truncate',
    isDirectory ? 'font-medium text-foreground' : 'text-foreground/90',
  );

  const rowClassName = cn(
    'group flex items-center justify-between py-[3px] pr-2 hover:bg-accent/60 cursor-pointer rounded-sm transition-colors duration-100',
    isDirectory && isOpen && 'border-l-2 border-primary/30',
    (isDirectory && !isOpen) || !isDirectory ? 'border-l-2 border-transparent' : '',
    'relative',
    isDropTarget && 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/40',
  );

  // Render rename input if this item is being renamed
  if (isRenaming && setRenameValue && handleConfirmRename && handleCancelRename) {
    return (
      <div
        className={cn(rowClassName, 'bg-accent/30')}
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
        <Input
          ref={renameInputRef}
          type="text"
          value={renameValue || ''}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleConfirmRename();
            if (e.key === 'Escape') handleCancelRename();
          }}
          onBlur={() => {
            setTimeout(() => {
              handleConfirmRename();
            }, 100);
          }}
          className="h-6 flex-1 text-sm"
          disabled={operationLoading}
        />
      </div>
    );
  }

  const uploadHoverButton = isDirectory && onUpload && (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onUpload(item.path);
      }}
      title={t('fileTree.uploadToFolder', 'Upload files to "{{folder}}"', { folder: item.name })}
      aria-label={t('fileTree.uploadToFolder', 'Upload files to "{{folder}}"', { folder: item.name })}
      className={cn(
        'absolute right-1 top-1/2 -translate-y-1/2 rounded p-1',
        'bg-background/80 text-muted-foreground opacity-0 transition-opacity',
        'group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground',
      )}
    >
      <Upload className="h-3.5 w-3.5" />
    </button>
  );

  const rowContent = (
    <div
      className={rowClassName}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      onClick={() => onItemClick(item)}
      onDragOver={onItemDragOver ? (event) => onItemDragOver(event, dragTargetPath) : undefined}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
        <span className={nameClassName}>{item.name}</span>
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
        {item.type === 'file' && (
          <>
            <span className="tabular-nums">{formatFileSize(item.size)}</span>
            <span className="font-mono">{item.permissionsRwx}</span>
          </>
        )}
      </div>
      {uploadHoverButton}
    </div>
  );

  // Check if context menu callbacks are provided
  const hasContextMenu = onRename || onDelete || onNewFile || onNewFolder || onCopyPath || onDownload || onRefresh;

  return (
    <div className="select-none">
      {hasContextMenu ? (
        <FileContextMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onUpload={onUpload}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onRefresh={onRefresh}
        >
          {rowContent}
        </FileContextMenu>
      ) : (
        rowContent
      )}

      {isDirectory && isOpen && hasChildren && (
        <div className="relative">
          <span
            className="absolute bottom-0 top-0 border-l border-border/40"
            style={{ left: `${level * 16 + 14}px` }}
            aria-hidden="true"
          />
          {loadingDirs.has(item.path) && <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 16}px` }}>{t('fileTree.loading', 'Loading...')}</div>}
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              level={level + 1}
              expandedDirs={expandedDirs}
              loadingDirs={loadingDirs}
              onItemClick={onItemClick}
              renderFileIcon={renderFileIcon}
              formatFileSize={formatFileSize}
              onRename={onRename}
              onDelete={onDelete}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onCopyPath={onCopyPath}
              onDownload={onDownload}
              onUpload={onUpload}
              onRefresh={onRefresh}
              dropTarget={dropTarget}
              onItemDragOver={onItemDragOver}
              renamingItem={renamingItem}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              handleConfirmRename={handleConfirmRename}
              handleCancelRename={handleCancelRename}
              renameInputRef={renameInputRef}
              operationLoading={operationLoading}
            />
          ))}
          {!!item.truncated && <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 16}px` }}>{t('fileTree.moreItems', '... {{count}} more items', { count: item.truncated })}</div>}
        </div>
      )}
    </div>
  );
}
