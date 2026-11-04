import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Search, X, Zap } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

import { TerminalSession } from '@/modules/terminal/components/TerminalSession';
import { addSnippet, deleteSnippet, editSnippet, loadSnippets, saveSnippets } from '@/modules/terminal/utils/terminalSnippets';
import type { Snippet } from '@/modules/terminal/utils/terminalSnippets';
import { addTab, closeTab, renameTab, restoreTabs, saveTabs } from '@/modules/terminal/utils/terminalTabs';
import type { TerminalTabsState } from '@/modules/terminal/utils/terminalTabs';

type Props = { projectPath: string };

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Rendered by project-workspace and command/setup modals as the plain multi-tab terminal workspace. */
export function TerminalView({ projectPath }: Props) {
  // Per-project tabs and active selection survive workspace remounts.
  const [state, setState] = useState<TerminalTabsState>(() => restoreTabs(projectPath, storage() ?? { getItem: () => null, setItem: () => undefined }));
  const killHandlers = useRef(new Map<string, () => void>());
  const inputHandlers = useRef(new Map<string, (data: string) => void>());
  // Tracks live PTY connections so tab dots reflect actual socket status.
  const [statuses, setStatuses] = useState<Record<string, 'connected' | 'reconnecting' | 'closed'>>({});
  // The same controls apply to all tabs; font size is shared and persisted locally.
  const [fontSize, setFontSize] = useState(() => {
    const value = Number(storage()?.getItem('terminal:fontSize'));
    return Number.isInteger(value) && value >= 10 && value <= 22 ? value : window.innerWidth < 640 ? 13 : 14;
  });
  // Snippets remain available across projects and remounts.
  const [snippets, setSnippets] = useState<Snippet[]>(() => loadSnippets(storage() ?? { getItem: () => null, setItem: () => undefined }));
  // Only one terminal tool overlay is shown at a time.
  const [panel, setPanel] = useState<'snippets' | 'search' | null>(null);
  // The inline editor tracks the snippet being changed, or a new snippet when null.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Draft fields are held independently until the user saves them.
  const [draftName, setDraftName] = useState('');
  const [draftCommand, setDraftCommand] = useState('');
  const handleStatus = useCallback((id: string, status: 'connected' | 'reconnecting' | 'closed') => {
    setStatuses((previous) => previous[id] === status ? previous : { ...previous, [id]: status });
  }, []);
  useEffect(() => { const target = storage(); if (target) saveTabs(projectPath, state, target); }, [projectPath, state]);
  useEffect(() => { const target = storage(); if (target) saveSnippets(snippets, target); }, [snippets]);
  useEffect(() => { try { storage()?.setItem('terminal:fontSize', String(fontSize)); } catch { /* Storage unavailable. */ } }, [fontSize]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setPanel('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleTitle = useCallback((id: string, title: string) => {
    const basename = title.split(/[\\/]/).filter(Boolean).at(-1) ?? title;
    setState((current) => renameTab(current, id, basename));
  }, []);
  const handleClose = (id: string) => {
    killHandlers.current.get(id)?.();
    killHandlers.current.delete(id);
    inputHandlers.current.delete(id);
    setState((current) => closeTab(current, id));
  };
  const sendSnippet = (command: string, run: boolean) => {
    inputHandlers.current.get(state.activeId)?.(command + (run ? '\r' : ''));
    setPanel(null);
  };
  const saveDraft = () => {
    if (!draftName.trim() || !draftCommand.trim()) return;
    setSnippets((current) => editingId ? editSnippet(current, editingId, draftName, draftCommand) : addSnippet(current, draftName, draftCommand));
    setEditingId(null);
    setDraftName('');
    setDraftCommand('');
  };
  const toolButton = 'shrink-0 rounded-lg p-2 text-[#8A93A8] hover:bg-[#262B40] hover:text-white';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#141729] text-[#E6E9F0]">
      <div className="flex min-h-12 items-center border-b border-[#262B40] bg-[#0F1222] px-3">
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.tabs.map((tab) => (
            <div key={tab.id} className={`flex h-9 max-w-52 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm ${state.activeId === tab.id ? 'border-[#262B40] bg-[#141729] text-[#E6E9F0]' : 'border-transparent text-[#8A93A8] hover:bg-[#1C2033]'}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${statuses[tab.id] === 'connected' ? 'bg-[#4FD1C5]' : 'bg-[#5C6378]'}`} />
              <button type="button" role="tab" aria-selected={state.activeId === tab.id} className="min-w-0 flex-1 truncate text-left" onClick={() => setState((current) => ({ ...current, activeId: tab.id }))}>{tab.title}</button>
              <button type="button" aria-label={`Close ${tab.title}`} className="rounded p-0.5 hover:bg-[#262B40]" onClick={() => handleClose(tab.id)}><X size={14} /></button>
            </div>
          ))}
          <button type="button" aria-label="New terminal" className={toolButton} onClick={() => setState(addTab)}><Plus size={18} /></button>
        </div>
        <button type="button" aria-label="Search terminal" title="Search (Ctrl/⌘+Shift+F)" className={toolButton} onClick={() => setPanel((value) => value === 'search' ? null : 'search')}><Search size={18} /></button>
        <button type="button" aria-label="Snippets" title="Snippets" className={toolButton} onClick={() => setPanel((value) => value === 'snippets' ? null : 'snippets')}><Zap size={18} /></button>
        <div className="hidden items-center gap-1 border-l border-[#262B40] pl-2 sm:flex">
          <button type="button" aria-label="Decrease terminal font size" className={toolButton} onClick={() => setFontSize((value) => Math.max(10, value - 1))}>A-</button>
          <button type="button" aria-label="Increase terminal font size" className={toolButton} onClick={() => setFontSize((value) => Math.min(22, value + 1))}>A+</button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.tabs.map((tab) => <TerminalSession key={tab.id} projectPath={projectPath} terminalId={tab.id} active={tab.id === state.activeId} searchOpen={panel === 'search' && tab.id === state.activeId} onCloseSearch={() => setPanel(null)} fontSize={fontSize} onFontSize={setFontSize} onTitle={(title) => handleTitle(tab.id, title)} onStatus={(status) => handleStatus(tab.id, status)} onKillReady={(kill) => killHandlers.current.set(tab.id, kill)} onInputReady={(input) => inputHandlers.current.set(tab.id, input)} />)}
        {panel === 'snippets' && (
          <div className="absolute right-2 top-2 z-20 w-[min(22rem,calc(100%-1rem))] max-h-[80%] overflow-y-auto rounded-xl border border-[#262B40] bg-[#0F1222] p-3 shadow-xl" aria-label="Saved snippets">
            <div className="mb-2 flex items-center justify-between"><strong className="text-sm">Snippets</strong><button type="button" aria-label="Close snippets" onClick={() => setPanel(null)}><X size={16} /></button></div>
            {snippets.map((snippet) => (
              <div key={snippet.id} className="mb-1 flex items-center gap-1 rounded-md border border-[#262B40] p-2 text-xs">
                <button type="button" className="min-w-0 flex-1 text-left" title="Paste command" onClick={() => sendSnippet(snippet.command, false)}><span className="block font-medium text-[#E6E9F0]">{snippet.name}</span><code className="block truncate text-[#8A93A8]">{snippet.command}</code></button>
                <button type="button" className="rounded px-1 text-[#4FD1C5]" aria-label={`Run ${snippet.name}`} onClick={() => sendSnippet(snippet.command, true)}>Run</button>
                <button type="button" className="rounded px-1 text-[#8A93A8]" aria-label={`Edit ${snippet.name}`} onClick={() => { setEditingId(snippet.id); setDraftName(snippet.name); setDraftCommand(snippet.command); }}>Edit</button>
                <button type="button" className="text-[#8A93A8]" aria-label={`Delete ${snippet.name}`} onClick={() => setSnippets((current) => deleteSnippet(current, snippet.id))}><X size={14} /></button>
              </div>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-[#262B40] pt-2">
              <input aria-label="Snippet name" placeholder="Name" value={draftName} onChange={(event) => setDraftName(event.target.value)} className="rounded border border-[#262B40] bg-[#141729] px-2 py-1 text-sm" />
              <input aria-label="Snippet command" placeholder="Command" value={draftCommand} onChange={(event) => setDraftCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveDraft(); }} className="rounded border border-[#262B40] bg-[#141729] px-2 py-1 font-mono text-sm" />
              <button type="button" className="self-end rounded bg-[#4FD1C5] px-3 py-1 text-sm text-[#0F1222]" onClick={saveDraft}>{editingId ? 'Save' : 'Add snippet'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
