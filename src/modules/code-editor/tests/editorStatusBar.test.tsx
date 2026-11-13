import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import CodeEditorFooter from '@/modules/code-editor/CodeEditorFooter';

test('status bar shows cursor coordinates and detected language', () => {
  render(<CodeEditorFooter content={'one\ntwo'} line={2} column={3} language="YAML" dirty labels={{ line: 'Ln', column: 'Col', lines: 'Lines:', saved: 'Saved', unsaved: 'Unsaved' }} />);
  assert.equal(screen.getByTestId('editor-cursor').textContent, 'Ln 2, Col 3');
  assert.ok(screen.getByText('YAML'));
  assert.ok(screen.getByText('Unsaved'));
});
