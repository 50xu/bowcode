import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

Element.prototype.scrollIntoView = vi.fn();

import type { Project } from '@/shared/types';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const searchFiles = vi.fn();
const openFile = vi.fn();
vi.mock('@/shared/api', () => ({ api: { searchFiles: (...args: unknown[]) => searchFiles(...args) } }));
vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({ usePaletteOps: () => ({ openFile }) }));
vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({ useGitActions: () => ({}) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ toggleDarkMode: vi.fn() }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

const { CommandPalette } = await import('@/modules/command-palette');
const project: Project = { projectId: 'p1', displayName: 'demo', fullPath: '/workspace/demo' };

test('typing in the palette debounces API file search and opens the chosen result', async () => {
  searchFiles.mockReset();
  openFile.mockReset();
  searchFiles.mockResolvedValue({ ok: true, json: async () => ({ results: [{ name: 'needle.ts', path: '/workspace/demo/src/needle.ts' }] }) });
  render(<CommandPalette selectedProject={project} onStartNewChat={vi.fn()} onOpenSettings={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = await screen.findByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value: 'need' } });
  fireEvent.change(input, { target: { value: 'needle' } });
  assert.equal(searchFiles.mock.calls.length, 0);
  await waitFor(() => assert.ok(searchFiles.mock.calls.some((call) => call[1] === 'needle')));
  assert.equal(searchFiles.mock.calls.filter((call) => call[1] === 'need').length, 0);
  const options = searchFiles.mock.calls.find((call) => call[1] === 'needle')![2];
  assert.equal(options.type, 'file');
  fireEvent.click(await screen.findByText('needle.ts'));
  assert.equal(openFile.mock.calls[0][0], '/workspace/demo/src/needle.ts');
});
