import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CampaignCheckResult,
  parseCheckResult,
  recipeSupportsCheck,
} from '@auto-swe/shared/lib/campaignRecipes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRecipeCheckCommand,
  buildRecipeCommand,
  interpretRecipeCheck,
  RECIPE_EXIT_UNSUPPORTED,
} from './campaignRecipes.js';

// The `check` and `apply` scripts of each `@2` recipe run over the SAME fixture repositories, with
// `sh`, `node` and `awk` real and `npm` and `go` stubbed (no network). The agreement the campaign
// spec requires (§5): a repository `apply` would change is exactly one `check` calls not satisfied.

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recipe-check-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  // Both tools record that they ran, and do what the real ones would do to the files.
  stub(
    'npm',
    `echo npm >> "${dir}/calls"
for a in "$@"; do last="$a"; done
node -e '
const fs = require("node:fs");
const ver = process.argv[1], n = process.env.PKG;
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
l.packages = l.packages || {};
l.packages["node_modules/" + n] = { version: ver };
fs.writeFileSync("package-lock.json", JSON.stringify(l));
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (p[k] && Object.hasOwn(p[k], n)) p[k][n] = p[k][n].replace(/^([\\^~]?).*$/, "$1" + ver);
}
fs.writeFileSync("package.json", JSON.stringify(p));
' "\${last##*@}"`
  );
  stub(
    'go',
    `echo go >> "${dir}/calls"
if [ "$1" = get ]; then
  spec="$3"; ver="\${spec##*@}"; mod="\${spec%@*}"
  awk -v m="$mod" -v v="$ver" '{ for (i = 1; i < NF; i++) if ($i == m && $(i + 1) ~ /^v/) $(i + 1) = v; print }' go.mod > go.mod.new && mv go.mod.new go.mod
fi`
  );
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function sh(cmd: string, cwd: string) {
  const r = spawnSync('sh', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: dir },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function snapshot(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      Object.assign(out, snapshot(root, p));
    } else {
      out[p] = readFileSync(join(root, p), 'utf8');
    }
  }
  return out;
}

type Files = Record<string, string>;
interface Fixture {
  name: string;
  params: { packageName: string; targetVersion: string };
  files: Files;
  /** The check's exit code. */
  exit: 0 | 1 | 3;
  evidence: string;
  detail?: string;
}

const make = (files: Files): string => {
  const root = mkdtempSync(join(dir, 'repo-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
};

// ── npm ──────────────────────────────────────────────────────────────────────────────────────────

const NPM = { packageName: 'lodash', targetVersion: '4.17.21' };

function npmFiles(
  spec: string | null,
  locked: string | null,
  extra: { section?: string; pkg?: object; lock?: Files } = {}
): Files {
  const section = extra.section ?? 'dependencies';
  return {
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: locked === null ? {} : { 'node_modules/lodash': { version: locked } },
    }),
    'package.json': JSON.stringify({
      name: 'x',
      version: '1.0.0',
      ...(spec === null ? {} : { [section]: { lodash: spec } }),
      ...extra.pkg,
    }),
    ...extra.lock,
  };
}

const NPM_FIXTURES: Fixture[] = [
  {
    evidence: 'not-declared',
    exit: 0,
    files: { 'README.md': 'x' },
    name: 'no package.json',
    params: NPM,
  },
  {
    detail: 'no-root-manifest',
    evidence: 'not-declared',
    exit: 0,
    files: { 'go.mod': 'module x\n' },
    name: 'no root manifest, a go.mod',
    params: NPM,
  },
  {
    detail: 'not-a-dependency',
    evidence: 'not-declared',
    exit: 0,
    files: npmFiles(null, null, { pkg: { dependencies: { other: '^1.0.0' } } }),
    name: 'not a dependency',
    params: NPM,
  },
  {
    detail: 'not-a-dependency',
    evidence: 'not-declared',
    exit: 0,
    files: npmFiles(null, null, { pkg: { peerDependencies: { lodash: '^4.0.0' } } }),
    name: 'peer dependency only',
    params: NPM,
  },
  {
    detail: 'not-a-dependency',
    evidence: 'not-declared',
    exit: 0,
    files: npmFiles(null, null, {
      lock: { 'yarn.lock': '' },
      pkg: { dependencies: { other: '1.0.0' } },
    }),
    name: 'not declared, yarn repository (not affected, as @1)',
    params: NPM,
  },
  {
    detail: 'workspaces',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles(null, null, { pkg: { workspaces: ['packages/*'] } }),
    name: 'workspaces repository without the package at its root',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('^4.17.21', '4.17.21'),
    name: 'declared and locked at the target',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('4.17.21', '4.17.21', { section: 'devDependencies' }),
    name: 'exact pin at the target in devDependencies',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('^5.0.0', '5.0.1'),
    name: 'above the target (a higher major)',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('~4.100.0', '4.100.3'),
    name: 'minor 100 is above minor 17 (numeric, not text, order)',
    params: NPM,
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4.17.20', '4.17.20'),
    name: 'declared and locked below the target',
    params: NPM,
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4.9.0', '4.9.0'),
    name: 'minor 9 is below minor 17 (numeric, not text, order)',
    params: NPM,
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4.17', '4.17.21'),
    name: 'a partial range floors at 4.17.0',
    params: NPM,
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4', '4.17.21'),
    name: 'a major-only range floors at 4.0.0',
    params: NPM,
  },
  {
    detail: 'locked-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4.17.21', '4.17.20'),
    name: 'declared at the target, lock behind',
    params: NPM,
  },
  {
    detail: 'not-locked',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('^4.17.21', null),
    name: 'declared at the target, lock has no entry',
    params: NPM,
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('4.17.21-rc.1', '4.17.21-rc.1'),
    name: 'a pre-release of the target is below the target',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('^4.18.0-beta.1', '4.18.0-beta.1'),
    name: 'a pre-release of a higher version is above the target',
    params: NPM,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('1.0.0-rc.10', '1.0.0-rc.10'),
    name: 'rc.10 is at or above rc.2 (numeric identifiers)',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('1.0.0-rc.1', '1.0.0-rc.1'),
    name: 'rc.1 is below rc.2',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('1.0.0-alpha', '1.0.0-alpha'),
    name: 'alpha is below rc.2 (alphanumeric order)',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'declared-below',
    evidence: 'below-target',
    exit: 1,
    files: npmFiles('1.0.0-rc', '1.0.0-rc'),
    name: 'rc is below rc.2 (a shorter identifier list is lower)',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('1.0.0', '1.0.0'),
    name: 'a release is above its own pre-release',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: npmFiles('1.0.0-rc.2', '1.0.0-rc.2'),
    name: 'a pre-release target met exactly, with build metadata ignored',
    params: { packageName: 'lodash', targetVersion: '1.0.0-rc.2' },
  },
  {
    detail: 'unsupported-spec',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles('github:evil/repo', '1.0.0'),
    name: 'a git specifier',
    params: NPM,
  },
  {
    detail: 'unsupported-spec',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles('>=4.17.21', '4.17.21'),
    name: 'a comparator range',
    params: NPM,
  },
  {
    detail: 'unsupported-lockfile',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles('^4.17.21', '4.17.21', { lock: { 'yarn.lock': '' } }),
    name: 'yarn.lock, never satisfied',
    params: NPM,
  },
  {
    detail: 'unsupported-lockfile',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles('^4.17.20', '4.17.20', { lock: { 'pnpm-lock.yaml': '' } }),
    name: 'pnpm-lock.yaml',
    params: NPM,
  },
  {
    detail: 'unsupported-lockfile',
    evidence: 'cannot-check',
    exit: 3,
    files: npmFiles('^4.17.20', '4.17.20', { lock: { 'bun.lock': '' } }),
    name: 'bun.lock',
    params: NPM,
  },
  {
    detail: 'no-package-lock',
    evidence: 'cannot-check',
    exit: 3,
    files: { 'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.20' } }) },
    name: 'no package-lock.json',
    params: NPM,
  },
  {
    detail: 'unreadable-manifest',
    evidence: 'cannot-check',
    exit: 3,
    files: { 'package.json': '{not json' },
    name: 'a package.json that is not JSON',
    params: NPM,
  },
];

// ── Go ───────────────────────────────────────────────────────────────────────────────────────────

const MOD = 'github.com/stretchr/testify';
const GO = { packageName: MOD, targetVersion: 'v1.9.0' };
const goMod = (v: string) => `module x\n\ngo 1.22\n\nrequire ${MOD} ${v}\n`;
const goBlock = (v: string) =>
  `module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\t${MOD} ${v} // indirect\n)\n`;

const GO_FIXTURES: Fixture[] = [
  {
    detail: 'no-root-manifest',
    evidence: 'not-declared',
    exit: 0,
    files: { 'README.md': 'x' },
    name: 'no go.mod',
    params: GO,
  },
  {
    detail: 'not-required',
    evidence: 'not-declared',
    exit: 0,
    files: { 'go.mod': 'module x\n\ngo 1.22\n\nrequire github.com/a/b v1.0.0\n' },
    name: 'module not required',
    params: GO,
  },
  {
    detail: 'not-required',
    evidence: 'not-declared',
    exit: 0,
    files: {
      'go.mod': `module x\n\ngo 1.22\n\nreplace ${MOD} v1.0.0 => ./fork\nexclude ${MOD} v1.2.0\n`,
    },
    name: 'only a replace and an exclude',
    params: GO,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goMod('v1.9.0') },
    name: 'at the target',
    params: GO,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goBlock('v1.10.0') },
    name: 'v1.10.0 is above v1.9.0 (numeric order), in a require block',
    params: GO,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goMod('v2.0.0'), 'vendor/modules.txt': '# x\n' },
    name: 'above the target in a vendored module (nothing to change)',
    params: GO,
  },
  {
    detail: 'below-target',
    evidence: 'below-target',
    exit: 1,
    files: { 'go.mod': goMod('v1.8.0') },
    name: 'below the target, single-line require',
    params: GO,
  },
  {
    detail: 'below-target',
    evidence: 'below-target',
    exit: 1,
    files: { 'go.mod': goBlock('v1.8.1') },
    name: 'below the target, require block with an indirect comment',
    params: GO,
  },
  {
    detail: 'below-target',
    evidence: 'below-target',
    exit: 1,
    files: { 'go.mod': goMod('v1.9.0-rc.1') },
    name: 'a pre-release of the target is below it',
    params: GO,
  },
  {
    detail: 'below-target',
    evidence: 'below-target',
    exit: 1,
    files: { 'go.mod': goMod('v1.8.9-0.20240101000000-abcdef123456') },
    name: 'a pseudo-version before the target',
    params: GO,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goMod('v1.9.1-0.20240101000000-abcdef123456') },
    name: 'a pseudo-version after the target',
    params: GO,
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': 'module x\n\nrequire example.com/x v2.0.0+incompatible\n' },
    name: '+incompatible build metadata is ignored',
    params: { packageName: 'example.com/x', targetVersion: 'v2.0.0' },
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goMod('v1.0.0-rc.10') },
    name: 'a pre-release target: rc.10 is above rc.2',
    params: { packageName: MOD, targetVersion: 'v1.0.0-rc.2' },
  },
  {
    detail: 'below-target',
    evidence: 'below-target',
    exit: 1,
    files: { 'go.mod': goMod('v1.0.0-alpha') },
    name: 'a pre-release target: alpha is below rc.2',
    params: { packageName: MOD, targetVersion: 'v1.0.0-rc.2' },
  },
  {
    detail: 'at-or-above',
    evidence: 'declared-at-target',
    exit: 0,
    files: { 'go.mod': goMod('v1.0.0') },
    name: 'a pre-release target: the release is above it',
    params: { packageName: MOD, targetVersion: 'v1.0.0-rc.2' },
  },
  {
    detail: 'vendored',
    evidence: 'cannot-check',
    exit: 3,
    files: { 'go.mod': goMod('v1.8.0'), 'vendor/modules.txt': '# x\n' },
    name: 'below the target in a vendored module',
    params: GO,
  },
  {
    detail: 'go-work',
    evidence: 'cannot-check',
    exit: 3,
    files: { 'go.mod': goMod('v1.8.0'), 'go.work': 'go 1.22\n' },
    name: 'below the target inside a go.work workspace',
    params: GO,
  },
];

// ── The agreement ────────────────────────────────────────────────────────────────────────────────

const CASES = [
  { fixtures: NPM_FIXTURES, ref: 'npm-dependency@2' },
  { fixtures: GO_FIXTURES, ref: 'go-module@2' },
] as const;

describe.each(CASES)('$ref: check and apply over the same repositories', ({ ref, fixtures }) => {
  it.each(fixtures)('$name', (fx) => {
    const checkCmd = buildRecipeCheckCommand(ref, fx.params);
    const applyCmd = buildRecipeCommand(ref, fx.params);

    // check: the verdict, the evidence, and not one byte or tool call of side effect.
    const forCheck = make(fx.files);
    const before = snapshot(forCheck);
    const c = sh(checkCmd, forCheck);
    expect(c.status, c.stderr).toBe(fx.exit);
    expect(snapshot(forCheck)).toEqual(before);
    expect(existsSync(join(dir, 'calls'))).toBe(false);
    const parsed = interpretRecipeCheck({ exitCode: c.status, stdout: c.stdout });
    expect(parsed.evidence?.kind).toBe(fx.evidence);
    if (fx.detail) {
      expect(parsed.evidence?.detail).toBe(fx.detail);
    }
    expect(parsed.status).toBe(
      fx.exit === 0 ? 'satisfied' : fx.exit === 1 ? 'not-satisfied' : 'could-not-run'
    );

    // apply, on an identical repository: it changes the repository exactly when check said not satisfied.
    const forApply = make(fx.files);
    const a = sh(applyCmd, forApply);
    const changed = JSON.stringify(snapshot(forApply)) !== JSON.stringify(before);
    if (fx.exit === 0) {
      expect(a.status, a.stderr).toBe(0);
      expect(changed).toBe(false);
      expect(existsSync(join(dir, 'calls'))).toBe(false);
    } else if (fx.exit === 1) {
      expect(a.status, a.stderr).toBe(0);
      expect(changed).toBe(true);
      // ...and what it wrote satisfies the check.
      const again = interpretRecipeCheck({
        exitCode: sh(checkCmd, forApply).status,
        stdout: sh(checkCmd, forApply).stdout,
      });
      expect(again.status).toBe('satisfied');
      expect(again.evidence?.kind).toBe('declared-at-target');
    } else {
      expect(a.status).toBe(RECIPE_EXIT_UNSUPPORTED);
      expect(changed).toBe(false);
      expect(existsSync(join(dir, 'calls'))).toBe(false);
    }
  });

  it('prints the evidence line last, and apply and check share the decision text', () => {
    const fx = fixtures.find((f) => f.exit === 1) as Fixture;
    const c = sh(buildRecipeCheckCommand(ref, fx.params), make(fx.files));
    const lines = c.stdout.trimEnd().split('\n');
    expect(lines.at(-1)).toMatch(
      /^CAMPAIGN_CHECK evidence=below-target detail=\S+ declared=\S+ resolved=\S+$/
    );

    const checkLines = buildRecipeCheckCommand(ref, fx.params).split('\n');
    const applyText = buildRecipeCommand(ref, fx.params);
    const start = checkLines.findIndex((l) => l.startsWith('export '));
    const end = checkLines.findIndex((l) => l === 'case "$VERDICT" in');
    const decision = checkLines.slice(start + 1, end).join('\n');
    expect(decision.length).toBeGreaterThan(200);
    expect(applyText).toContain(decision);
  });
});

describe('check scripts: text', () => {
  it('writes each parameter only in the header and the quoted export line', () => {
    const npm = buildRecipeCheckCommand('npm-dependency@2', {
      packageName: 'a.b_c~d',
      targetVersion: '10.20.30-beta.2',
    });
    const go = buildRecipeCheckCommand('go-module@2', {
      packageName: 'gopkg.in/yaml.v3',
      targetVersion: 'v3.0.1',
    });
    for (const [text, name] of [
      [npm, 'a.b_c~d'],
      [go, 'gopkg.in/yaml.v3'],
    ] as const) {
      const lines = text.split('\n').filter((l) => l.includes(name));
      expect(lines).toHaveLength(2);
      expect(lines[0]?.startsWith('# campaign recipe check ')).toBe(true);
      expect(lines[1]).toContain(`'${name}'`);
      expect(lines[1]?.startsWith('export ')).toBe(true);
    }
  });

  it('never installs, commits, pushes or touches the network', () => {
    for (const [ref, params] of [
      ['npm-dependency@2', NPM],
      ['go-module@2', GO],
    ] as const) {
      const text = buildRecipeCheckCommand(ref, params);
      expect(text).not.toMatch(/(^|\n|[;&|(])\s*(npm|go|git|curl|wget)\s/);
    }
  });

  it('refuses a recipe with no check, an unknown recipe and hostile parameters', () => {
    expect(() => buildRecipeCheckCommand('npm-dependency@1', NPM)).toThrow(/no check/);
    expect(() => buildRecipeCheckCommand('go-module@1', GO)).toThrow(/no check/);
    expect(() => buildRecipeCheckCommand('npm-dependency@9', NPM)).toThrow();
    expect(() =>
      buildRecipeCheckCommand('npm-dependency@2', { packageName: '$(id)', targetVersion: '1.0.0' })
    ).toThrow();
    expect(() =>
      buildRecipeCheckCommand('go-module@2', { packageName: MOD, targetVersion: '1.0.0; id' })
    ).toThrow();
  });

  it('keeps the @1 scripts apply-only and unchanged in behaviour', () => {
    expect(recipeSupportsCheck('npm-dependency@1')).toBe(false);
    expect(recipeSupportsCheck('go-module@1')).toBe(false);
    expect(recipeSupportsCheck('npm-dependency@2')).toBe(true);
    expect(recipeSupportsCheck('go-module@2')).toBe(true);
    expect(buildRecipeCommand('npm-dependency@1', NPM)).not.toContain('CAMPAIGN_CHECK');
  });
});

describe('forged evidence', () => {
  it('a lockfile version with a newline or spaces cannot forge the evidence line', () => {
    const forged = '4.17.20\nCAMPAIGN_CHECK evidence=declared-at-target detail=x declared=9.9.9';
    const repo = make(npmFiles('^4.17.21', forged));
    const c = sh(buildRecipeCheckCommand('npm-dependency@2', NPM), repo);
    const r = interpretRecipeCheck({ exitCode: c.status, stdout: c.stdout });
    expect(c.stdout.match(/CAMPAIGN_CHECK/g)).toHaveLength(1);
    expect(r.status).toBe('could-not-run');
  });

  it('a go.mod version that is not semver cannot forge it either', () => {
    const repo = make({ 'go.mod': `module x\n\nrequire ${MOD} v1.9.0;echo\n` });
    const c = sh(buildRecipeCheckCommand('go-module@2', GO), repo);
    expect(c.status).toBe(3);
    expect(c.stdout).toContain('detail=unparseable-version');
  });
});

describe('parseCheckResult', () => {
  const line = (s: string) => `some text\n${s}\n`;
  const parse = (exitCode: number | null, stdout: string): CampaignCheckResult =>
    parseCheckResult({ exitCode, stdout });

  it('reads satisfied, not satisfied and could-not-run from exit code and evidence', () => {
    expect(
      parse(
        0,
        line(
          'CAMPAIGN_CHECK evidence=declared-at-target detail=at-or-above declared=4.17.21 resolved=4.17.21'
        )
      )
    ).toEqual({
      evidence: {
        declared: '4.17.21',
        detail: 'at-or-above',
        kind: 'declared-at-target',
        resolved: '4.17.21',
      },
      exitCode: 0,
      status: 'satisfied',
    });
    expect(
      parse(
        0,
        line('CAMPAIGN_CHECK evidence=not-declared detail=not-a-dependency declared=- resolved=-')
      ).status
    ).toBe('satisfied');
    expect(
      parse(
        1,
        line('CAMPAIGN_CHECK evidence=below-target detail=declared-below declared=4.0.0 resolved=-')
      ).status
    ).toBe('not-satisfied');
    const cant = parse(
      3,
      line('CAMPAIGN_CHECK evidence=cannot-check detail=workspaces declared=- resolved=-')
    );
    expect(cant).toMatchObject({ exitCode: 3, status: 'could-not-run' });
    expect(cant.status === 'could-not-run' && cant.reason).toBe(
      'the check could not run (exit 3): workspaces'
    );
  });

  it('never reads a verdict without matching evidence, or from a killed script', () => {
    expect(parse(0, '').status).toBe('could-not-run');
    expect(parse(1, '').status).toBe('could-not-run');
    expect(parse(0, line('CAMPAIGN_CHECK evidence=below-target detail=x')).status).toBe(
      'could-not-run'
    );
    expect(parse(1, line('CAMPAIGN_CHECK evidence=not-declared detail=x')).status).toBe(
      'could-not-run'
    );
    expect(parse(null, line('CAMPAIGN_CHECK evidence=not-declared detail=x')).status).toBe(
      'could-not-run'
    );
    expect(parse(127, '').status).toBe('could-not-run');
    expect(parse(0, line('CAMPAIGN_CHECK evidence=bogus detail=x')).status).toBe('could-not-run');
  });

  it('takes the last evidence line and drops values that are not plain tokens', () => {
    const r = parse(
      0,
      'CAMPAIGN_CHECK evidence=below-target detail=a\nCAMPAIGN_CHECK evidence=not-declared detail=a<b declared=$(x) resolved=1.0.0\n'
    );
    expect(r).toMatchObject({
      evidence: { declared: null, detail: null, kind: 'not-declared', resolved: '1.0.0' },
      status: 'satisfied',
    });
  });
});
