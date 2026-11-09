import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

import '@/modules/i18n';
import PermissionsContent from '@/modules/settings/tabs/agents-settings/sections/content/PermissionsContent';
import type { ClaudeSettingsPermissionSource } from '@/shared/types';

// Issue #109: the Claude CLI applies the permission rules in its own settings
// files on top of the lists in this panel, so a tool could run (or be refused)
// with nothing here explaining why. The panel now lists those rules read-only.

const claudeSettingsPermissions = vi.fn<() => Promise<Response>>();
const addRule = vi.fn<(category: string, rule: string) => Promise<Response>>();
const removeRule = vi.fn<(category: string, rule: string) => Promise<Response>>();

// Only the endpoint is stubbed; `readApiJson` stays real so the panel parses
// the same envelope the server sends.
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { providers: {
    claudeSettingsPermissions: () => claudeSettingsPermissions(),
    addClaudeSettingsPermissionRule: (category: string, rule: string) => addRule(category, rule),
    removeClaudeSettingsPermissionRule: (category: string, rule: string) => removeRule(category, rule),
  } },
}));

const source = (overrides: Partial<ClaudeSettingsPermissionSource>): ClaudeSettingsPermissionSource => ({
  scope: 'user',
  path: '/home/me/.claude/settings.json',
  status: 'ok',
  allow: [],
  deny: [],
  ask: [],
  ...overrides,
});

const respondWith = (sources: ClaudeSettingsPermissionSource[]) => {
  claudeSettingsPermissions.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { sources } }), { status: 200 }),
  );
};

// The label and the rules of one Allow/Ask/Deny group, so a rule shown under
// the wrong label (a deny rule presented as allowed) fails the test.
const ruleGroup = (scope: ClaudeSettingsPermissionSource['scope'], key: 'allow' | 'ask' | 'deny') => {
  const group = screen.getByTestId(`claude-settings-file-${scope}-${key}`);
  return {
    label: group.firstElementChild?.textContent,
    rules: within(group).getAllByRole('listitem').map((item) => item.firstChild?.textContent),
  };
};

const renderClaudePermissions = () => render(
  <PermissionsContent
    agent="claude"
    skipPermissions={false}
    onSkipPermissionsChange={() => {}}
    allowedTools={['Bash(make:*)']}
    onAllowedToolsChange={() => {}}
    disallowedTools={[]}
    onDisallowedToolsChange={() => {}}
  />,
);

describe('Claude permissions: rules from the Claude settings files', () => {
  beforeEach(() => {
    claudeSettingsPermissions.mockReset();
    addRule.mockReset();
    removeRule.mockReset();
  });

  it('lists compact user file rules and keeps project details collapsed', async () => {
    respondWith([
      source({ allow: ['Bash(npm run test:*)', 'WebFetch'], ask: ['Bash(git push:*)'], deny: ['Bash(rm:*)'] }),
      source({ scope: 'managed', path: '/etc/claude-code/managed-settings.json', status: 'missing' }),
    ]);
    renderClaudePermissions();
    // Until the server answers, the panel says it is loading rather than "no rules".
    expect(screen.getByText('Loading rules…')).toBeTruthy();

    const card = await screen.findByTestId('claude-settings-file-user');
    expect(screen.queryByText('Loading rules…')).toBeNull();
    expect(within(card).getByText('Your settings')).toBeTruthy();
    expect(within(card).getByText('/home/me/.claude/settings.json').getAttribute('title')).toBe('/home/me/.claude/settings.json');
    expect(ruleGroup('user', 'allow')).toEqual({ label: 'Allow', rules: ['Bash(npm run test:*)', 'WebFetch'] });
    expect(ruleGroup('user', 'ask')).toEqual({ label: 'Ask', rules: ['Bash(git push:*)'] });
    expect(ruleGroup('user', 'deny')).toEqual({ label: 'Deny', rules: ['Bash(rm:*)'] });
    expect(within(card).getAllByRole('button')).toHaveLength(4);

    const section = screen.getByTestId('claude-settings-file-rules');
    expect(section.textContent).toContain('Rules from Claude settings files');
    expect(section.textContent).toContain('Your user settings can be edited here; project files are read-only.');
    const details = within(section).getByText('Details').closest('details');
    expect(details?.open).toBe(false);
    fireEvent.click(within(section).getByText('Details'));
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain('ignores allow rules in .claude/settings.json until the folder is trusted');
    // A managed file that does not exist is the normal case and stays hidden.
    expect(screen.queryByTestId('claude-settings-file-managed')).toBeNull();
    // The UI's own list is still there and unchanged.
    expect(screen.getByText('Bash(make:*)')).toBeTruthy();
  });

  it('adds a selected group rule and removes a user chip without editing managed rules', async () => {
    const user = source({ allow: ['Read'] });
    respondWith([user, source({ scope: 'managed', path: '/etc/managed.json', deny: ['Write'] })]);
    addRule.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { source: { ...user, ask: ['Bash(git push:*)'] } } })));
    removeRule.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { source: { ...user, allow: [] } } })));
    renderClaudePermissions();
    const card = await screen.findByTestId('claude-settings-file-user');
    fireEvent.change(screen.getByRole('textbox', { name: 'New rule' }), { target: { value: 'Bash(git push:*)' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Rule group' }), { target: { value: 'ask' } });
    fireEvent.click(within(screen.getByTestId('claude-settings-file-rules')).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Bash(git push:*)')).toBeTruthy();
    expect(addRule).toHaveBeenCalledWith('ask', 'Bash(git push:*)');
    fireEvent.click(within(card).getByRole('button', { name: 'Remove rule Read' }));
    expect(removeRule).toHaveBeenCalledWith('allow', 'Read');
    expect(within(screen.getByTestId('claude-settings-file-managed')).queryByRole('button')).toBeNull();
  });

  it('shows the managed settings file when one exists', async () => {
    respondWith([
      source({ status: 'missing' }),
      source({ scope: 'managed', path: '/etc/claude-code/managed-settings.json', deny: ['WebSearch'] }),
    ]);
    renderClaudePermissions();

    const managed = await screen.findByTestId('claude-settings-file-managed');
    expect(within(managed).getByText('Managed settings (administrator)')).toBeTruthy();
    expect(ruleGroup('managed', 'deny')).toEqual({ label: 'Deny', rules: ['WebSearch'] });
    expect(within(managed).queryByText('Allow')).toBeNull();
    expect(within(screen.getByTestId('claude-settings-file-user')).getByText('File not found, so it adds no rules.')).toBeTruthy();
  });

  it('says a file could not be read instead of showing rules when its JSON is invalid', async () => {
    respondWith([source({ status: 'invalid' })]);
    renderClaudePermissions();

    const card = await screen.findByTestId('claude-settings-file-user');
    expect(card.textContent).toContain('This file could not be read. Check that it is valid JSON.');
    expect(within(card).queryByText('Allow')).toBeNull();
  });

  it('says so when a readable file has no permission rules', async () => {
    respondWith([source({})]);
    renderClaudePermissions();

    const card = await screen.findByTestId('claude-settings-file-user');
    expect(card.textContent).toContain('No permission rules in this file.');
  });

  it('shows the load hint when the server answers with an error envelope', async () => {
    claudeSettingsPermissions.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500 }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderClaudePermissions();

    expect(await screen.findByText('Could not load the rules from the Claude settings files.')).toBeTruthy();
    expect(screen.queryByTestId('claude-settings-file-user')).toBeNull();
  });

  it('keeps the panel usable and shows a short hint when the rules cannot be loaded', async () => {
    claudeSettingsPermissions.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderClaudePermissions();

    expect(await screen.findByText('Could not load the rules from the Claude settings files.')).toBeTruthy();
    expect(screen.queryByTestId('claude-settings-file-user')).toBeNull();
    expect(screen.getByText('Allowed Tools')).toBeTruthy();
  });
});
