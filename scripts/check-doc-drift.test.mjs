import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'check-doc-drift.mjs');

/** Keys of every seeded agent, which the two roster docs must name. */
const agentKeys = [
  ...readFileSync(join(REPO, 'packages/shared/src/lib/syncBuiltins.ts'), 'utf8').matchAll(
    /^\s+key: '([a-zA-Z]+)',$/gm
  ),
].map((m) => m[1]);
const roster = (keys) => keys.map((k) => `- \`${k}\``).join('\n');

/** Docs the check exempts from needing a Limitations section; the fixture must carry them. */
const EXEMPT_DOCS = [
  'concepts',
  'deployment',
  'quickstart',
  'github-app-setup',
  'oauth-setup',
  'slack-app-setup',
].map((d) => `docs/${d}.md`);

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { force: true, recursive: true });
  }
});

/**
 * A fixture repository: the real sources and manifests (symlinked, never edited) and living
 * docs written fresh. `overrides` replaces or adds a file by root-relative path.
 */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doc-drift-'));
  roots.push(root);
  // `packages/cli/README.md` is a living doc the check reads, so `cli` is a real directory with a
  // stub README; every other package is the real tree.
  mkdirSync(join(root, 'packages/cli'), { recursive: true });
  symlinkSync(join(REPO, 'packages/cli/package.json'), join(root, 'packages/cli/package.json'));
  for (const pkg of readdirSync(join(REPO, 'packages')).filter((d) => d !== 'cli')) {
    symlinkSync(join(REPO, 'packages', pkg), join(root, 'packages', pkg));
  }
  for (const shared of [
    'site',
    'package.json',
    '.node-version',
    'docker-compose.infra.yml',
    'docker-compose.app.yml',
  ]) {
    symlinkSync(join(REPO, shared), join(root, shared));
  }
  const files = {
    'AGENTS.md': `# Agents\n\n${roster(agentKeys)}\n`,
    'CONTRIBUTING.md': '# Contributing\n',
    'docs/README.md': '# Index\n',
    'packages/cli/README.md': '# CLI\n',
    'README.md': '# Readme\n',
    ...Object.fromEntries(EXEMPT_DOCS.map((d) => [d, '# Runbook\n'])),
    'docs/agents.md': `# Agents\n\n${roster(agentKeys)}\n\n## Limitations\n\nNone.\n`,
    'docs/feature.md': '# Feature\n\nIt works.\n\n## Limitations\n\nNone.\n',
    ...overrides,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

/**
 * Replace one file inside the symlinked package tree of a fixture without touching the real
 * file: every symlinked directory on the way is turned into a real directory of links first.
 */
function shadow(root, relPath, body) {
  let current = root;
  for (const part of relPath.split('/').slice(0, -1)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      const target = realpathSync(current);
      rmSync(current, { force: true });
      mkdirSync(current);
      for (const entry of readdirSync(target)) {
        symlinkSync(join(target, entry), join(current, entry));
      }
    }
  }
  const file = join(root, relPath);
  rmSync(file, { force: true });
  writeFileSync(file, body);
}

function run(root) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, DOC_DRIFT_ROOT: root },
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

function check(overrides) {
  return run(fixture(overrides));
}

describe('check-doc-drift', () => {
  it('passes a clean fixture', () => {
    const r = check();
    expect(r.out).toContain('Doc drift check passed');
    expect(r.status).toBe(0);
  });

  it('does not check counts of schema, registry or roster contents', () => {
    const r = check({
      'README.md': [
        '# Readme',
        '',
        'There are 999 Prisma models and 999 tables, 1 node types, 7 built-in skills,',
        '3 built-in scanner patterns (total 5, 1 INJECTION, 2 EXFILTRATION, 3 SHELL_COMMAND,',
        '4 CODE_SECURITY, 5 SENSITIVE_FILE, 6 PII), 2 seeded built-in agents,',
        '3 model-backed and 4 sub-role agents, `MODEL_BACKED_AGENT_KEYS` (2),',
        'and 9 configurable workspace tools.',
        '',
      ].join('\n'),
    });
    expect(r.out).toContain('Doc drift check passed');
    expect(r.status).toBe(0);
  });

  it('fails a wrong dependency version', () => {
    const r = check({ 'README.md': '# Readme\n\nThe gateway runs on Fastify 1.0.0.\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Stale versions');
    expect(r.out).toContain('Fastify');
  });

  it('fails forbidden status prose', () => {
    const r = check({ 'README.md': '# Readme\n\nThis feature is now shipped.\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Forbidden status prose');
  });

  it('fails a capability doc with no Limitations section', () => {
    const r = check({ 'docs/feature.md': '# Feature\n\nIt works.\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Missing gap sections');
    expect(r.out).toContain('docs/feature.md');
  });

  it('fails a setting key the registry does not define', () => {
    const r = check({ 'README.md': '# Readme\n\nTune `workspace.noSuchKnobAtAll` here.\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Unknown setting keys');
  });

  it('fails a broken relative .md link', () => {
    const r = check({ 'README.md': '# Readme\n\nSee [the guide](./docs/missing.md).\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Broken links');
  });

  it('fails a link to a heading that does not exist', () => {
    const r = check({ 'README.md': '# Readme\n\nSee [it](./docs/feature.md#no-such-heading).\n' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('no such heading');
  });

  it('fails a roster that omits a seeded agent', () => {
    const omitted = agentKeys[0];
    const r = check({
      'docs/agents.md': `# Agents\n\n${roster(agentKeys.slice(1))}\n\n## Limitations\n\nNone.\n`,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Incomplete agent roster');
    expect(r.out).toContain(omitted);
  });

  it('fails loudly when it finds no seeded agent keys, instead of checking a roster of nothing', () => {
    const root = fixture();
    // The shape of the `key:` lines changed: nothing matches, so a roster check would pass.
    shadow(root, 'packages/shared/src/lib/syncBuiltins.ts', 'export const agents = [];\n');
    const r = run(root);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('found no seeded agent keys');
  });
});
