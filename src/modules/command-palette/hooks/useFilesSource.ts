import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type FileResult = { path: string; name: string };

/** Provides server-side file matches for the command palette. */
export function useFilesSource(projectId: string | undefined, enabled: boolean, query = '') {
  // The server limits results so the palette never retains the whole tree.
  const [items, setItems] = useState<FileResult[]>([]);
  useEffect(() => {
    if (!enabled || !projectId) { setItems([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(projectId, query, { type: 'file', limit: 200, signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { results: FileResult[] };
        if (!controller.signal.aborted) setItems(data.results.map(({ name, path }) => ({ name, path })));
      } catch { /* Ignore superseded queries. */ }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, enabled, query]);
  return items;
}
