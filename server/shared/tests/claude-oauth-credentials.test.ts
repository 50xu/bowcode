import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeOAuthCredentials } from '@/shared/utils.js';

test('readClaudeOAuthCredentials falls back to the credentials file when macOS Keychain lookup fails', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-oauth-credentials-test-'));
  try {
    const credentials = { claudeAiOauth: { accessToken: 'file-token' } };
    const claudeDir = path.join(homeDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));

    const result = await readClaudeOAuthCredentials({
      platform: 'darwin',
      homeDir,
      readKeychain: async () => { throw new Error('security unavailable'); },
    });

    assert.deepEqual(result, credentials);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
