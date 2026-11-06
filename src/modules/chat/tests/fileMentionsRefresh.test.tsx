import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for #1367: a file added after the composer loaded the
 * project's file list (an upload, an agent edit, a terminal command) must be
 * offered by the `@` dropdown the next time the user types `@`, without a page
 * reload or a project switch.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const fileNode = (name: string) => ({ type: 'file', name, path: `${ROOT}/${name}` });
const treeResponse = (names: string[]) => ({ ok: true, json: async () => ({ results: names.map((name) => ({ ...fileNode(name), relativePath: name })) }) });

// A getFiles response the test resolves by hand, to hold a request in flight.
const deferredTreeResponse = () => {
  let resolve: (names: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof treeResponse>>((resolvePromise) => {
    resolve = (names) => resolvePromise(treeResponse(names));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement | null> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

test('mentions search as the user types and use project-relative paths', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue(treeResponse(['uploaded.txt']));
  const { type, shownNames } = renderMentions();
  type('@upl');
  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
  assert.equal(searchFiles.mock.calls[0][1], 'upl');
});

test('a later query aborts the previous search', async () => {
  searchFiles.mockReset();
  const older = deferredTreeResponse();
  searchFiles.mockReturnValueOnce(older.promise);
  searchFiles.mockResolvedValue(treeResponse(['new.txt']));
  const { type, shownNames } = renderMentions();
  type('@old');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@new');
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
  assert.equal((searchFiles.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted, true);
});
