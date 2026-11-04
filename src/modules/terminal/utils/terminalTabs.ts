export type TerminalTab = { id: string; title: string };
export type TerminalTabsState = { tabs: TerminalTab[]; activeId: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const keyFor = (projectPath: string) => `terminal:tabs:${projectPath}`;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** Restores only valid tab IDs and titles, keeping storage isolated per project. */
export function restoreTabs(projectPath: string, storage: Storage): TerminalTabsState {
  try {
    const saved: unknown = JSON.parse(storage.getItem(keyFor(projectPath)) ?? 'null');
    if (saved && typeof saved === 'object' && 'tabs' in saved && Array.isArray(saved.tabs)) {
      const tabs = saved.tabs.filter((tab): tab is TerminalTab => tab && validId(tab.id) && typeof tab.title === 'string').filter((tab, index, all) => all.findIndex((entry) => entry.id === tab.id) === index);
      if (tabs.length) {
        const activeId = 'activeId' in saved && validId(saved.activeId) && tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : tabs[0].id;
        return { tabs, activeId };
      }
    }
  } catch { /* Storage may be unavailable or contain stale data. */ }
  const id = crypto.randomUUID();
  return { tabs: [{ id, title: 'Terminal 1' }], activeId: id };
}

/** Persists the selected terminal and all titles for one project. */
export function saveTabs(projectPath: string, state: TerminalTabsState, storage: Storage): void {
  try { storage.setItem(keyFor(projectPath), JSON.stringify(state)); } catch { /* Private browsing may disallow writes. */ }
}

/** Adds a fresh independent PTY tab, selecting it immediately. */
export function addTab(state: TerminalTabsState): TerminalTabsState {
  const numbers = state.tabs.map((tab) => /^Terminal (\d+)$/.exec(tab.title)?.[1]).map(Number).filter(Number.isFinite);
  const id = crypto.randomUUID();
  return { tabs: [...state.tabs, { id, title: `Terminal ${Math.max(0, ...numbers) + 1}` }], activeId: id };
}

/** Removes a tab and selects its nearest neighbor, if any. */
export function closeTab(state: TerminalTabsState, id: string): TerminalTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return { tabs, activeId: state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? '') : state.activeId };
}

/** Applies a terminal's OSC title or cwd label without changing its identity. */
export function renameTab(state: TerminalTabsState, id: string, title: string): TerminalTabsState {
  if (!title.trim()) return state;
  return { ...state, tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, title: title.trim().slice(0, 100) } : tab) };
}
