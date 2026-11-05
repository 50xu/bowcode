import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAppDataDir } from '../data-directory.js';

function withFakeHome(run: (homeDirectory: string) => void): void {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bowcode-data-test-'));
  try {
    run(homeDirectory);
  } finally {
    fs.rmSync(homeDirectory, { recursive: true, force: true });
  }
}

test('defaults to ~/.bowcode without creating it', () => {
  withFakeHome((homeDirectory) => {
    assert.equal(getAppDataDir(homeDirectory, {}), path.join(homeDirectory, '.bowcode'));
    assert.equal(fs.existsSync(path.join(homeDirectory, '.bowcode')), false);
  });
});

test('BOWCODE_DATA_DIR overrides the default without creating directories', () => {
  withFakeHome((homeDirectory) => {
    const custom = path.join(homeDirectory, 'custom');
    assert.equal(getAppDataDir(homeDirectory, { BOWCODE_DATA_DIR: custom }), custom);
    assert.equal(fs.existsSync(custom), false);
  });
});
