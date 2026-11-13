import { EditorView } from '@codemirror/view';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import type { Extension } from '@codemirror/state';

/** Keep GitHub token colours while using the application's own chrome in both themes. */
export const getEditorTheme = (isDarkMode: boolean): Extension[] => [
  isDarkMode ? githubDark : githubLight,
  EditorView.theme({
    '&': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
    '.cm-content': { fontFamily: 'inherit', lineHeight: '1.6', caretColor: 'hsl(var(--foreground))' },
    '.cm-scroller': { fontFamily: 'inherit' },
    '.cm-gutters, .cm-gutter.cm-gutter-minimap': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--muted-foreground))',
      borderRight: '1px solid hsl(var(--border))',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'hsl(var(--muted) / 0.45)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'hsl(var(--primary) / 0.18) !important',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'hsl(var(--foreground))' },
    '.cm-deletedChunk': {
      backgroundColor: isDarkMode ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 235, 235, 1)',
      borderLeft: `3px solid ${isDarkMode ? 'rgba(239, 68, 68, 0.6)' : 'rgb(239, 68, 68)'}`,
      paddingLeft: '4px',
    },
    '.cm-insertedChunk': {
      backgroundColor: isDarkMode ? 'rgba(34, 197, 94, 0.15)' : 'rgba(230, 255, 237, 1)',
      borderLeft: `3px solid ${isDarkMode ? 'rgba(34, 197, 94, 0.6)' : 'rgb(34, 197, 94)'}`,
      paddingLeft: '4px',
    },
    '&.cm-merge-b .cm-changedText': { backgroundColor: isDarkMode ? 'rgba(34, 197, 94, 0.4)' : 'rgba(34, 197, 94, 0.3)' },
    '.cm-deletedChunk .cm-changedText': { backgroundColor: isDarkMode ? 'rgba(239, 68, 68, 0.4)' : 'rgba(239, 68, 68, 0.3)' },
  }, { dark: isDarkMode }),
];
