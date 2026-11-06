import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listing includes ignored and dependency directories, and marks depth boundary', async () => {
  const root = path.resolve('file-tree-test-project');
  const fs = createFakeFileSystem({
    stat: async () => createStats(true, 0o755),
    realpath: async (candidate) => candidate,
    openDirectory: createDirectoryReader((directory) => directory === root
      ? [createDirectoryEntry('node_modules', true), createDirectoryEntry('.git', true), createDirectoryEntry('ignored.log', false)]
      : [createDirectoryEntry('nested.txt', false)]),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fs, root));
  const listing = await service.listProjectFiles('p', { depth: 1 });
  assert.ok(!Array.isArray(listing));
  if (Array.isArray(listing)) return;
  assert.deepEqual(listing.children.map((node) => node.name), ['.git', 'node_modules', 'ignored.log']);
  assert.equal(listing.children[0].hasChildren, true);
  assert.equal(listing.children[0].children, undefined);
});

test('large directory returns sorted first 2000 and omitted count, never 413', async () => {
  const root = path.resolve('file-tree-test-project');
  const fs = createFakeFileSystem({
    stat: async () => createStats(true, 0o755),
    openDirectory: createDirectoryReader(() => Array.from({ length: 30_000 }, (_, i) => createDirectoryEntry(`file-${String(30_000 - i).padStart(5, '0')}`, false))),
    lstat: async () => createStats(false, 0o644),
  });
  const listing = await createFileTreeService(createDependencies(fs, root)).listProjectFiles('p', { depth: 1 });
  if (Array.isArray(listing)) return assert.fail('Expected lazy response');
  assert.equal(listing.children.length, 2000);
  assert.equal(listing.children[0].name, 'file-00001');
  assert.equal(listing.truncated, 28_000);
});

test('listing enforces the shared response budget without rejecting nested trees', async () => {
  const root = path.resolve('file-tree-test-project');
  const fs = createFakeFileSystem({
    stat: async () => createStats(true, 0o755),
    openDirectory: createDirectoryReader((directory) => directory === root
      ? Array.from({ length: 20 }, (_, i) => createDirectoryEntry(`dir-${i}`, true))
      : Array.from({ length: 2_000 }, (_, i) => createDirectoryEntry(`file-${i}`, false))),
    lstat: async () => createStats(false, 0o644),
  });
  const listing = await createFileTreeService(createDependencies(fs, root)).listProjectFiles('p', { depth: 2 });
  if (Array.isArray(listing)) return assert.fail('Expected lazy response');
  assert.equal(listing.children.reduce((total, node) => total + 1 + (node.children?.length ?? 0), 0), 20_000);
  assert.ok(listing.children.some((node) => node.hasChildren && !node.children));
});

test('listing traversal is rejected before filesystem access', async () => {
  const root = path.resolve('file-tree-test-project');
  const service = createFileTreeService(createDependencies(createFakeFileSystem(), root));
  await assert.rejects(service.listProjectFiles('p', { path: '../outside' }), (error: unknown) =>
    error instanceof AppError && error.statusCode === 400);
});

test('search ranks prefix ahead of substring and does not descend into node_modules', async () => {
  const root = path.resolve('file-tree-test-project');
  const visited: string[] = [];
  const fs = createFakeFileSystem({
    openDirectory: createDirectoryReader((directory) => {
      visited.push(directory);
      return directory === root ? [createDirectoryEntry('node_modules', true), createDirectoryEntry('foo.ts', false), createDirectoryEntry('afoo.ts', false)] : [];
    }),
  });
  const result = await createFileTreeService(createDependencies(fs, root)).searchProjectFiles('p', 'foo', 1, 'file');
  assert.equal(result.results[0].name, 'foo.ts');
  assert.equal(visited.includes(path.join(root, 'node_modules')), false);
});

test('stat reports existing paths and missing files', async () => {
  const root = path.resolve('file-tree-test-project');
  const fs = createFakeFileSystem({
    realpath: async (candidate) => candidate,
    stat: async (candidate) => {
      if (candidate.endsWith('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return createStats(false, 0o644);
    },
  });
  const service = createFileTreeService(createDependencies(fs, root));
  assert.deepEqual(await service.statProjectFile('p', 'file.txt'), { exists: true, type: 'file', path: path.join(root, 'file.txt') });
  assert.deepEqual(await service.statProjectFile('p', 'missing'), { exists: false, type: null, path: path.join(root, 'missing') });
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});
