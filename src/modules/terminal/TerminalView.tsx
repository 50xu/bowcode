import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

import { TerminalSession } from '@/modules/terminal/components/TerminalSession';
import { addTab, closeTab, renameTab, restoreTabs, saveTabs } from '@/modules/terminal/utils/terminalTabs';
import type { TerminalTabsState } from '@/modules/terminal/utils/terminalTabs';

type Props = { projectPath: string };

/** Rendered by project-workspace and command/setup modals as the plain multi-tab terminal workspace. */
export function TerminalView({ projectPath }: Props) {
  // Per-project tabs and active selection survive workspace remounts.
  const [state, setState] = useState<TerminalTabsState>(() => restoreTabs(projectPath, window.localStorage));
  const killHandlers = useRef(new Map<string, () => void>());
  // Tracks live PTY connections so tab dots reflect actual socket status.
  const [statuses, setStatuses] = useState<Record<string, 'connected' | 'reconnecting' | 'closed'>>({});
  const handleStatus = useCallback((id: string, status: 'connected' | 'reconnecting' | 'closed') => {
    setStatuses((previous) => previous[id] === status ? previous : { ...previous, [id]: status });
  }, []);
  useEffect(() => { saveTabs(projectPath, state, window.localStorage); }, [projectPath, state]);

  const handleTitle = useCallback((id: string, title: string) => {
    const basename = title.split(/[\\/]/).filter(Boolean).at(-1) ?? title;
    setState((current) => renameTab(current, id, basename));
  }, []);
  const handleClose = (id: string) => {
    killHandlers.current.get(id)?.();
    killHandlers.current.delete(id);
    setState((current) => closeTab(current, id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#141729] text-[#E6E9F0]">
      <div role="tablist" aria-label="Terminals" className="flex min-h-12 items-center gap-1 overflow-x-auto border-b border-[#262B40] bg-[#0F1222] px-3">
        {state.tabs.map((tab) => (
          <div key={tab.id} className={`flex h-9 max-w-52 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm ${state.activeId === tab.id ? 'border-[#262B40] bg-[#141729] text-[#E6E9F0]' : 'border-transparent text-[#8A93A8] hover:bg-[#1C2033]'}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${statuses[tab.id] === 'connected' ? 'bg-[#4FD1C5]' : 'bg-[#5C6378]'}`} />
            <button type="button" role="tab" aria-selected={state.activeId === tab.id} className="min-w-0 flex-1 truncate text-left" onClick={() => setState((current) => ({ ...current, activeId: tab.id }))}>{tab.title}</button>
            <button type="button" aria-label={`Close ${tab.title}`} className="rounded p-0.5 hover:bg-[#262B40]" onClick={() => handleClose(tab.id)}><X size={14} /></button>
          </div>
        ))}
        <button type="button" aria-label="New terminal" className="rounded-lg p-2 text-[#8A93A8] hover:bg-[#262B40] hover:text-white" onClick={() => setState(addTab)}><Plus size={18} /></button>
      </div>
      <div className="min-h-0 flex-1">
        {state.tabs.map((tab) => <TerminalSession key={tab.id} projectPath={projectPath} terminalId={tab.id} active={tab.id === state.activeId} onTitle={(title) => handleTitle(tab.id, title)} onStatus={(status) => handleStatus(tab.id, status)} onKillReady={(kill) => killHandlers.current.set(tab.id, kill)} />)}
      </div>
    </div>
  );
}
