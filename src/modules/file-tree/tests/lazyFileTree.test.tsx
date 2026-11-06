import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string, values?: { count?: number }) =>
  key === 'fileTree.moreItems' ? fallback?.replace('{{count}}', String(values?.count)) : fallback ?? key }) }));

const ROOT = '/workspace/demo';
const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: ROOT, path: ROOT };
const getFiles = vi.fn();
const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    searchFiles: (...args: unknown[]) => searchFiles(...args),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const directory = (name: string, parent = ROOT) => ({ type: 'directory' as const, name, path: `${parent}/${name}`, hasChildren: true });
const file = (name: string, parent = ROOT) => ({ type: 'file' as const, name, path: `${parent}/${name}` });
const response = (children: unknown[], truncated = 0) => ({ ok: true, json: async () => ({ children, truncated }) });

beforeEach(() => {
  getFiles.mockReset();
  searchFiles.mockReset();
  searchFiles.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
});

test('lazy expansion shows Loading, merges children and never refetches on collapse/expand', async () => {
  let finish: (value: ReturnType<typeof response>) => void = () => {};
  const pending = new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; });
  getFiles.mockImplementation((_id: string, options: { path?: string }) => options.path ? pending : Promise.resolve(response([directory('src')])));
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByText('src'));
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2));
  assert.deepEqual(getFiles.mock.calls[1].slice(0, 2), ['p1', { path: `${ROOT}/src`, depth: 1 }]);
  assert.ok(screen.getByText('Loading...'));
  finish(response([file('index.ts', `${ROOT}/src`)]));
  assert.ok(await screen.findByText('index.ts'));
  fireEvent.click(screen.getByText('src'));
  assert.equal(screen.queryByText('index.ts'), null);
  fireEvent.click(screen.getByText('src'));
  assert.ok(screen.getByText('index.ts'));
  assert.equal(getFiles.mock.calls.length, 2);
});

test('revealing a deep directory fetches missing ancestors in order and expands them', async () => {
  getFiles.mockImplementation(async (_id: string, options: { path?: string }) => {
    if (!options.path) return response([directory('src')]);
    if (options.path === `${ROOT}/src`) return response([directory('modules', `${ROOT}/src`)]);
    return response([file('index.ts', `${ROOT}/src/modules`)]);
  });
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'src/modules/' }} />);
  assert.ok(await screen.findByText('index.ts'));
  assert.deepEqual(getFiles.mock.calls.map((call) => call[1].path), [undefined, `${ROOT}/src`, `${ROOT}/src/modules`]);
  assert.equal(getFiles.mock.calls[1][1].depth, 1);
  assert.equal(getFiles.mock.calls[2][1].depth, 1);
});

test('truncated directory ends with a muted omitted-item row', async () => {
  getFiles.mockImplementation(async (_id: string, options: { path?: string }) => options.path
    ? response([file('first.ts', `${ROOT}/src`)], 17)
    : response([directory('src')]));
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByText('src'));
  assert.ok(await screen.findByText('first.ts'));
  const more = screen.getByText('... 17 more items');
  assert.ok(more.className.includes('text-muted-foreground'));
  assert.equal(more.parentElement?.lastElementChild, more);
});

test('refresh fetches root and expanded directories, retaining their children', async () => {
  getFiles.mockImplementation(async (_id: string, options: { path?: string }) => options.path
    ? response([file('index.ts', `${ROOT}/src`)])
    : response([directory('src')]));
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByText('src'));
  assert.ok(await screen.findByText('index.ts'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 4));
  assert.deepEqual(getFiles.mock.calls.map((call) => call[1].path), [undefined, `${ROOT}/src`, undefined, `${ROOT}/src`]);
  assert.ok(await screen.findByText('index.ts'));
});

test('panel search is debounced, shows flat matches, opens files and reveals directories; clearing restores tree', async () => {
  getFiles.mockImplementation(async (_id: string, options: { path?: string }) => options.path
    ? response([file('nested.ts', `${ROOT}/src`)])
    : response([directory('src'), file('README.md')]));
  searchFiles.mockResolvedValue({ ok: true, json: async () => ({ results: [
    { ...file('nested.ts', `${ROOT}/src`), relativePath: 'src/nested.ts' },
    { ...directory('src'), relativePath: 'src' },
  ] }) });
  const onFileOpen = vi.fn();
  render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
  const input = await screen.findByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value: 'nes' } });
  fireEvent.change(input, { target: { value: 'nested' } });
  assert.equal(screen.queryByText('README.md'), null);
  assert.equal(searchFiles.mock.calls.length, 0);
  assert.ok(await screen.findByText('src/nested.ts'));
  assert.equal(searchFiles.mock.calls.length, 1);
  assert.equal(searchFiles.mock.calls[0][1], 'nested');
  fireEvent.click(screen.getByRole('button', { name: 'fileTree.clearSearch' }));
  assert.ok(screen.getByText('README.md'));
  fireEvent.change(input, { target: { value: 'nested' } });
  assert.ok(await screen.findByText('src/nested.ts'));
  fireEvent.click(screen.getByText('nested.ts'));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/nested.ts`);
  fireEvent.click(screen.getByRole('button', { name: 'src src' }));
  assert.equal((input as HTMLInputElement).value, '');
  assert.ok(await screen.findByText('nested.ts'));
  assert.ok(screen.getByText('README.md'));
});
