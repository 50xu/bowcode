import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAppDataDir, migrateLegacyDataDirectory, migrateLegacyPlugins } from '../data-directory.js';

function withFakeHome(run: (homeDirectory: string) => void): void {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bowcode-data-test-'));
  try {
    run(homeDirectory);
  } finally {
    fs.rmSync(homeDirectory, { recursive: true, force: true });
  }
}

const emptyEnvironment = {} as NodeJS.ProcessEnv;

test('neither directory exists: returns ~/.bowcode without creating it', () => {
  withFakeHome((homeDirectory) => {
    migrateLegacyDataDirectory(homeDirectory, emptyEnvironment);
    assert.equal(getAppDataDir(homeDirectory, emptyEnvironment), path.join(homeDirectory, '.bowcode'));
    assert.equal(fs.existsSync(path.join(homeDirectory, '.bowcode')), false);
  });
});

test('old only: moves ~/.cloudcli to ~/.bowcode and links the old path', () => {
  withFakeHome((homeDirectory) => {
    const oldDirectory = path.join(homeDirectory, '.cloudcli');
    const newDirectory = path.join(homeDirectory, '.bowcode');
    fs.mkdirSync(oldDirectory);
    fs.writeFileSync(path.join(oldDirectory, 'auth.db'), 'database');

    migrateLegacyDataDirectory(homeDirectory, emptyEnvironment);
    migrateLegacyDataDirectory(homeDirectory, emptyEnvironment);

    assert.equal(getAppDataDir(homeDirectory, emptyEnvironment), newDirectory);
    assert.equal(fs.readFileSync(path.join(newDirectory, 'auth.db'), 'utf8'), 'database');
    assert.equal(fs.lstatSync(oldDirectory).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(oldDirectory), fs.realpathSync(newDirectory));
  });
});

test('both directories exist: leaves both untouched', () => {
  withFakeHome((homeDirectory) => {
    const oldDirectory = path.join(homeDirectory, '.cloudcli');
    const newDirectory = path.join(homeDirectory, '.bowcode');
    fs.mkdirSync(oldDirectory);
    fs.mkdirSync(newDirectory);
    fs.writeFileSync(path.join(oldDirectory, 'auth.db'), 'old');
    fs.writeFileSync(path.join(newDirectory, 'auth.db'), 'new');

    migrateLegacyDataDirectory(homeDirectory, emptyEnvironment);

    assert.equal(getAppDataDir(homeDirectory, emptyEnvironment), newDirectory);
    assert.equal(fs.readFileSync(path.join(oldDirectory, 'auth.db'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(newDirectory, 'auth.db'), 'utf8'), 'new');
    assert.equal(fs.lstatSync(oldDirectory).isSymbolicLink(), false);
  });
});

test('override uses BOWCODE_DATA_DIR and leaves default directories alone', () => {
  withFakeHome((homeDirectory) => {
    fs.mkdirSync(path.join(homeDirectory, '.cloudcli'));
    const custom = path.join(homeDirectory, 'custom');
    const environment = { BOWCODE_DATA_DIR: custom } as NodeJS.ProcessEnv;
    migrateLegacyDataDirectory(homeDirectory, environment);
    assert.equal(getAppDataDir(homeDirectory, environment), custom);
    assert.equal(fs.existsSync(path.join(homeDirectory, '.bowcode')), false);
    assert.equal(fs.lstatSync(path.join(homeDirectory, '.cloudcli')).isDirectory(), true);
  });
});

test('rename failure warns and continues using ~/.cloudcli', { concurrency: false }, () => {
  withFakeHome((homeDirectory) => {
    const oldDirectory = path.join(homeDirectory, '.cloudcli');
    fs.mkdirSync(oldDirectory);
    const originalRename = fs.renameSync;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    try {
      fs.renameSync = () => { throw new Error('simulated rename failure'); };
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      assert.doesNotThrow(() => migrateLegacyDataDirectory(homeDirectory, emptyEnvironment));
    } finally {
      fs.renameSync = originalRename;
      console.warn = originalWarn;
    }
    assert.equal(getAppDataDir(homeDirectory, emptyEnvironment), oldDirectory);
    assert.equal(warnings.length, 1);
    assert.equal(fs.existsSync(path.join(homeDirectory, '.bowcode')), false);
  });
});

test('plugin migration moves both legacy entries when the target has neither', () => {
  withFakeHome((homeDirectory) => {
    const legacy = path.join(homeDirectory, '.claude-code-ui');
    const target = getAppDataDir(homeDirectory, emptyEnvironment);
    fs.mkdirSync(path.join(legacy, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'plugins', 'manifest.json'), 'plugin');
    fs.writeFileSync(path.join(legacy, 'plugins.json'), 'legacy config');

    migrateLegacyPlugins(homeDirectory, emptyEnvironment);

    assert.equal(fs.readFileSync(path.join(target, 'plugins', 'manifest.json'), 'utf8'), 'plugin');
    assert.equal(fs.readFileSync(path.join(target, 'plugins.json'), 'utf8'), 'legacy config');
    assert.equal(fs.existsSync(legacy), true);
    assert.equal(fs.existsSync(path.join(legacy, 'plugins')), false);
    assert.equal(fs.existsSync(path.join(legacy, 'plugins.json')), false);
  });
});

test('plugin migration moves missing plugins and config, preserving legacy parent and existing targets', () => {
  withFakeHome((homeDirectory) => {
    const legacy = path.join(homeDirectory, '.claude-code-ui');
    const target = getAppDataDir(homeDirectory, emptyEnvironment);
    fs.mkdirSync(path.join(legacy, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'plugins', 'manifest.json'), 'plugin');
    fs.writeFileSync(path.join(legacy, 'plugins.json'), 'legacy config');
    fs.writeFileSync(path.join(legacy, 'other.txt'), 'retain');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'plugins.json'), 'current config');

    migrateLegacyPlugins(homeDirectory, emptyEnvironment);
    migrateLegacyPlugins(homeDirectory, emptyEnvironment);

    assert.equal(fs.readFileSync(path.join(target, 'plugins', 'manifest.json'), 'utf8'), 'plugin');
    assert.equal(fs.readFileSync(path.join(target, 'plugins.json'), 'utf8'), 'current config');
    assert.equal(fs.readFileSync(path.join(legacy, 'plugins.json'), 'utf8'), 'legacy config');
    assert.equal(fs.readFileSync(path.join(legacy, 'other.txt'), 'utf8'), 'retain');
    assert.equal(fs.existsSync(path.join(legacy, 'plugins')), false);
  });
});
