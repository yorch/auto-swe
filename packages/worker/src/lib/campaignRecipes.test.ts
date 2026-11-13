import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRecipeCommand,
  RECIPE_EXIT_NOT_RESOLVED,
  RECIPE_EXIT_UNSUPPORTED,
  recipeRuntime,
} from './campaignRecipes.js';

const HOSTILE = [
  '$(touch pwned)',
  '`touch pwned`',
  'a;touch pwned',
  'a && touch pwned',
  'a|touch pwned',
  "a'; touch pwned; '",
  'a"; touch pwned; "',
  'a\ntouch pwned',
  'a\r\ntouch pwned',
  '-rf',
  '--registry=https://evil.example',
  ['$', '{IFS}'].join(''),
  'ünï/cödé',
  'github:evil/repo',
  'a b',
  '',
];

describe('buildRecipeCommand: refusal', () => {
  it.each(HOSTILE)('throws, building nothing, for a hostile package %j', (name) => {
    expect(() =>
      buildRecipeCommand('npm-dependency@1', { packageName: name, targetVersion: '1.0.0' })
    ).toThrow();
    expect(() =>
      buildRecipeCommand('go-module@1', { packageName: name, targetVersion: 'v1.0.0' })
    ).toThrow();
  });

  it.each(HOSTILE)('throws for a hostile version %j', (version) => {
    expect(() =>
      buildRecipeCommand('npm-dependency@1', { packageName: 'lodash', targetVersion: version })
    ).toThrow();
    expect(() =>
      buildRecipeCommand('go-module@1', { packageName: 'github.com/a/b', targetVersion: version })
    ).toThrow();
  });

  it('throws for an unknown recipe and for missing or extra parameters', () => {
    expect(() =>
      buildRecipeCommand('curl-sh@1', { packageName: 'a', targetVersion: '1.0.0' })
    ).toThrow();
    expect(() => buildRecipeCommand('npm-dependency@1', {})).toThrow();
    expect(() =>
      buildRecipeCommand('npm-dependency@1', {
        extra: 1,
        packageName: 'lodash',
        targetVersion: '1.0.0',
      })
    ).toThrow();
  });
});

describe('buildRecipeCommand: text', () => {
  it('quotes every parameter and never splices one into a command word', () => {
    const cmd = buildRecipeCommand('npm-dependency@1', {
      packageName: '@scope/pkg',
      targetVersion: '1.2.3-rc.1',
    });
    expect(cmd).toContain("export PKG='@scope/pkg' VER='1.2.3-rc.1'");
    // The only places the parameter text appears: the quoted assignment and the comment header.
    const outside = cmd
      .split('\n')
      .filter((l) => !l.startsWith('#') && !l.startsWith('export PKG='))
      .join('\n');
    expect(outside).not.toContain('scope');
    expect(outside).not.toContain('1.2.3');
  });

  it('always passes --ignore-scripts, and in the environment too', () => {
    const cmd = buildRecipeCommand('npm-dependency@1', {
      packageName: 'lodash',
      targetVersion: '4.17.21',
    });
    expect(cmd).toContain('--ignore-scripts');
    expect(cmd).toContain('NPM_CONFIG_IGNORE_SCRIPTS=true');
    expect(cmd).toContain('--package-lock-only');
  });

  it('keeps the header comment on one line however long the parameters are', () => {
    const cmd = buildRecipeCommand('npm-dependency@1', {
      packageName: 'a'.repeat(200),
      targetVersion: '1.0.0',
    });
    const [first, second] = cmd.split('\n');
    expect(first?.startsWith('# campaign recipe npm-dependency@1')).toBe(true);
    expect(second).toBe('set -eu');
    expect((first ?? '').length).toBeGreaterThanOrEqual(80);
  });

  it('runs each recipe on the catalogue image', () => {
    expect(recipeRuntime('npm-dependency@1').image).toBe('node:24-alpine');
    expect(recipeRuntime('go-module@1').image).toBe('golang:1.26-alpine');
  });
});

// ── Executing the scripts with the toolchain stubbed ─────────────────────────────────────────────
// `sh` and `node` are real; `npm` and `go` are stand-ins that record their argument vector, which is
// what a hostile parameter would have to reach. The Docker-backed suite runs the real toolchains.

let dir: string;
let bin: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recipe-'));
  bin = join(dir, 'bin');
  repo = join(dir, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', ['-c', cmd], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: dir,
      ...env,
    },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

const file = (name: string, content: string) => writeFileSync(join(repo, name), content);
const read = (name: string) => readFileSync(join(repo, name), 'utf8');
const args = () =>
  existsSync(join(dir, 'args')) ? read2('args').split('\n').filter(Boolean) : null;
const read2 = (name: string) => readFileSync(join(dir, name), 'utf8');

const NPM_PARAMS = { packageName: 'lodash', targetVersion: '4.17.21' };

/** An `npm` that records its arguments and rewrites the lockfile to the version it was given. */
function installNpmStub(resolvedVersion?: string) {
  stub(
    'npm',
    `printf '%s\\n' "$@" > "${dir}/args"
for a in "$@"; do last="$a"; done
ver="\${last##*@}"
${resolvedVersion ? `ver='${resolvedVersion}'` : ''}
node -e '
const fs = require("node:fs");
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
l.packages["node_modules/" + process.env.PKG] = { version: process.argv[1] };
fs.writeFileSync("package-lock.json", JSON.stringify(l));
' "$ver"`
  );
}

function npmRepo(deps: Record<string, unknown>, locked = '4.17.20', extra: object = {}) {
  file('package.json', JSON.stringify({ name: 'x', version: '1.0.0', ...deps, ...extra }));
  file(
    'package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: locked } } })
  );
}

describe('npm-dependency@1 script', () => {
  const cmd = () => buildRecipeCommand('npm-dependency@1', NPM_PARAMS);

  it('is not affected, exit 0, when the repository has no package.json', () => {
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not affected/);
  });

  it('is not affected when the package is not a dependency', () => {
    installNpmStub();
    npmRepo({ dependencies: { other: '^1.0.0' } });
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not a dependency/);
    expect(args()).toBeNull();
  });

  it('is not affected when it is only a peer dependency', () => {
    installNpmStub();
    npmRepo({ peerDependencies: { lodash: '^4.0.0' } });
    expect(run(cmd()).status).toBe(0);
    expect(args()).toBeNull();
  });

  it('cannot apply to a workspaces repository that does not list the package at its root', () => {
    installNpmStub();
    npmRepo({ workspaces: ['packages/*'] });
    const r = run(cmd());
    expect(r.status).toBe(RECIPE_EXIT_UNSUPPORTED);
    expect(args()).toBeNull();
  });

  it.each(['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'])(
    'cannot apply when %s is present',
    (lockfile) => {
      installNpmStub();
      npmRepo({ dependencies: { lodash: '^4.17.0' } });
      file(lockfile, '');
      const r = run(cmd());
      expect(r.status).toBe(RECIPE_EXIT_UNSUPPORTED);
      expect(r.stderr).toMatch(/unsupported lockfile/);
      expect(args()).toBeNull();
    }
  );

  it('cannot apply without package-lock.json', () => {
    installNpmStub();
    file('package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } }));
    expect(run(cmd()).status).toBe(RECIPE_EXIT_UNSUPPORTED);
    expect(args()).toBeNull();
  });

  it.each([
    'github:evil/repo',
    'file:../x',
    'npm:other@1.0.0',
    '*',
    'latest',
    '>=1.0.0',
    'workspace:*',
  ])('cannot apply when the dependency is declared as %j', (spec) => {
    installNpmStub();
    npmRepo({ dependencies: { lodash: spec } });
    expect(run(cmd()).status).toBe(RECIPE_EXIT_UNSUPPORTED);
    expect(args()).toBeNull();
  });

  it('does nothing, exit 0, when the lockfile already resolves the target', () => {
    installNpmStub();
    npmRepo({ dependencies: { lodash: '^4.17.0' } }, '4.17.21');
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already at 4\.17\.21/);
    expect(args()).toBeNull();
  });

  it('installs with the lockfile-only, no-scripts flags, as one argv entry per parameter', () => {
    installNpmStub();
    npmRepo({ dependencies: { lodash: '^4.17.0' } });
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(args()).toEqual([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-prod',
      '--save-prefix=^',
      '--',
      'lodash@4.17.21',
    ]);
  });

  it('maps a devDependency to --save-dev and keeps a tilde range', () => {
    installNpmStub();
    npmRepo({ devDependencies: { lodash: '~4.17.0' } });
    expect(run(cmd()).status).toBe(0);
    expect(args()).toContain('--save-dev');
    expect(args()).toContain('--save-prefix=~');
  });

  it('maps an optionalDependency to --save-optional and keeps an exact pin', () => {
    installNpmStub();
    npmRepo({ optionalDependencies: { lodash: '4.17.0' } });
    expect(run(cmd()).status).toBe(0);
    expect(args()).toContain('--save-optional');
    expect(args()).toContain('--save-exact');
  });

  it('passes a scoped package as a single argument', () => {
    stub(
      'npm',
      `printf '%s\\n' "$@" > "${dir}/args"
node -e '
const fs = require("node:fs");
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
l.packages["node_modules/@scope/pkg"] = { version: "2.0.0" };
fs.writeFileSync("package-lock.json", JSON.stringify(l));
'`
    );
    file('package.json', JSON.stringify({ dependencies: { '@scope/pkg': '^1.0.0' } }));
    file('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const r = run(
      buildRecipeCommand('npm-dependency@1', { packageName: '@scope/pkg', targetVersion: '2.0.0' })
    );
    expect(r.status).toBe(0);
    expect(args()?.at(-1)).toBe('@scope/pkg@2.0.0');
  });

  it('exits 4 when the install does not end at the requested version', () => {
    installNpmStub('4.17.19');
    npmRepo({ dependencies: { lodash: '^4.17.0' } });
    const r = run(cmd());
    expect(r.status).toBe(RECIPE_EXIT_NOT_RESOLVED);
  });

  it('fails when the tool fails', () => {
    stub('npm', 'exit 1');
    npmRepo({ dependencies: { lodash: '^4.17.0' } });
    expect(run(cmd()).status).not.toBe(0);
  });

  it('never runs a hostile-looking but valid name through the shell', () => {
    // Valid names can contain characters a shell treats as special when unquoted.
    installNpmStub();
    const name = 'a.b_c~d';
    file('package.json', JSON.stringify({ dependencies: { [name]: '^1.0.0' } }));
    file('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
    stub(
      'npm',
      `printf '%s\\n' "$@" > "${dir}/args"
node -e '
const fs = require("node:fs");
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
l.packages["node_modules/" + process.env.PKG] = { version: "2.0.0" };
fs.writeFileSync("package-lock.json", JSON.stringify(l));
'`
    );
    const r = run(
      buildRecipeCommand('npm-dependency@1', { packageName: name, targetVersion: '2.0.0' })
    );
    expect(r.status).toBe(0);
    expect(args()?.at(-1)).toBe('a.b_c~d@2.0.0');
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
  });
});

describe('go-module@1 script', () => {
  const MOD = 'github.com/stretchr/testify';
  const cmd = () =>
    buildRecipeCommand('go-module@1', { packageName: MOD, targetVersion: 'v1.9.0' });

  /** A `go` that records its arguments and rewrites go.mod's requirement of the module. */
  function installGoStub(resolved?: string) {
    stub(
      'go',
      `printf '%s\\n' "$@" >> "${dir}/args"
if [ "$1" = get ]; then
  spec="$3"; ver="\${spec##*@}"
  ${resolved ? `ver='${resolved}'` : ''}
  sed "s|\\(${MOD.replace(/\//g, '\\/')}\\) v[^ ]*|\\1 $ver|" go.mod > go.mod.new && mv go.mod.new go.mod
fi`
    );
  }

  it('is not affected without a go.mod', () => {
    installGoStub();
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no go\.mod/);
  });

  it('is not affected when the module is not required', () => {
    installGoStub();
    file('go.mod', 'module x\n\ngo 1.22\n\nrequire github.com/other/mod v1.0.0\n');
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not required/);
    expect(args()).toBeNull();
  });

  it('does not mistake a replace or exclude block for a requirement', () => {
    installGoStub();
    file(
      'go.mod',
      `module x

go 1.22

replace (
\t${MOD} => ../testify
)

exclude (
\t${MOD} v1.0.0
)
`
    );
    expect(run(cmd()).status).toBe(0);
    expect(args()).toBeNull();
  });

  it('does nothing when the module is already at the target', () => {
    installGoStub();
    file('go.mod', `module x\n\ngo 1.22\n\nrequire ${MOD} v1.9.0\n`);
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already at v1\.9\.0/);
    expect(args()).toBeNull();
  });

  it.each([
    ['a single-line require', (v: string) => `module x\n\ngo 1.22\n\nrequire ${MOD} ${v}\n`],
    [
      'a require block',
      (v: string) =>
        `module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\t${MOD} ${v} // indirect\n)\n`,
    ],
  ])('raises the module in %s with go get and go mod tidy', (_name, build) => {
    installGoStub();
    file('go.mod', build('v1.8.0'));
    const r = run(cmd());
    expect(r.status).toBe(0);
    expect(args()).toEqual(['get', '--', `${MOD}@v1.9.0`, 'mod', 'tidy']);
    expect(read('go.mod')).toContain(`${MOD} v1.9.0`);
  });

  it('exits 4 when go resolves a different version', () => {
    installGoStub('v1.10.0');
    file('go.mod', `module x\n\ngo 1.22\n\nrequire ${MOD} v1.8.0\n`);
    expect(run(cmd()).status).toBe(RECIPE_EXIT_NOT_RESOLVED);
  });

  it('fails when go fails', () => {
    stub('go', 'exit 1');
    file('go.mod', `module x\n\ngo 1.22\n\nrequire ${MOD} v1.8.0\n`);
    expect(run(cmd()).status).not.toBe(0);
  });
});
