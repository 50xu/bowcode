import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { X } from 'lucide-react';

const STORAGE_KEY = 'workspace-side-panel-width';
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 320;
/** The chat column keeps at least this much room. */
const MIN_CHAT_WIDTH = 360;

const readStoredWidth = (): number => {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
};

type WorkspaceSidePanelProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Desktop-only right-hand panel for the workspace tools (terminal, files, git,
 * tasks, …). Chat stays the main surface; this panel sits beside it and its
 * width is dragged from the left edge and remembered. Rendered by WorkspaceMain.
 */
export default function WorkspaceSidePanel({ title, onClose, children }: WorkspaceSidePanelProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; max: number } | null>(null);

  useEffect(() => { setWidth(readStoredWidth()); }, []);

  const maxWidth = useCallback(() => {
    const container = panelRef.current?.parentElement;
    const available = container ? container.clientWidth : window.innerWidth;
    return Math.max(MIN_WIDTH, available - MIN_CHAT_WIDTH);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width, max: maxWidth() };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // The handle is on the panel's left edge: moving left widens it.
    const next = drag.startWidth + (drag.startX - event.clientX);
    setWidth(Math.round(Math.min(drag.max, Math.max(MIN_WIDTH, next))));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setWidth((current) => {
      try { window.localStorage.setItem(STORAGE_KEY, String(current)); } catch { /* not persisted */ }
      return current;
    });
  };

  // Clamp on window resize so the chat column never gets squeezed out.
  useEffect(() => {
    const clamp = () => setWidth((current) => Math.min(current, maxWidth()));
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [maxWidth]);

  return (
    <div
      ref={panelRef}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          try { window.localStorage.setItem(STORAGE_KEY, String(DEFAULT_WIDTH)); } catch { /* not persisted */ }
        }}
        className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/40"
      />
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close side panel"
          title="Close side panel"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
