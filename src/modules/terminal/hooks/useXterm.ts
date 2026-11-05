import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';

const theme = {
  background: '#141729', foreground: '#E6E9F0', cursor: '#4FD1C5', selectionBackground: 'rgba(79,209,197,0.30)',
  black: '#1C2033', red: '#FF6B6B', green: '#4FD1C5', yellow: '#FFD166', blue: '#5AA9FF', magenta: '#C792EA', cyan: '#63E6E2', white: '#D0D5E2',
  brightBlack: '#5C6378', brightRed: '#FF8787', brightGreen: '#7EE8DD', brightYellow: '#FFE29A', brightBlue: '#8CC4FF', brightMagenta: '#DDB4F6', brightCyan: '#9AF1EE', brightWhite: '#FFFFFF',
};

type XtermCallbacks = { onInput: (data: string) => void; onResize: (cols: number, rows: number) => void; onTitle: (title: string) => void; fontSize: number };

/** Owns xterm and its addons for one terminal tab, including search and resizing. */
export function useXterm(containerRef: React.RefObject<HTMLDivElement | null>, callbacks: XtermCallbacks) {
  const terminalRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const callbacksRef = useRef(callbacks);
  const fitRef = useRef<FitAddon | null>(null);
  callbacksRef.current = callbacks;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal && terminal.options.fontSize !== callbacks.fontSize) {
      terminal.options.fontSize = callbacks.fontSize;
      fitRef.current?.fit();
      callbacksRef.current.onResize(terminal.cols, terminal.rows);
    }
  }, [callbacks.fontSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: callbacksRef.current.fontSize, lineHeight: 1.2, scrollback: 10000,
      allowProposedApi: true, macOptionIsMeta: true, theme,
    });
    const fit = new FitAddon();
    const unicode = new Unicode11Addon();
    const search = new SearchAddon();
    terminal.loadAddon(unicode);
    terminal.unicode.activeVersion = '11';
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(search);
    terminal.open(container);
    // WebGL is loaded only once the container has a real size (a renderer created
    // at 0x0 stays blank), and only for fine pointers: on touch devices the DOM
    // renderer gives better text selection and IME behaviour.
    // Opt-in for now: the DOM renderer is the verified path. Enable with
    // localStorage['terminal.webgl'] = '1' on a desktop browser.
    let webglOptIn = false;
    try { webglOptIn = window.localStorage.getItem('terminal.webgl') === '1'; } catch { /* storage unavailable */ }
    const wantsWebgl = webglOptIn && (window.matchMedia?.('(pointer: fine)').matches ?? false);
    let webglLoaded = false;
    const loadWebglOnce = () => {
      if (webglLoaded || !wantsWebgl) return;
      webglLoaded = true;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      } catch { /* xterm keeps its default DOM renderer when WebGL is unavailable. */ }
    };
    terminalRef.current = terminal;
    searchRef.current = search;
    fitRef.current = fit;
    const input = terminal.onData((data) => callbacksRef.current.onInput(data));
    const title = terminal.onTitleChange((value) => callbacksRef.current.onTitle(value));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
        fit.fit();
        loadWebglOnce();
        callbacksRef.current.onResize(terminal.cols, terminal.rows);
      }, 50);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
      input.dispose();
      title.dispose();
      terminal.dispose();
      terminalRef.current = null;
      searchRef.current = null;
      fitRef.current = null;
    };
  }, [containerRef]);

  return { terminalRef, searchRef };
}
