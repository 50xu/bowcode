import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex',
  '@openai/codex-sdk',
  '@opencode/client',
];

// Accept a concrete version or the lower bound of a root dependency range.
function parseVersion(value) {
  const match = value.trim().match(/^[~^>=v\s]*(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/);
  if (!match) throw new Error(`Unsupported version: ${value}`);
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') };
}

/** Compare semantic versions, including prerelease precedence; ignore build metadata. */
export function compareSemver(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** Extract only model value fields inside CODEX_PREDEFINED_MODELS.OPTIONS. */
export function extractCodexSlugs(source) {
  const start = source.match(/\bCODEX_PREDEFINED_MODELS\b[^=]*=\s*\{\s*OPTIONS\s*:\s*\[/);
  if (!start) throw new Error('CODEX_PREDEFINED_MODELS.OPTIONS not found');
  const body = source.slice(start.index + start[0].length);
  let depth = 1;
  let quote = null;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error('Unterminated Codex OPTIONS array');
  return [...new Set([...body.slice(0, end).matchAll(/\bvalue\s*:\s*'([^']+)'\s*,\s*label\s*:/g)]
    .map((match) => match[1]))];
}

/** Diff upstream list-visible slugs against the curated Bowcode model slugs. */
export function diffCatalog(upstream, local) {
  const upstreamSet = new Set(upstream);
  const localSet = new Set(local);
  return {
    added: [...upstreamSet].filter((slug) => !localSet.has(slug)),
    removed: [...localSet].filter((slug) => !upstreamSet.has(slug)),
  };
}

const markdownText = (value) => String(value).replace(/[\r\n|]/g, ' ');

/** Render the dependency report used on stdout and in the scheduled GitHub issue. */
export function renderMarkdown({ outdated, codexCatalog }) {
  const lines = ['# Core dependency updates', ''];
  if (outdated.length) {
    lines.push('| Package | Installed | Latest | npm |', '| --- | --- | --- | --- |');
    for (const { name, installed, latest } of outdated) {
      lines.push(`| ${markdownText(name)} | ${markdownText(installed)} | ${markdownText(latest)} | [npm](https://www.npmjs.com/package/${encodeURIComponent(name)}) |`);
    }
  } else lines.push('All core packages are up to date.');
  lines.push('', '## Codex model-catalog drift', '');
  if (codexCatalog.skipped) lines.push(`Catalog check skipped: ${markdownText(codexCatalog.skipped)}`);
  else if (!codexCatalog.added.length && !codexCatalog.removed.length) lines.push('No catalog drift.');
  else {
    lines.push(`Added upstream: ${codexCatalog.added.map(markdownText).join(', ') || 'None'}`);
    lines.push(`Dropped upstream (still listed by Bowcode): ${codexCatalog.removed.map(markdownText).join(', ') || 'None'}`);
  }
  return `${lines.join('\n')}\n`;
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function main() {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const outdated = [];
  const latestVersions = new Map();
  for (const name of CORE_PACKAGES) {
    let installed;
    try {
      installed = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      installed = rootPackage.dependencies[name];
    }
    const latest = run('npm', ['view', name, 'version']);
    // Validate registry output before passing it as an npx package specifier.
    parseVersion(latest);
    latestVersions.set(name, latest);
    if (compareSemver(latest, installed) > 0) outdated.push({ name, installed, latest });
  }
  const local = extractCodexSlugs(readFileSync(join(ROOT, 'server/modules/providers/list/codex/codex-models.provider.ts'), 'utf8'));
  let codexCatalog;
  try {
    const catalog = JSON.parse(run('npx', ['-y', `@openai/codex@${latestVersions.get('@openai/codex')}`, 'debug', 'models', '--bundled']));
    const slugs = catalog.models.filter((model) => model.visibility === 'list').map((model) => model.slug);
    codexCatalog = diffCatalog(slugs, local);
  } catch (error) {
    codexCatalog = { added: [], removed: [], skipped: error.message };
  }
  const hasUpdates = outdated.length > 0 || codexCatalog.added.length > 0 || codexCatalog.removed.length > 0;
  const report = { outdated, codexCatalog, hasUpdates };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `has_updates=${hasUpdates}\n`);
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
