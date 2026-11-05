import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

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

test('defaults to GPT-6.1 Sol and lists GPT-6.1 Terra, as the bundled Codex 0.166 catalog does', () => {
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6.1-sol');
  assert.ok(findCodexModel(CODEX_PREDEFINED_MODELS.DEFAULT), 'the default must be one of the listed models');

  for (const value of ['gpt-6.1-sol', 'gpt-6.1-terra']) {
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
  // Codex only ships metadata for gpt-6.1-sol from 0.161.0 and gpt-6.1-terra
  // from 0.165.0 on. An older CLI still sends the request, but on fallback
  // metadata: it warns "Model metadata ... not found" and quietly drops
  // `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 165, `bundled @openai/codex ${version} predates 0.165.0`);
});
