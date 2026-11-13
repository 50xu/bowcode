import assert from 'node:assert/strict';

import { test } from 'vitest';

import { resolveEditorLanguage } from '@/modules/code-editor/utils/editorExtensions';

test('language-data resolves common extensions, named files and unknown files', () => {
  for (const [filename, expected] of [
    ['app.ts', 'TypeScript'], ['main.go', 'Go'], ['Cargo.toml', 'TOML'],
    ['config.yaml', 'YAML'], ['Dockerfile', 'Dockerfile'], ['Makefile', 'Makefile'],
    ['.env.local', 'Environment'], ['notes.unrecognized_ext', 'Plain Text'],
  ]) {
    assert.equal(resolveEditorLanguage(filename).name, expected, filename);
  }
});

test('the same language shares its in-flight or completed support', async () => {
  const language = resolveEditorLanguage('foo.yaml');
  const first = language.load();
  const second = resolveEditorLanguage('bar.yml').load();
  assert.equal(await first, await second);
});
