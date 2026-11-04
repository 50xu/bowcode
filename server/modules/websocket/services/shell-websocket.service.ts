import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { parseIncomingJsonObject } from '@/shared/utils.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type TerminalMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  terminalId?: string;
};

type PtySession = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
};

const ptySessionsMap = new Map<string, PtySession>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function readDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
}

function resolveCwd(requested: unknown): string {
  if (typeof requested === 'string' && requested.trim()) {
    try {
      const resolved = path.resolve(requested);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // An unavailable project should still open a usable login shell.
    }
  }
  return os.homedir();
}

type ShellWebSocketDependencies = { spawnPty?: typeof pty.spawn };

/** Used by the websocket gateway to retain independent login shells across socket reconnects. */
export function handleShellConnection(ws: WebSocket, dependencies: ShellWebSocketDependencies = {}, request?: AuthenticatedWebSocketRequest): void {
  let sessionKey: string | null = null;
  let attachedSession: PtySession | null = null;

  ws.on('message', (rawMessage: RawData) => {
    try {
      const message = parseIncomingJsonObject(rawMessage) as TerminalMessage | null;
      if (!message) return;

      if (message.type === 'init') {
        if (typeof message.terminalId !== 'string' || !TERMINAL_ID_PATTERN.test(message.terminalId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid terminal ID' }));
          return;
        }
        const cwd = resolveCwd(message.projectPath);
        // JSON encoding avoids ambiguous separators in project paths and identifiers.
        const userId = request?.user?.id ?? request?.user?.userId ?? null;
        const key = JSON.stringify([userId, cwd, message.terminalId]);
        const existing = ptySessionsMap.get(key);
        if (existing) {
          if (existing.timeoutId) clearTimeout(existing.timeoutId);
          existing.timeoutId = null;
          existing.ws = ws;
          sessionKey = key;
          attachedSession = existing;
          for (const chunk of existing.buffer) ws.send(JSON.stringify({ type: 'output', data: chunk }));
          ws.send(JSON.stringify({ type: 'ready' }));
          return;
        }

        const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
        const args = os.platform() === 'win32' ? [] : ['-l'];
        const processHandle = (dependencies.spawnPty ?? pty.spawn)(shell, args, {
          name: 'xterm-256color',
          cols: readDimension(message.cols, 80),
          rows: readDimension(message.rows, 24),
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
        const session: PtySession = { pty: processHandle, ws, buffer: [], timeoutId: null };
        ptySessionsMap.set(key, session);
        sessionKey = key;
        attachedSession = session;
        processHandle.onData((chunk) => {
          if (ptySessionsMap.get(key) !== session) return;
          session.buffer.push(chunk);
          if (session.buffer.length > 5000) session.buffer.shift();
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'output', data: chunk }));
          }
        });
        processHandle.onExit((event) => {
          if (ptySessionsMap.get(key) !== session) return;
          if (session.timeoutId) clearTimeout(session.timeoutId);
          ptySessionsMap.delete(key);
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'exit', exitCode: event.exitCode }));
          }
        });
        ws.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      if (!sessionKey || !attachedSession || ptySessionsMap.get(sessionKey) !== attachedSession || attachedSession.ws !== ws) return;
      if (message.type === 'input' && typeof message.data === 'string') {
        attachedSession.pty.write(message.data);
      } else if (message.type === 'resize') {
        attachedSession.pty.resize(readDimension(message.cols, 80), readDimension(message.rows, 24));
      } else if (message.type === 'kill') {
        if (attachedSession.timeoutId) clearTimeout(attachedSession.timeoutId);
        ptySessionsMap.delete(sessionKey);
        attachedSession.pty.kill();
        attachedSession = null;
        sessionKey = null;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: detail }));
    }
  });

  ws.on('close', () => {
    if (!sessionKey || !attachedSession || ptySessionsMap.get(sessionKey) !== attachedSession || attachedSession.ws !== ws) return;
    const session = attachedSession;
    const key = sessionKey;
    session.ws = null;
    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(key) !== session || session.ws !== null) return;
      ptySessionsMap.delete(key);
      session.pty.kill();
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => console.error('[ERROR] Terminal WebSocket error:', error));
}
