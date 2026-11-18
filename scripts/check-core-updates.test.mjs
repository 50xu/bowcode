import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSemver, extractCodexSlugs, diffCatalog, renderMarkdown } from './check-core-updates.mjs';

test('compares semantic versions numerically and accepts dependency range lower bounds', () => {
  assert.equal(compareSemver('0.170.0', '^0.167.2'), 1);
  assert.equal(compareSemver('1.9.0', '~1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
  assert.throws(() => compareSemver('not-a-version', '1.0.0'), /Unsupported version/);
});

test('compares prereleases according to semver precedence', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareSemver(versions[i], versions[i - 1]), 1);
    assert.equal(compareSemver(versions[i - 1], versions[i]), -1);
  }
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.2'), 0);
});

test('extracts model slugs only from the curated OPTIONS array, not efforts or other arrays', () => {
  const source = `
    const unrelated = [{ value: 'outside', label: 'Outside' }];
    export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
      OPTIONS: [
        { value: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', effort: {
          values: [{ value: 'low' }, { value: 'ultra' }],
        } },
        { value: 'future-model', label: 'Future [model]' },
      ],
      DEFAULT: 'gpt-6.2-sol',
    };
    const after = [{ value: 'also-outside', label: 'Outside' }];
  `;
  assert.deepEqual(extractCodexSlugs(source), ['gpt-6.2-sol', 'future-model']);
  assert.throws(() => extractCodexSlugs('OPTIONS: []'), /not found/);
  assert.throws(() => extractCodexSlugs('CODEX_PREDEFINED_MODELS = { OPTIONS: ['), /Unterminated/);
});

test('catalog drift reports additions and removals without duplicates or order-only drift', () => {
  assert.deepEqual(diffCatalog(['b', 'a', 'b'], ['a', 'c']), { added: ['b'], removed: ['c'] });
  assert.deepEqual(diffCatalog(['b', 'a'], ['a', 'b']), { added: [], removed: [] });
  assert.deepEqual(diffCatalog([], []), { added: [], removed: [] });
});

test('renders outdated package table, npm link and catalog changes', () => {
  const markdown = renderMarkdown({
    outdated: [{ name: '@openai/codex', installed: '0.167.2', latest: '0.170.0' }],
    codexCatalog: { added: ['gpt-new'], removed: ['gpt-old'] },
  });
  assert.match(markdown, /\| @openai\/codex \| 0.167.2 \| 0.170.0 \|/);
  assert.match(markdown, /https:\/\/www.npmjs.com\/package\/%40openai%2Fcodex/);
  assert.match(markdown, /Added upstream: gpt-new/);
  assert.match(markdown, /Dropped upstream \(still listed by Bowcode\): gpt-old/);
});

test('renders no updates and skipped catalog checks', () => {
  assert.match(renderMarkdown({ outdated: [], codexCatalog: { added: [], removed: [] } }), /All core packages are up to date\.[\s\S]*No catalog drift\./);
  assert.match(renderMarkdown({ outdated: [], codexCatalog: { added: [], removed: [], skipped: 'npx failed\nnetwork' } }), /Catalog check skipped: npx failed network/);
});
