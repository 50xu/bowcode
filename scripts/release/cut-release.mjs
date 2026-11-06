#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

/**
 * The next beta version. Betas live on their own release branches while main
 * keeps the last stable version, so the beta number comes from existing tags:
 * a stable X.Y.Z targets X.Y.(Z+1), a prerelease keeps its X.Y.Z core.
 */
function nextBetaVersion(current, tags) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(current);
  if (!match) throw new Error(`Cannot derive a beta from version ${current}`);
  const [, major, minor, patch] = match;
  const core = current.includes('-') ? `${major}.${minor}.${patch}` : `${major}.${minor}.${Number(patch) + 1}`;
  const taken = tags
    .map((tag) => new RegExp(`^v${core.replaceAll('.', '\\.')}-beta\\.(\\d+)$`).exec(tag))
    .filter(Boolean)
    .map((found) => Number(found[1]));
  return `${core}-beta.${taken.length ? Math.max(...taken) + 1 : 0}`;
}

try {
  const [bump, ...extra] = process.argv.slice(2);
  if (extra.length || !bump || !/^(?:patch|minor|major|beta|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.test(bump)) {
    throw new Error('Usage: npm run release -- <patch|minor|major|x.y.z|beta>');
  }
  const branch = git('branch', '--show-current');
  let betaVersion = null;
  if (bump === 'beta') {
    // Every beta is cut from its own branch named after the version it ships.
    run('git', ['fetch', '--tags', '--quiet', 'origin']);
    betaVersion = nextBetaVersion(JSON.parse(readFileSync('package.json', 'utf8')).version, git('tag', '--list', 'v*').split('\n'));
    const expected = `release/v${betaVersion}`;
    if (branch !== expected) {
      throw new Error(`Betas are cut from their own release branch. Create it from main first:\n  git switch -c ${expected} main`);
    }
  } else if (branch !== 'main') {
    throw new Error('Releases must be cut from main.');
  }
  if (git('status', '--porcelain').length) {
    throw new Error('Working tree must be clean before cutting a release.');
  }

  run('npm', ['version', betaVersion ?? bump, '--no-git-tag-version']);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const tag = `v${version}`;
  if (bump === 'beta' && branch !== `release/${tag}`) {
    throw new Error(`npm produced ${version}, which does not match branch ${branch}.`);
  }
  run('git', ['add', '--', 'package.json', 'package-lock.json']);
  run('git', ['commit', '-m', `chore(release): ${tag}`]);
  run('git', ['tag', '-a', tag, '-m', `Bowcode ${tag}`]);
  run('git', bump === 'beta' ? ['push', '-u', 'origin', branch] : ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);
  console.log(`Release workflow: https://github.com/50xu/bowcode/actions/workflows/release.yml`);
  console.log(`Tag: ${tag}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
