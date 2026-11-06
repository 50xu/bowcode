import assert from 'node:assert/strict';
import test from 'node:test';

import { isNewerVersion, selectLatestRelease } from '../utils.js';

test('SemVer precedence orders stable, prerelease and numeric identifiers', () => {
  assert.equal(isNewerVersion('1.40.0', '1.40.0-beta.3'), true);
  assert.equal(isNewerVersion('1.40.0-beta.3', '1.40.0-beta.2'), true);
  assert.equal(isNewerVersion('1.40.0-beta.2', '1.39.5'), true);
  assert.equal(isNewerVersion('1.40.0-beta.10', '1.40.0-beta.2'), true);
  assert.equal(isNewerVersion('1.40.0-beta.2', '1.40.0-beta.10'), false);
  assert.equal(isNewerVersion('1.40.0-alpha', '1.40.0-alpha.1'), false);
  assert.equal(isNewerVersion('1.40.0-beta', '1.40.0-2'), true);
  assert.equal(isNewerVersion('v1.40.0+build.2', '1.40.0+build.1'), false);
  assert.equal(isNewerVersion('invalid', '1.0.0'), false);
});

test('release selection ignores drafts and invalid tags regardless of API order', () => {
  const releases = [
    { tag_name: 'v1.40.0-beta.2' }, { tag_name: 'v1.40.0-beta.10' },
    { tag_name: 'v1.99.0', draft: true }, { tag_name: 'bad' }, { tag_name: 'v1.39.5' },
  ];
  assert.equal(selectLatestRelease(releases)?.tag_name, 'v1.40.0-beta.10');
  assert.equal(selectLatestRelease([{ tag_name: 'bad' }]), null);
});
