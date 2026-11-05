import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import {
  createOpenCodeV2Database,
  insertOpenCodeCredential,
} from '@/modules/providers/tests/fixtures/opencode-v2-db.js';

const OPENCODE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
];

type CredentialsStatus = { authenticated: boolean; email: string | null; method: string | null };

/** Runs the credential check against a throwaway home with no provider env keys. */
const checkCredentialsIn = async (setUp: (homeDir: string) => Promise<void>): Promise<CredentialsStatus> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-'));
  const originalHomedir = os.homedir;
  const originalEnv = OPENCODE_AUTH_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  (os as any).homedir = () => homeDir;
  for (const key of OPENCODE_AUTH_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    await setUp(homeDir);
    // The CLI probe in getStatus() is not under test; the credential lookup is.
    return await (new OpenCodeProviderAuth() as any).checkCredentials();
  } finally {
    (os as any).homedir = originalHomedir;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

test('OpenCode is authenticated by a credential stored in the v2 credential table', async () => {
  const status = await checkCredentialsIn(async (homeDir) => {
    const db = createOpenCodeV2Database(homeDir);
    try {
      insertOpenCodeCredential(db, { id: 'cred-1', integrationId: 'anthropic', label: 'Work key' });
    } finally {
      db.close();
    }
  });

  assert.deepEqual(status, { authenticated: true, email: 'anthropic credentials', method: 'credentials_store' });
});

test('OpenCode falls back to the credential label and ignores inactive credentials', async () => {
  const labelled = await checkCredentialsIn(async (homeDir) => {
    const db = createOpenCodeV2Database(homeDir);
    try {
      insertOpenCodeCredential(db, { id: 'cred-1', integrationId: null, label: 'Work key' });
    } finally {
      db.close();
    }
  });
  assert.equal(labelled.email, 'Work key');

  const inactive = await checkCredentialsIn(async (homeDir) => {
    const db = createOpenCodeV2Database(homeDir);
    try {
      insertOpenCodeCredential(db, { id: 'cred-1', integrationId: 'anthropic', label: 'Old', active: 0 });
    } finally {
      db.close();
    }
  });
  assert.equal(inactive.authenticated, false);
});

test('OpenCode is authenticated by providers declared in the global config', async () => {
  const status = await checkCredentialsIn(async (homeDir) => {
    const configDir = path.join(homeDir, '.config', 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ providers: { 'my-proxy': {} } }), 'utf8');
  });

  assert.deepEqual(status, { authenticated: true, email: 'my-proxy provider', method: 'config' });
});

test('OpenCode falls back to provider API keys in the environment', async () => {
  const withKey = await checkCredentialsIn(async () => {
    process.env.OPENAI_API_KEY = 'test';
  });
  assert.deepEqual(withKey, { authenticated: true, email: 'OPENAI_API_KEY', method: 'environment' });

  const nothing = await checkCredentialsIn(async () => {});
  assert.equal(nothing.authenticated, false);
});
