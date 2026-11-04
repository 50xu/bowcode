import { describe, expect, it } from 'vitest';

import { terminalInput, toggleModifier } from '@/modules/terminal/utils/terminalInput';
import { addSnippet, deleteSnippet, editSnippet, loadSnippets, saveSnippets } from '@/modules/terminal/utils/terminalSnippets';

describe('terminal input', () => {
  const off = { ctrl: 'off' as const, alt: 'off' as const };
  it('maps navigation and special keys to terminal sequences', () => {
    expect(['←', '↑', '↓', '→', 'Home', 'End', 'PgUp', 'PgDn', 'Tab', 'Esc'].map((key) => terminalInput(key, off).data))
      .toEqual(['\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~', '\t', '\x1b']);
  });
  it('consumes sticky Ctrl and Alt on the next typed character', () => {
    expect(terminalInput('c', { ...off, ctrl: 'armed' })).toEqual({ data: '\x03', modifiers: off });
    expect(terminalInput('x', { ...off, alt: 'armed' })).toEqual({ data: '\x1bx', modifiers: off });
    expect(toggleModifier(toggleModifier('off'))).toBe('locked');
    expect(terminalInput('c', { ...off, ctrl: 'locked' }).modifiers.ctrl).toBe('locked');
  });
});

describe('saved snippets', () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  it('seeds once and persists add, edit and delete, including an empty list', () => {
    const store = storage();
    const seeded = loadSnippets(store);
    expect(seeded.map((item) => item.command)).toEqual(['git status', 'git log --oneline -10', 'ls -la']);
    const added = addSnippet(seeded, 'Test', 'pwd');
    const edited = editSnippet(added, added.at(-1)!.id, 'Location', 'pwd -P');
    expect(edited.at(-1)).toMatchObject({ name: 'Location', command: 'pwd -P' });
    saveSnippets(edited, store);
    expect(loadSnippets(store)).toEqual(edited);
    const removed = deleteSnippet(edited, added.at(-1)!.id);
    expect(removed).toHaveLength(3);
    saveSnippets([], store);
    expect(loadSnippets(store)).toEqual([]);
  });
});

import { terminalInput as mapInput } from '@/modules/terminal/utils/terminalInput';
import { describe as d2, expect as e2, it as i2 } from 'vitest';

d2('typed input', () => {
  i2('passes autocompleted key names through verbatim', () => {
    e2(mapInput('End', { ctrl: 'off', alt: 'off' }, 'typed').data).toBe('End');
    e2(mapInput('End', { ctrl: 'off', alt: 'off' }, 'accessory').data).toBe('\x1b[F');
  });
  i2('still applies an armed Ctrl to a typed letter', () => {
    e2(mapInput('c', { ctrl: 'armed', alt: 'off' }, 'typed').data).toBe('\x03');
  });
});
