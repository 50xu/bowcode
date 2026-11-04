import { describe, expect, it } from 'vitest';

import { addTab, closeTab, renameTab, restoreTabs, saveTabs } from '@/modules/terminal/utils/terminalTabs';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('terminal tabs per project', () => {
  it('adds, closes and restores the active tab', () => {
    const storage = memoryStorage();
    const initial = restoreTabs('/one', storage);
    const added = addTab(initial);
    expect(added.tabs).toHaveLength(2);
    expect(added.activeId).toBe(added.tabs[1].id);
    saveTabs('/one', added, storage);
    expect(restoreTabs('/one', storage)).toEqual(added);
    const closed = closeTab(added, added.activeId);
    expect(closed.activeId).toBe(initial.activeId);
    saveTabs('/one', closed, storage);
    expect(restoreTabs('/one', storage)).toEqual(closed);
    expect(restoreTabs('/two', storage).tabs).toHaveLength(1);
  });

  it('renames a tab and persists its title', () => {
    const storage = memoryStorage();
    const initial = restoreTabs('/one', storage);
    const renamed = renameTab(initial, initial.activeId, 'src');
    saveTabs('/one', renamed, storage);
    expect(restoreTabs('/one', storage).tabs[0].title).toBe('src');
  });
});
