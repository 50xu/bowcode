import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import CodexRuleFileEditor from '@/modules/settings/tabs/agents-settings/sections/content/CodexRuleFileEditor';
import OpenCodePermissionRules from '@/modules/settings/tabs/agents-settings/sections/content/OpenCodePermissionRules';

const listCodex = vi.fn<() => Promise<Response>>();
const saveCodex = vi.fn<(name: string, content: string) => Promise<Response>>();
const readOpenCode = vi.fn<() => Promise<Response>>();
const saveOpenCode = vi.fn<(permission: unknown) => Promise<Response>>();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { providers: {
    codexRules: () => listCodex(),
    saveCodexRules: (name: string, content: string) => saveCodex(name, content),
    opencodePermissionRules: () => readOpenCode(),
    saveOpencodePermissionRules: (permission: unknown) => saveOpenCode(permission),
  } },
}));

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

beforeEach(() => {
  listCodex.mockReset();
  saveCodex.mockReset();
  readOpenCode.mockReset();
  saveOpenCode.mockReset();
});

describe('native rule file editors', () => {
  it('creates default.rules when no Codex files exist and cancels an unsaved edit', async () => {
    listCodex.mockResolvedValue(response({ files: [] }));
    saveCodex.mockResolvedValue(response({ name: 'default.rules', content: 'prefix_rule()\n' }));
    render(<CodexRuleFileEditor />);
    const editor = await screen.findByRole('textbox', { name: 'Codex rule file' });
    fireEvent.change(editor, { target: { value: 'prefix_rule()\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(saveCodex).toHaveBeenCalledWith('default.rules', 'prefix_rule()\n');
    expect(await screen.findByText('default.rules')).toBeTruthy();
    fireEvent.change(editor, { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Changes' }));
    expect((editor as HTMLTextAreaElement).value).toBe('prefix_rule()\n');
  });

  it('keeps unsupported OpenCode permission values read-only', async () => {
    readOpenCode.mockResolvedValue(response({ permission: { bash: { '*': 'custom' } } }));
    render(<OpenCodePermissionRules />);
    expect(await screen.findByText('Preserved keys (read-only): bash')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'bash' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(saveOpenCode).not.toHaveBeenCalled();
  });

  it('preserves a scalar OpenCode action on save', async () => {
    readOpenCode.mockResolvedValue(response({ permission: 'ask' }));
    saveOpenCode.mockResolvedValue(response({ permission: 'deny' }));
    render(<OpenCodePermissionRules />);
    const panel = screen.getByTestId('opencode-permission-rules');
    fireEvent.change(await within(panel).findByRole('combobox', { name: 'Global action' }), { target: { value: 'deny' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save Changes' }));
    expect(saveOpenCode).toHaveBeenCalledWith('deny');
  });
});
