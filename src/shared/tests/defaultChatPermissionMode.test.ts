import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/userSettings', () => ({
  readUserPreference: vi.fn(),
}));

import { readUserPreference } from '@/shared/userSettings';
import { readDefaultChatPermissionMode } from '@/shared/utils';

const modes = ['default', 'acceptEdits', 'bypassPermissions'] as const;

describe('readDefaultChatPermissionMode', () => {
  beforeEach(() => {
    vi.mocked(readUserPreference).mockReturnValue({});
  });

  it('remembers the last mode when no preference exists', () => {
    expect(readDefaultChatPermissionMode('codex', modes)).toBeNull();
  });

  it('migrates an explicitly selected legacy Codex mode', () => {
    vi.mocked(readUserPreference).mockReturnValue({ permissionMode: 'acceptEdits' });
    expect(readDefaultChatPermissionMode('codex', modes)).toBe('acceptEdits');
  });

  it('treats the legacy initial Codex default as remember last used', () => {
    vi.mocked(readUserPreference).mockReturnValue({ permissionMode: 'default' });
    expect(readDefaultChatPermissionMode('codex', modes)).toBeNull();
  });

  it('uses the new setting instead of a legacy value, including an explicit default', () => {
    vi.mocked(readUserPreference).mockReturnValue({ permissionMode: 'acceptEdits', defaultPermissionMode: 'default' });
    expect(readDefaultChatPermissionMode('codex', modes)).toBe('default');
  });

  it('rejects modes not supported by the provider', () => {
    vi.mocked(readUserPreference).mockReturnValue({ defaultPermissionMode: 'plan' });
    expect(readDefaultChatPermissionMode('codex', modes)).toBeNull();
  });
});
