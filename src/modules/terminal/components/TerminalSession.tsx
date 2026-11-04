import { useEffect, useRef, useState } from 'react';

import { useXterm } from '@/modules/terminal/hooks/useXterm';
import { IS_PLATFORM } from '@/shared/utils';
import { getStoredAuthToken } from '@/shared/authToken';

type Props = { projectPath: string; terminalId: string; active: boolean; onTitle: (title: string) => void; onStatus: (status: 'connected' | 'reconnecting' | 'closed') => void; onKillReady: (kill: () => void) => void };

/** Rendered by TerminalView for each retained terminal tab. */
export function TerminalSession({ projectPath, terminalId, active, onTitle, onStatus, onKillReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // Connection state controls the tab's status dot and reconnect notice.
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'closed'>('reconnecting');
  useEffect(() => { onStatus(status); }, [onStatus, status]);
  const { terminalRef } = useXterm(containerRef, {
    onInput: (data) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'input', data })); },
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
      const token = IS_PLATFORM ? null : getStoredAuthToken();
      if (!IS_PLATFORM && !token) {
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

  useEffect(() => { if (active) { terminalRef.current?.focus(); } }, [active, terminalRef]);

  return (
    <div className={`${active ? 'flex' : 'hidden'} relative h-full min-h-0 flex-col bg-[#141729] p-3`}>
      {status === 'reconnecting' && <span className="absolute right-5 top-4 z-10 rounded-full border border-[#262B40] bg-[#0F1222] px-3 py-1 text-xs text-[#8A93A8]">Reconnecting…</span>}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      <span className="sr-only" data-terminal-status={terminalId}>{status}</span>
    </div>
  );
}
