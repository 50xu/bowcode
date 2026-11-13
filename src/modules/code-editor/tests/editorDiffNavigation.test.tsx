import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';

test('diff counter and previous/next controls reflect the active chunk', () => {
  const calls: number[] = [];
  const props = {
    file: { name: 'a.ts', path: '/repo/a.ts', diffInfo: { old_string: 'a', new_string: 'b' } },
    isSidebar: false, isExpanded: false, isFullscreen: false,
    isMarkdownFile: false, isHtmlPreviewFile: false, markdownPreview: false,
    showDiff: true, changeIndex: 0, changeCount: 3,
    saving: false, saveSuccess: false, hasUnsavedChanges: false,
    onToggleMarkdownPreview: () => {}, onOpenHtmlPreview: () => {}, onToggleDiff: () => {},
    onNavigateDiff: (direction: number) => calls.push(direction),
    onToggleExpand: null, onPopOut: null, onOpenSettings: () => {},
    onDownload: () => {}, onSave: () => {}, onToggleFullscreen: () => {}, onClose: () => {},
    labels: { changes: 'changes', previousChange: 'Previous', nextChange: 'Next', hideDiff: 'Hide', showDiff: 'Show', showingChanges: 'Changes', download: 'Download', saveShortcut: 'Save', settings: 'Settings', fullscreen: 'Fullscreen', close: 'Close', copyPath: 'Copy' },
  };
  const { rerender } = render(<CodeEditorHeader {...props} />);
  assert.ok(screen.getByText('1 / 3'));
  fireEvent.click(screen.getByTitle('Next'));
  fireEvent.click(screen.getByTitle('Previous'));
  assert.deepEqual(calls, [1, -1]);
  rerender(<CodeEditorHeader {...props} changeIndex={2} />);
  assert.ok(screen.getByText('3 / 3'));
});
