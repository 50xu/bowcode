import path from 'node:path';

import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

// Search alone avoids expensive dependency and VCS directories; listing remains unfiltered.
const SEARCH_SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg']);
const DIRECTORY_LIMIT = 2_000;
const RESPONSE_LIMIT = 20_000;

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */

type SearchIndexEntry = {
  name: string;
  path: string;
  relativePath: string;
  nameLower: string;
  relativeLower: string;
  type: 'file' | 'directory';
};
type SearchIndex = { entries: SearchIndexEntry[]; truncated: boolean; builtAt: number };

// Search reads a per-project index built by one breadth-first walk, instead of
// walking the disk on every keystroke (2s per query on a 100k-entry workspace).
// A stale index is served while a fresh one builds; file-tree writes mark it stale.
const SEARCH_INDEX_TTL_MS = 30_000;
const SEARCH_INDEX_ENTRY_LIMIT = 300_000;
const SEARCH_INDEX_TIME_LIMIT_MS = 10_000;

/** basename prefix > basename substring > path substring > subsequence; -1 for no match. */
function scoreSearchEntry(entry: SearchIndexEntry, term: string): number {
  if (entry.nameLower.startsWith(term)) return 0;
  if (entry.nameLower.includes(term)) return 1;
  if (entry.relativeLower.includes(term)) return 2;
  let position = 0;
  for (const character of term) {
    const found = entry.relativeLower.indexOf(character, position);
    if (found < 0) return -1;
    position = found + 1;
  }
  return 3;
}

export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  const searchIndexes = new Map<string, { index: SearchIndex | null; building: Promise<SearchIndex> | null }>();

  async function buildSearchIndex(projectRoot: string): Promise<SearchIndex> {
    const entries: SearchIndexEntry[] = [];
    const started = Date.now();
    let level = [projectRoot];
    let truncated = false;
    while (level.length && !truncated) {
      const next: string[] = [];
      // One level at a time, its directories read in parallel under the shared limiter.
      const listed = await Promise.all(level.map(async (directory) => {
        const found: Array<{ name: string; absolute: string; isDirectory: boolean }> = [];
        await acquire();
        try {
          for await (const entry of fileSystem.openDirectory(directory)) {
            found.push({ name: entry.name, absolute: path.join(directory, entry.name), isDirectory: entry.isDirectory() });
          }
        } catch (error) {
          const code = readErrorCode(error);
          if (code !== 'EACCES' && code !== 'EPERM') dependencies.logger.error(`Error indexing directory "${directory}"`, error);
        } finally { release(); }
        return found;
      }));
      for (const found of listed) {
        for (const item of found) {
          if (entries.length >= SEARCH_INDEX_ENTRY_LIMIT || Date.now() - started >= SEARCH_INDEX_TIME_LIMIT_MS) {
            truncated = true;
            break;
          }
          const relativePath = path.relative(projectRoot, item.absolute).split(path.sep).join('/');
          entries.push({
            name: item.name,
            path: item.absolute,
            relativePath,
            nameLower: item.name.toLowerCase(),
            relativeLower: relativePath.toLowerCase(),
            type: item.isDirectory ? 'directory' : 'file',
          });
          // A performance guard for fuzzy search, not a view filter: the tree still lists these.
          if (item.isDirectory && !SEARCH_SKIP_DIRECTORIES.has(item.name)) next.push(item.absolute);
        }
        if (truncated) break;
      }
      level = next;
    }
    return { entries, truncated, builtAt: Date.now() };
  }

  /** The project's search index: built on first use, refreshed in the background once stale. */
  async function readSearchIndex(projectRoot: string): Promise<SearchIndex> {
    let slot = searchIndexes.get(projectRoot);
    if (!slot) {
      slot = { index: null, building: null };
      searchIndexes.set(projectRoot, slot);
    }
    const current = slot;
    const fresh = current.index && Date.now() - current.index.builtAt < SEARCH_INDEX_TTL_MS;
    if (!fresh && !current.building) {
      current.building = buildSearchIndex(projectRoot)
        .then((index) => {
          current.index = index;
          return index;
        })
        .finally(() => {
          current.building = null;
        });
    }
    return current.index ?? current.building!;
  }

  /** Writes through the file tree make the next search see them. */
  function markSearchIndexStale(projectRoot: string): void {
    const slot = searchIndexes.get(projectRoot);
    if (slot?.index) slot.index = { ...slot.index, builtAt: 0 };
  }

  // Stream directory entries without materializing beyond the per-directory cap.
  async function collectEntries(directoryPath: string): Promise<{ entries: FileTreeDirectoryEntry[]; truncated: number }> {
    const entries: FileTreeDirectoryEntry[] = [];
    let truncated = 0;
    const compare = (a: FileTreeDirectoryEntry, b: FileTreeDirectoryEntry) => a.isDirectory() !== b.isDirectory()
      ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name);
    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        // Keep the first 2,000 in display order whatever the filesystem order:
        // binary insertion into the sorted window, dropping its last entry.
        const full = entries.length >= DIRECTORY_LIMIT;
        if (full) truncated += 1;
        if (full && compare(entry, entries[entries.length - 1]) >= 0) continue;
        let low = 0;
        let high = entries.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compare(entries[middle], entry) <= 0) low = middle + 1;
          else high = middle;
        }
        entries.splice(low, 0, entry);
        if (full) entries.pop();
      }
    } catch (error) {
      const code = readErrorCode(error);
      if (code !== 'EACCES' && code !== 'EPERM') dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
    } finally { release(); }
    return { entries, truncated };
  }

  async function hasEntries(directoryPath: string): Promise<boolean> {
    await acquire();
    try {
      for await (const _entry of fileSystem.openDirectory(directoryPath)) return true;
    } catch { /* Unreadable directories cannot be expanded. */ }
    finally { release(); }
    return false;
  }

  async function buildFileTree(directoryPath: string, depth: number, remaining: { value: number }): Promise<{ children: FileTreeNode[]; truncated: number }> {
    if (remaining.value <= 0) return { children: [], truncated: 0 };
    const { entries, truncated } = await collectEntries(directoryPath);
    // Reserve budget for siblings before descending into the selected directories.
    const selected = entries.slice(0, remaining.value);
    remaining.value -= selected.length;
    const children: FileTreeNode[] = [];
    for (const entry of selected) {
      const item = await (async (): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name, path: itemPath, type: entry.isDirectory() ? 'directory' : 'file',
        size: 0, modified: null, permissions: '000', permissionsRwx: '---------',
      };
      try {
        await acquire();
        try {
          const stats = await fileSystem.lstat(itemPath);
          const owner = (stats.mode >> 6) & 7;
          const group = (stats.mode >> 3) & 7;
          const other = stats.mode & 7;
          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
          item.permissions = `${owner}${group}${other}`;
          item.permissionsRwx = permissionBitsToRwx(owner) + permissionBitsToRwx(group) + permissionBitsToRwx(other);
          if (stats.isSymbolicLink()) item.isSymlink = true;
        } finally { release(); }
      } catch { /* Metadata failures do not hide entries. */ }
      if (entry.isDirectory()) {
        const forbidden = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));
        if (depth > 1 && !forbidden && remaining.value > 0) {
          const subtree = await buildFileTree(itemPath, depth - 1, remaining);
          item.children = subtree.children;
          if (subtree.truncated) item.truncated = subtree.truncated;
        } else {
          item.hasChildren = !forbidden && await hasEntries(itemPath);
        }
      }
      return item;
      })();
      children.push(item);
    }
    return { children, truncated: truncated + entries.length - selected.length };
  }

  async function resolveListedPath(projectRoot: string, input: string): Promise<string> {
    const resolved = !input || input === '.' ? path.resolve(projectRoot) : resolvePathInsideProject(projectRoot, input);
    // realpath prevents a symlink under the project from escaping the root.
    try {
      if (resolved !== path.resolve(projectRoot)) {
        const canonical = await fileSystem.realpath(resolved);
        resolvePathInsideProject(projectRoot, canonical);
      }
      const stats = await fileSystem.stat(resolved);
      if (!stats.isDirectory()) throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw createFileTreeError('Directory not found', 404, 'DIRECTORY_NOT_FOUND');
    }
    return resolved;
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = (await buildFileTree(resolvedPath, 1, { value: RESPONSE_LIMIT })).children;
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      let directory: string;
      try {
        directory = await resolveListedPath(projectRoot, options?.path ?? '');
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_OUTSIDE_PROJECT') {
          throw createFileTreeError('Path must be under project root', 400, 'PATH_OUTSIDE_PROJECT');
        }
        throw error;
      }
      const tree = await buildFileTree(directory, options?.depth ?? 2, { value: RESPONSE_LIMIT });
      return options?.path !== undefined || options?.depth !== undefined ? tree : tree.children;
    },

    async searchProjectFiles(projectId, query, limit, type) {
      const projectRoot = await resolveProjectRoot(projectId);
      const index = await readSearchIndex(projectRoot);
      const term = query.toLowerCase();
      const matches: Array<SearchIndexEntry & { score: number }> = [];
      for (const entry of index.entries) {
        if (type !== 'any' && type !== entry.type) continue;
        if (!term) {
          if (entry.type === 'file') matches.push({ ...entry, score: 0 });
          continue;
        }
        const score = scoreSearchEntry(entry, term);
        if (score >= 0) matches.push({ ...entry, score });
      }
      // The index is breadth-first, so a stable sort keeps shallow paths first
      // among equal scores; an empty query returns the first files that way.
      if (term) {
        matches.sort((a, b) => a.score - b.score || a.relativePath.length - b.relativePath.length || a.relativePath.localeCompare(b.relativePath));
      }
      return {
        results: matches.slice(0, limit).map(({ name, path: absolutePath, relativePath, type: kind }) => ({ name, path: absolutePath, relativePath, type: kind })),
        truncated: index.truncated,
      };
    },

    async statProjectFile(projectId, filePath) {
      const root = await resolveProjectRoot(projectId);
      let resolved: string;
      try {
        resolved = !filePath || filePath === '.' ? path.resolve(root) : resolvePathInsideProject(root, filePath);
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_OUTSIDE_PROJECT') {
          throw createFileTreeError('Path must be under project root', 400, 'PATH_OUTSIDE_PROJECT');
        }
        throw error;
      }
      try {
        if (resolved !== path.resolve(root)) {
          const canonical = await fileSystem.realpath(resolved);
          resolvePathInsideProject(root, canonical);
        }
        const stats = await fileSystem.stat(resolved);
        return { exists: true, type: stats.isDirectory() ? 'directory' as const : 'file' as const, path: resolved };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (readErrorCode(error) === 'ENOENT') return { exists: false, type: null, path: resolved };
        throw error;
      }
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      markSearchIndexStale(projectRoot);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      markSearchIndexStale(projectRoot);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      markSearchIndexStale(projectRoot);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        markSearchIndexStale(projectRoot);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
