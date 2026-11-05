#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

try {
  const [bump, ...extra] = process.argv.slice(2);
  if (extra.length || !bump || !/^(?:patch|minor|major|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.test(bump)) {
    throw new Error('Usage: npm run release -- <patch|minor|major|x.y.z>');
  }
  if (git('branch', '--show-current') !== 'main') {
    throw new Error('Releases must be cut from main.');
  }
  if (git('status', '--porcelain').length) {
    throw new Error('Working tree must be clean before cutting a release.');
  }

  run('npm', ['version', bump, '--no-git-tag-version']);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const tag = `v${version}`;
  run('git', ['add', '--', 'package.json', 'package-lock.json']);
  run('git', ['commit', '-m', `chore(release): ${tag}`]);
  run('git', ['tag', '-a', tag, '-m', `Bowcode ${tag}`]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);
  console.log(`Release workflow: https://github.com/vantran-se/bowcode/actions/workflows/release.yml`);
  console.log(`Tag: ${tag}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
