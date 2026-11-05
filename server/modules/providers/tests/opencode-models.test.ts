import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  OpenCodeProviderModels,
  OPENCODE_PREDEFINED_MODELS,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';
import {
  createOpenCodeV2Database,
  insertOpenCodeCredential,
  insertOpenCodeSession,
} from '@/modules/providers/tests/fixtures/opencode-v2-db.js';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
];

/**
 * Runs one case against a throwaway OpenCode home, so the catalog the adapter
 * reports depends on the fixture rather than on the providers the machine
 * running the suite happens to be logged into.
 */
const withOpenCodeHome = async (
  setUp: (homeDir: string) => Promise<void>,
  runTest: (adapter: OpenCodeProviderModels) => Promise<void>,
  readModels: () => Promise<string[]> = async () => [],
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-'));
  const originalHomedir = os.homedir;
  const originalEnv = OPENCODE_ENV_KEYS.map((key) => [key, process.env[key]] as const);

  (os as any).homedir = () => homeDir;
  for (const key of OPENCODE_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    await setUp(homeDir);
    await runTest(new OpenCodeProviderModels(readModels));
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

/** Stores one active credential per integration id in OpenCode v2's `credential` table. */
const writeOpenCodeCredentials = async (
  homeDir: string,
  integrationIds: string[],
  inactiveIntegrationIds: string[] = [],
): Promise<void> => {
  const db = createOpenCodeV2Database(homeDir);
  try {
    for (const integrationId of integrationIds) {
      insertOpenCodeCredential(db, { id: `cred-${integrationId}`, integrationId, label: integrationId });
    }
    for (const integrationId of inactiveIntegrationIds) {
      insertOpenCodeCredential(db, { id: `cred-${integrationId}`, integrationId, label: integrationId, active: 0 });
    }
  } finally {
    db.close();
  }
};

const fallbackProviderIds = async (adapter: OpenCodeProviderModels): Promise<string[]> => {
  const catalog = await adapter.getSupportedModels();
  return [...new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]))].sort();
};

test('OpenCode falls back to the curated catalog only when no providers are known', async () => {
  await withOpenCodeHome(async () => {}, async (adapter) => {
    // Nothing readable about this install, so the picker keeps every option
    // rather than coming up empty.
    assert.deepEqual(await adapter.getSupportedModels(), OPENCODE_PREDEFINED_MODELS);
    assert.equal(
      (await adapter.getCurrentActiveModel()).model,
      OPENCODE_PREDEFINED_MODELS.DEFAULT,
    );
  });
  // OpenCode routes by `<providerID>/<modelID>`, so every option has to carry a
  // provider prefix that `opencode models --verbose` reports.
  const providerIds = new Set(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value.split('/')[0]),
  );
  assert.deepEqual([...providerIds].sort(), ['anthropic', 'opencode', 'opencode-go', 'openai'].sort());
  assert.equal(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.every((option) => /^[a-z0-9-]+\/.+/.test(option.value)),
    true,
  );
  assert.equal(
    new Set(OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value)).size,
    OPENCODE_PREDEFINED_MODELS.OPTIONS.length,
  );
  assert.equal(OPENCODE_PREDEFINED_MODELS.DEFAULT, 'opencode/gpt-5.6-terra');
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'opencode/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'anthropic/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'openai/gpt-5.6'),
  );
  // The Go gateway carries its own provider id, so its models must be curated
  // too - a Go subscriber otherwise authenticates while the picker offers
  // nothing they can run.
  const opencodeGoOptions = OPENCODE_PREDEFINED_MODELS.OPTIONS.filter(
    (option) => option.value.startsWith('opencode-go/'),
  );
  assert.equal(opencodeGoOptions.length, 27);
  assert.ok(opencodeGoOptions.every((option) => option.description === 'OpenCode Go'));
  const glmFlash = opencodeGoOptions.find(
    (option) => option.value === 'opencode-go/glm-5.3-flash',
  );
  assert.ok(glmFlash);
  // Effort choices come from `opencode models --verbose` variants; the runtime
  // turns a selected value into `--variant`, so the values have to match the
  // CLI's exactly.
  assert.deepEqual(
    glmFlash?.effort?.values.map((value) => value.value),
    ['low', 'high', 'max'],
  );
  assert.ok(
    opencodeGoOptions
      .filter((option) => !option.effort)
      .every((option) =>
        ['glm-5.1', 'kimi-k2.6', 'kimi-k2.7-code', 'mimo-v2.5', 'mimo-v2.5-pro',
          'minimax-m2.7', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus']
          .includes(option.value.slice('opencode-go/'.length)),
      ),
  );
});

test('OpenCode offers the CLI listing as is, since v2 only lists models it can route', async () => {
  // `opencode models` (v2) already leaves out providers that are not
  // connected, and it includes the free OpenCode Zen models that need no
  // credential, so narrowing it again would hide models the user can run.
  await withOpenCodeHome(
    async (homeDir) => {
      await writeOpenCodeCredentials(homeDir, ['claude-code']);
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { 'my-proxy': {} } });
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS.map((option) => option.value), ['my-proxy/oc-normal', 'opencode/big-pickle']);
      assert.equal(catalog.DEFAULT, 'my-proxy/oc-normal');
      assert.equal((await adapter.getCurrentActiveModel()).model, 'my-proxy/oc-normal');
    },
    async () => ['my-proxy/oc-normal', 'opencode/big-pickle'],
  );
});

test('OpenCode narrows the curated fallback to connected providers', async () => {
  // Asking for a provider the user never connected fails the whole run, so
  // when the CLI listing is unavailable an OpenCode Zen model must not be
  // offered - or defaulted to - on a machine that only holds an Anthropic key.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['anthropic']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(await fallbackProviderIds(adapter), ['anthropic']);
      assert.equal(catalog.DEFAULT.startsWith('anthropic/'), true);
      assert.equal((await adapter.getCurrentActiveModel()).model, catalog.DEFAULT);
    },
  );

  // A Go subscriber's credential store holds only `opencode-go`, so the
  // default has to move onto a Go model instead of the unreachable Zen default.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['opencode-go']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(await fallbackProviderIds(adapter), ['opencode-go']);
      assert.equal(catalog.DEFAULT, 'opencode-go/grok-4.6');
    },
  );

  // The catalog default survives whenever its own provider is connected.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['opencode', 'openai']),
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['openai', 'opencode']);
      assert.equal((await adapter.getSupportedModels()).DEFAULT, OPENCODE_PREDEFINED_MODELS.DEFAULT);
    },
  );

  // An inactive credential does not connect its provider.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['anthropic'], ['openai']),
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['anthropic']);
    },
  );

  // Providers configured rather than logged into count too: the v2
  // `providers` key and the legacy `provider` key, in JSONC.
  await withOpenCodeHome(
    async (homeDir) => {
      const configDir = path.join(homeDir, '.config', 'opencode');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'opencode.jsonc'),
        '{\n  // v2 key\n  "providers": { "openai": {} },\n  "provider": { "anthropic": { "options": {} } },\n}\n',
        'utf8',
      );
    },
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['anthropic', 'openai']);
    },
  );

  // An API key in the environment is enough on its own.
  await withOpenCodeHome(
    async () => {
      process.env.OPENAI_API_KEY = 'test';
    },
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['openai']);
    },
  );
});

test('OpenCode never falls back to foreign providers', async () => {
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['github-copilot']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS.map((option) => option.value), [
        'github-copilot/gpt-5.6-terra',
        'github-copilot/claude-sonnet-5.5',
      ]);
      assert.equal(catalog.DEFAULT, 'github-copilot/gpt-5.6-terra');
      assert.equal((await adapter.getCurrentActiveModel()).model, 'github-copilot/gpt-5.6-terra');
    },
    async () => ['github-copilot/gpt-5.6-terra', 'github-copilot/claude-sonnet-5.5'],
  );

  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['github-copilot']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS, []);
      assert.equal(catalog.DEFAULT, '');
    },
  );

  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['github-copilot']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS, []);
      assert.equal(catalog.DEFAULT, '');
    },
    async () => Promise.reject(new Error('OpenCode unavailable')),
  );
});

test('OpenCode keeps curated metadata for discovered models it already knows', async () => {
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['opencode-go']),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const [known, unknown] = catalog.OPTIONS;

      // The runtime turns the selected effort into `--variant`, so a known
      // model losing its levels would silently hide the Reasoning picker.
      assert.equal(known.value, 'opencode-go/glm-5.3-flash');
      assert.equal(known.label, 'GLM 5.3 Flash');
      assert.equal(known.description, 'OpenCode Go');
      assert.deepEqual(known.effort?.values.map((value) => value.value), ['low', 'high', 'max']);
      assert.deepEqual(unknown, {
        value: 'opencode-go/new-model',
        label: 'new-model',
        description: 'opencode-go',
      });
    },
    async () => ['opencode-go/glm-5.3-flash', 'opencode-go/new-model'],
  );
});

test('OpenCode counts providers from OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT', async () => {
  await withOpenCodeHome(
    async (homeDir) => {
      await writeOpenCodeCredentials(homeDir, ['anthropic']);
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { openai: {} } });
    },
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['anthropic', 'openai']);
    },
  );

  await withOpenCodeHome(
    async (homeDir) => {
      await writeOpenCodeCredentials(homeDir, ['anthropic']);
      const configPath = path.join(homeDir, 'custom-opencode.json');
      await writeFile(configPath, JSON.stringify({ provider: { openai: {} } }), 'utf8');
      process.env.OPENCODE_CONFIG = configPath;
    },
    async (adapter) => {
      assert.deepEqual(await fallbackProviderIds(adapter), ['anthropic', 'openai']);
    },
  );
});

test('OpenCode caches the CLI model listing and refreshes it in the background', async () => {
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['anthropic']),
    async () => {
      let now = 0;
      let listing = ['anthropic/claude-sonnet-5'];
      const pendingReads: Array<() => void> = [];
      let readCount = 0;
      const adapter = new OpenCodeProviderModels(
        () => {
          readCount += 1;
          const snapshot = listing;
          return new Promise((resolve) => {
            pendingReads.push(() => resolve(snapshot));
          });
        },
        () => now,
      );
      const flushRead = async (): Promise<void> => {
        pendingReads.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
      };

      // Concurrent first loads share one CLI invocation.
      const firstLoads = Promise.all([adapter.getSupportedModels(), adapter.getSupportedModels()]);
      await new Promise((resolve) => setImmediate(resolve));
      await flushRead();
      const [first, second] = await firstLoads;
      assert.equal(readCount, 1);
      assert.deepEqual(first.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-5']);
      assert.deepEqual(second, first);

      // Fresh cache: no new process.
      await adapter.getSupportedModels();
      assert.equal(readCount, 1);

      // Stale cache answers immediately and refreshes behind the response.
      now = 5 * 60_000;
      listing = ['anthropic/claude-opus-5'];
      const stale = await adapter.getSupportedModels();
      assert.deepEqual(stale.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-5']);
      assert.equal(readCount, 2);
      await flushRead();
      const refreshed = await adapter.getSupportedModels();
      assert.deepEqual(refreshed.OPTIONS.map((option) => option.value), ['anthropic/claude-opus-5']);
      assert.equal(readCount, 2);
    },
  );
});

test('OpenCode retries a failed CLI listing sooner than a successful one', async () => {
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentials(homeDir, ['anthropic']),
    async () => {
      let now = 0;
      let readCount = 0;
      const adapter = new OpenCodeProviderModels(
        async () => {
          readCount += 1;
          if (readCount === 1) {
            throw new Error('OpenCode unavailable');
          }
          return ['anthropic/claude-sonnet-5'];
        },
        () => now,
      );

      // Failure falls back to the connected-provider slice of the static catalog.
      const fallback = await adapter.getSupportedModels();
      assert.ok(fallback.OPTIONS.every((option) => option.value.startsWith('anthropic/')));

      now = 30_000;
      await adapter.getSupportedModels();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(readCount, 2);
      const recovered = await adapter.getSupportedModels();
      assert.deepEqual(recovered.OPTIONS.map((option) => option.value), ['anthropic/claude-sonnet-5']);
    },
  );
});

const writeOpenCodeSessionDatabase = async (homeDir: string, rows: Array<{ id: string; model: string }>) => {
  const db = createOpenCodeV2Database(homeDir);
  try {
    for (const row of rows) {
      insertOpenCodeSession(db, { id: row.id, directory: '/tmp/project' });
      // Stored verbatim, so a plain-string model can be exercised too.
      db.prepare('UPDATE session_v2 SET model = ? WHERE id = ?').run(row.model, row.id);
    }
  } finally {
    db.close();
  }
};

test('OpenCode composes the provider prefix into session model ids', async () => {
  // The lookup translates the app session id through the sessions database,
  // so point it at a throwaway file rather than the developer's real one.
  const tempSessionsDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-model-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempSessionsDirectory, 'auth.db');
    await initializeDatabase();
    // OpenCode stores the provider and model id in separate fields of the
    // session row ({"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), but
    // the CLI's `--model` flag only resolves the composed
    // `<providerID>/<modelID>` form. Resuming such a session without the prefix
    // fails with an unknown-model server error, which hits OpenRouter users
    // hardest because their model ids carry a slash themselves.
    await withOpenCodeHome(
      (homeDir) => writeOpenCodeSessionDatabase(homeDir, [
        {
          id: 'ses_openrouter',
          model: JSON.stringify({
            id: 'z-ai/glm-5.3-flash',
            providerID: 'openrouter',
            variant: 'default',
          }),
        },
        {
          id: 'ses_qualified',
          // An id that already carries the provider prefix must survive as-is.
          model: JSON.stringify({
            id: 'openrouter/z-ai/glm-5.3-flash',
            providerID: 'openrouter',
          }),
        },
        {
          id: 'ses_plain_string',
          model: 'opencode/gpt-5.6-terra',
        },
        {
          id: 'ses_github_copilot',
          model: JSON.stringify({
            id: 'gpt-5.6-terra',
            providerID: 'github-copilot',
          }),
        },
      ]),
      async (adapter) => {
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_openrouter')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_qualified')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_plain_string')).model,
          'opencode/gpt-5.6-terra',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_github_copilot')).model,
          'github-copilot/gpt-5.6-terra',
        );
      },
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempSessionsDirectory, { recursive: true, force: true });
  }
});
