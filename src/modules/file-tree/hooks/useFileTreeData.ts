import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project,FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  setExpandedPaths: (paths: Set<string>) => void;
  loadDirectory: (path: string, force?: boolean) => Promise<void>;
  loadingDirs: Set<string>;
  rootTruncated: number;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  // The root has no row of its own; retain its omitted count for a final muted row.
  const [rootTruncated, setRootTruncated] = useState(0);
  // Loaded nodes are shared by the tree and ancestor reveal.
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  // Initial and refresh requests replace the visible root while loading.
  const [loading, setLoading] = useState(false);
  // Real request failures remain visible in the panel.
  const [error, setError] = useState<string | null>(null);
  // Explicit refresh requests trigger a new root fetch.
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const filesRef = useRef(files);
  useEffect(() => { filesRef.current = files; }, [files]);
  // In-flight directory requests drive inline loading rows and deduplication.
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const pending = useRef(new Map<string, Promise<void>>());
  const generation = useRef(0);
  const expandedRef = useRef<Set<string>>(new Set());
  const setExpandedPaths = useCallback((paths: Set<string>) => { expandedRef.current = paths; }, []);

  const loadDirectory = useCallback((path: string, force = false): Promise<void> => {
    const projectId = selectedProject?.projectId;
    if (!projectId) return Promise.resolve();
    const find = (nodes: FileTreeNode[]): FileTreeNode | undefined => {
      for (const node of nodes) {
        if (node.path === path) return node;
        const found = find(node.children ?? []);
        if (found) return found;
      }
    };
    if (pending.current.has(path)) return pending.current.get(path)!;
    const node = find(filesRef.current);
    if (!node || (!force && (node.children !== undefined || !node.hasChildren))) return Promise.resolve();
    const currentGeneration = generation.current;
    setLoadingDirs((previous) => new Set(previous).add(path));
    const task = (async () => {
      try {
        const response = await api.getFiles(projectId, { path, depth: 1 });
        if (!response.ok) throw new Error(DEFAULT_LOAD_ERROR);
        const data = await response.json() as { children: FileTreeNode[]; truncated: number };
        if (generation.current !== currentGeneration) return;
        const merge = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map((entry) => entry.path === path
          ? { ...entry, children: data.children, truncated: data.truncated, hasChildren: data.children.length > 0 }
          : entry.children ? { ...entry, children: merge(entry.children) } : entry);
        filesRef.current = merge(filesRef.current);
        setFiles(filesRef.current);
      } catch (error) {
        if (generation.current === currentGeneration) setError(error instanceof Error ? error.message : DEFAULT_LOAD_ERROR);
      } finally {
        if (generation.current === currentGeneration) {
          pending.current.delete(path);
          setLoadingDirs((previous) => { const next = new Set(previous); next.delete(path); return next; });
        }
      }
    })();
    pending.current.set(path, task);
    return task;
  }, [selectedProject?.projectId]);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      generation.current += 1;
      filesRef.current = [];
      setRootTruncated(0);
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    generation.current += 1;
    pending.current.clear();
    setLoadingDirs(new Set());
    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFiles(projectId, { depth: 2, signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as { children: FileTreeNode[]; truncated: number };
        if (isActive) {
          filesRef.current = data.children;
          setRootTruncated(data.truncated);
          setFiles(data.children);
          // Reload expanded paths in ancestor order so their nodes are available.
          void (async () => {
            for (const directory of [...expandedRef.current].sort((a, b) => a.length - b.length)) {
              if (!isActive) break;
              await loadDirectory(directory, true);
            }
          })();
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.projectId, refreshKey, loadDirectory]);

  return {
    files,
    loading,
    error,
    refreshFiles,
    loadDirectory,
    loadingDirs,
    rootTruncated,
    setExpandedPaths,
  };
}
