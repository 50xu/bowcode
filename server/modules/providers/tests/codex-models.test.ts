import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('defaults to GPT-6.2 Sol and lists both GPT-6.2 models from the bundled Codex 0.170 catalog', () => {
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6.2-sol');
  assert.ok(findCodexModel(CODEX_PREDEFINED_MODELS.DEFAULT), 'the default must be one of the listed models');

  assert.ok(findCodexModel('gpt-6.1-sol'));
  assert.ok(findCodexModel('gpt-6.1-terra'));

  for (const value of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
    const model = findCodexModel(value);
    assert.equal(model?.effort?.default, 'low', value);
    assert.deepEqual(
      model?.effort?.values.map((effort) => effort.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      value,
    );
  }
});

test('no longer offers the GPT-5.4 models the Codex CLI stopped shipping metadata for', () => {
  // Codex 0.158 removed them from its bundled catalog; offering them would run
  // every turn on fallback metadata.
  assert.equal(findCodexModel('gpt-5.4'), undefined);
  assert.equal(findCodexModel('gpt-5.4-mini'), undefined);
});

test('bundles a Codex CLI new enough to know every listed model', () => {
  // Codex ships GPT-6.2 metadata from 0.170.0 on.
  // An older CLI still sends the request, but on fallback
  // metadata: it warns "Model metadata ... not found" and quietly drops
  // `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 170, `bundled @openai/codex ${version} predates 0.170.0`);
});

test('curated catalog matches the model catalog bundled in the installed Codex CLI', () => {
  // Guard the core-update process relies on: scripts/check-core-updates.mjs only
  // compares slugs, so effort levels and default efforts could drift silently.
  // On drift, update CODEX_PREDEFINED_MODELS from `codex debug models --bundled`.
  // Labels, descriptions and option order are curated on purpose and not compared.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const output = execFileSync(
    path.join(repoRoot, 'node_modules', '.bin', 'codex'),
    ['debug', 'models', '--bundled'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const bundled = (
    JSON.parse(output) as {
      models: {
        slug: string;
        visibility: string;
        priority: number;
        default_reasoning_level: string;
        supported_reasoning_levels: { effort: string }[];
      }[];
    }
  ).models.filter((model) => model.visibility === 'list');

  const curatedSlugs = CODEX_PREDEFINED_MODELS.OPTIONS.map((option) => option.value);
  const bundledSlugs = bundled.map((model) => model.slug);
  const missing = bundledSlugs.filter((slug) => !curatedSlugs.includes(slug));
  const extra = curatedSlugs.filter((slug) => !bundledSlugs.includes(slug));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, 'curated slugs differ from bundled list-visible slugs');

  for (const model of bundled) {
    const option = findCodexModel(model.slug);
    assert.deepEqual(
      option?.effort?.values.map((effort) => effort.value),
      model.supported_reasoning_levels.map((level) => level.effort),
      `${model.slug}: effort levels`,
    );
    assert.equal(option?.effort?.default, model.default_reasoning_level, `${model.slug}: default effort`);
  }

  const topPriority = [...bundled].sort((a, b) => a.priority - b.priority)[0];
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, topPriority?.slug, 'default model is the lowest-priority bundled model');
});
