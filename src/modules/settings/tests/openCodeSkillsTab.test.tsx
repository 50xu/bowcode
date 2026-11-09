import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/provider-agents', () => ({
  ProviderAgents: () => null,
  useProviderAgents: () => ({ agents: [] }),
}));
vi.mock('@/modules/skills', () => ({
  ProviderSkills: ({ selectedProvider }: { selectedProvider: string }) => <div>Skills for {selectedProvider}</div>,
}));
vi.mock('@/modules/mcp', () => ({ McpServers: () => null }));
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/PermissionsContent', () => ({ default: () => null }));
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/AccountContent', () => ({ default: () => null }));

describe('OpenCode settings', () => {
  it('shows the existing provider Skills panel for OpenCode', () => {
    render(
      <AgentsSettingsTab
        providerAuthStatus={{
          claude: { authenticated: false },
          codex: { authenticated: false },
          opencode: { authenticated: false },
        } as never}
        onProviderLogin={() => {}}
        claudePermissions={{ skipPermissions: false, allowedTools: [], disallowedTools: [] }}
        onClaudePermissionsChange={() => {}}
        defaultPermissionModes={{ claude: '', codex: '', opencode: '' }}
        onDefaultPermissionModeChange={() => {}}
        projects={[]}
      />,
    );
    fireEvent.click(screen.getByText('OpenCode'));
    fireEvent.click(screen.getByText('tabs.skills'));
    expect(screen.getByText('Skills for opencode')).toBeTruthy();
  });
});
