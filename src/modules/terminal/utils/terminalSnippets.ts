export type Snippet = { id: string; name: string; command: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const KEY = 'terminal:snippets';
const defaults: Snippet[] = [
  { id: 'git-status', name: 'git status', command: 'git status' },
  { id: 'git-log', name: 'git log --oneline -10', command: 'git log --oneline -10' },
  { id: 'ls-la', name: 'ls -la', command: 'ls -la' },
];

/** Loads saved snippets, seeding examples only when no saved list exists. */
export function loadSnippets(storage: Storage): Snippet[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) ?? 'null');
    if (Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.command === 'string')) return value;
  } catch { /* Storage may be unavailable. */ }
  return defaults.map((item) => ({ ...item }));
}

/** Saves the full snippet list under a single storage key. */
export function saveSnippets(snippets: Snippet[], storage: Storage): void {
  try { storage.setItem(KEY, JSON.stringify(snippets)); } catch { /* Private browsing may disallow writes. */ }
}

/** Creates a command with an independent identity. */
export function addSnippet(snippets: Snippet[], name: string, command: string): Snippet[] {
  return [...snippets, { id: crypto.randomUUID(), name: name.trim(), command: command.trim() }];
}

/** Updates the named command without changing its identity. */
export function editSnippet(snippets: Snippet[], id: string, name: string, command: string): Snippet[] {
  return snippets.map((item) => item.id === id ? { ...item, name: name.trim(), command: command.trim() } : item);
}

/** Removes a saved command. */
export function deleteSnippet(snippets: Snippet[], id: string): Snippet[] {
  return snippets.filter((item) => item.id !== id);
}
