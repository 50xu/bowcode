type CodeEditorFooterProps = {
  content: string;
  line: number;
  column: number;
  language: string;
  dirty: boolean;
  labels: { line: string; column: string; lines: string; saved: string; unsaved: string };
};

/** Used by CodeEditor to show cursor position, language and save state without a second toolbar. */
export default function CodeEditorFooter({ content, line, column, language, dirty, labels }: CodeEditorFooterProps) {
  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground">
      <span data-testid="editor-cursor">{labels.line} {line}, {labels.column} {column}</span>
      <div className="flex items-center gap-3">
        <span>{language}</span>
        <span>{labels.lines} {content.split('\n').length}</span>
        <span>{dirty ? labels.unsaved : labels.saved}</span>
      </div>
    </div>
  );
}
