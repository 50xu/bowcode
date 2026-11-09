import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import { ProviderAgents } from '@/modules/provider-agents';
import { api } from '@/shared/api';

vi.mock('@/shared/api', async (importOriginal) => ({
  ...await importOriginal<typeof SharedApi>(),
  api: { providers: { agents: vi.fn(), agent: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn() } },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof ReactI18next>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ProviderAgents', () => {
  it('lists both scopes and opens an existing raw file for editing', async () => {
    vi.mocked(api.providers.agents).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { agents: [
      { name: 'global', scope: 'user', description: 'Global helper', model: 'sonnet', filePath: '/home/agents/global.md', format: 'markdown' },
      { name: 'local', scope: 'project', description: 'Local helper', model: null, filePath: '/workspace/.claude/agents/local.md', format: 'markdown' },
    ] } }) } as Response);
    vi.mocked(api.providers.agent).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { content: '---\ndescription: Global helper\n---\nPrompt' } }) } as Response);
    render(<ProviderAgents provider="claude" workspaces={[{ name: 'Workspace', path: '/workspace' }]} />);
    expect(await screen.findByText('Global helper')).toBeTruthy();
    expect(screen.getByText('Local helper')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'providerAgents.edit' })[0]!);
    expect(await screen.findByLabelText('providerAgents.content')).toHaveProperty('value', '---\ndescription: Global helper\n---\nPrompt');
    await waitFor(() => expect(api.providers.agent).toHaveBeenCalledWith('claude', 'user', 'global', '/workspace'));
  });

  it('shows string API errors', async () => {
    vi.mocked(api.providers.agents).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Sign in required' }),
    } as Response);
    render(<ProviderAgents provider="claude" workspaces={[]} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sign in required');
  });

  it('includes HTTP status when the server response is not JSON', async () => {
    vi.mocked(api.providers.agents).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response);
    render(<ProviderAgents provider="claude" workspaces={[]} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'HTTP 404 Not Found');
  });
});
