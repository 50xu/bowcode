import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { TerminalAccessories } from '@/modules/terminal/components/TerminalAccessories';
import { useXterm } from '@/modules/terminal/hooks/useXterm';
import { terminalInput, toggleModifier } from '@/modules/terminal/utils/terminalInput';
import type { Modifiers } from '@/modules/terminal/utils/terminalInput';
import { copyTextToClipboard } from '@/shared/utils';
import { getStoredAuthToken } from '@/shared/authToken';

type Props = { projectPath: string; terminalId: string; active: boolean; searchOpen: boolean; fontSize: number; onFontSize: (update: (size: number) => number) => void; onCloseSearch: () => void; onTitle: (title: string) => void; onStatus: (status: 'connected' | 'reconnecting' | 'closed') => void; onKillReady: (kill: () => void) => void; onInputReady: (input: (data: string) => void) => void };

/** Rendered by TerminalView for each retained terminal tab. */
export function TerminalSession({ projectPath, terminalId, active, searchOpen, fontSize, onFontSize, onCloseSearch, onTitle, onStatus, onKillReady, onInputReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // Connection state controls the tab's status dot and reconnect notice.
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'closed'>('reconnecting');
  useEffect(() => { onStatus(status); }, [onStatus, status]);
  // Modifier state is shared by physical typing and accessory keys.
  const [modifiers, setModifiers] = useState<Modifiers>({ ctrl: 'off', alt: 'off' });
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;
  // Search text is retained while navigating results in this tab.
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const send = useCallback((data: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'input', data }));
  }, []);
  const applyInput = useCallback((key: string, source: 'accessory' | 'typed') => {
    const current = modifiersRef.current;
    if (source === 'typed' && current.ctrl === 'off' && current.alt === 'off') {
      send(key);
      return;
    }
    const result = terminalInput(key, current, source);
    modifiersRef.current = result.modifiers;
    setModifiers(result.modifiers);
    send(result.data);
  }, [send]);
  const sendKey = useCallback((key: string) => applyInput(key, 'accessory'), [applyInput]);
  const sendTyped = useCallback((data: string) => applyInput(data, 'typed'), [applyInput]);
  const { terminalRef, searchRef } = useXterm(containerRef, {
    onInput: sendTyped,
    fontSize,
    onResize: (cols, rows) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'resize', cols, rows })); },
    onTitle,
  });

  useEffect(() => {
    let stopped = false;
    let terminalExited = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getStoredAuthToken();
      if (!token) {
        setStatus('closed');
        terminalRef.current?.writeln('Authentication token unavailable');
        return;
      }
      const url = `${protocol}//${window.location.host}/shell${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        ws.send(JSON.stringify({ type: 'init', projectPath, terminalId, cols: terminalRef.current?.cols ?? 80, rows: terminalRef.current?.rows ?? 24 }));
      };
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as { type: string; data?: string; message?: string };
          if (frame.type === 'ready') setStatus('connected');
          if (frame.type === 'output' && frame.data) terminalRef.current?.write(frame.data);
          if (frame.type === 'error') { terminalRef.current?.writeln(`\r\n${frame.message ?? 'Terminal error'}`); terminalExited = true; setStatus('closed'); ws.close(); }
          if (frame.type === 'exit') { terminalExited = true; setStatus('closed'); ws.close(); }
        } catch { /* Ignore malformed frames. */ }
      };
      ws.onclose = () => {
        if (stopped || socketRef.current !== ws) return;
        socketRef.current = null;
        if (terminalExited) return;
        setStatus('reconnecting');
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
      };
    };
    connect();
    onKillReady(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'kill' }));
    });
    return () => { stopped = true; clearTimeout(timer); socketRef.current?.close(); onKillReady(() => undefined); };
  }, [projectPath, terminalId]);

  useEffect(() => { onInputReady(send); }, [onInputReady, send]);
  useEffect(() => { if (active && !searchOpen) { terminalRef.current?.focus(); } }, [active, searchOpen, terminalRef]);
  useEffect(() => { if (searchOpen && active) searchInputRef.current?.focus(); }, [searchOpen, active]);
  useEffect(() => { if (!searchOpen) { searchRef.current?.clearDecorations(); terminalRef.current?.clearSelection(); } }, [searchOpen, searchRef, terminalRef]);
  const searchOptions = {
    decorations: {
      matchBackground: '#26635F', activeMatchBackground: '#4FD1C5',
      matchOverviewRuler: '#4FD1C5', activeMatchColorOverviewRuler: '#4FD1C5',
    },
  };
  const find = (previous: boolean, value = query) => {
    if (!value) { searchRef.current?.clearDecorations(); return; }
    if (previous) searchRef.current?.findPrevious(value, searchOptions);
    else searchRef.current?.findNext(value, searchOptions);
  };
  const hideKeyboard = () => terminalRef.current?.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.blur();

  return (
    <div className={`${active ? 'flex' : 'hidden'} relative h-full min-h-0 flex-col bg-[#141729] p-3`}>
      {status === 'reconnecting' && <span className="absolute right-5 top-4 z-10 rounded-full border border-[#262B40] bg-[#0F1222] px-3 py-1 text-xs text-[#8A93A8]">Reconnecting…</span>}
      {searchOpen && (
        <div className="absolute right-4 top-3 z-20 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-[#262B40] bg-[#0F1222] p-1 shadow-lg">
          <input ref={searchInputRef} aria-label="Search terminal text" placeholder="Find in terminal" value={query}
            onChange={(event) => { setQuery(event.target.value); find(false, event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCloseSearch(); } else if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); } }}
            className="min-w-0 w-40 bg-transparent px-2 text-sm text-[#E6E9F0] outline-hidden placeholder:text-[#8A93A8]" />
          <button type="button" aria-label="Previous match" className="p-1 text-[#8A93A8]" onClick={() => find(true)}><ChevronUp size={16} /></button>
          <button type="button" aria-label="Next match" className="p-1 text-[#8A93A8]" onClick={() => find(false)}><ChevronDown size={16} /></button>
          <button type="button" aria-label="Close search" className="p-1 text-[#8A93A8]" onClick={onCloseSearch}><X size={16} /></button>
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      <TerminalAccessories modifiers={modifiers} onModifier={(key) => setModifiers((current) => {
        const next = { ...current, [key]: toggleModifier(current[key]) };
        modifiersRef.current = next;
        return next;
      })} onKey={sendKey} onCopy={() => { const selection = terminalRef.current?.getSelection(); if (selection) void copyTextToClipboard(selection); }} onPaste={() => { void navigator.clipboard?.readText().then((text) => { if (text) send(text); }).catch(() => undefined); }} onHide={hideKeyboard} onFontSize={(delta) => onFontSize((size) => Math.max(10, Math.min(22, size + delta)))} />
      <span className="sr-only" data-terminal-status={terminalId}>{status}</span>
    </div>
  );
}
