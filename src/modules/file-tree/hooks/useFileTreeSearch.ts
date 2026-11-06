import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode } from '@/shared/types';

/** Searches the server instead of filtering the partially loaded tree. */
export function useFileTreeSearch(projectId?: string) {
  // Holds the user's current query independently of the loaded tree.
  const [searchQuery, setSearchQuery] = useState('');
  // Holds flat server matches for the search view.
  const [results, setResults] = useState<Array<Pick<FileTreeNode, 'name' | 'path' | 'type'> & { relativePath: string }>>([]);
  useEffect(() => {
    if (!projectId || !searchQuery.trim()) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(projectId, searchQuery.trim(), { signal: controller.signal, limit: 100 });
        if (response.ok) {
          const data = await response.json() as { results: typeof results };
          if (!controller.signal.aborted) setResults(data.results);
        }
      } catch { /* A new query cancels stale results. */ }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, searchQuery]);
  return { searchQuery, setSearchQuery, results };
}
