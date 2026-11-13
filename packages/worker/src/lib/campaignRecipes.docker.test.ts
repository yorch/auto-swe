import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRecipeCommand, RECIPE_EXIT_UNSUPPORTED } from './campaignRecipes.js';

/**
 * The campaign recipes against their real toolchains, in the real images, the way the shell step
 * runs them: `sh -c <script>` in `/workspace/repo`, here as the host's own user so the temp
 * directory can be removed afterwards. Opt in with CAMPAIGN_RECIPES_DOCKER_TEST=1; needs a Docker
 * daemon and, for the two cases that resolve a real version, network access to the npm registry
 * and the Go module proxy.
 *
 * The unit suite stubs `npm` and `go` and runs the same scripts, which pins the arguments and the
 * exit codes; this one shows the stubs agree with what the tools do: the lockfile really ends at
 * the version, `--ignore-scripts` is honoured, and a hostile-looking but valid name stays data.
 */
const enabled = process.env.CAMPAIGN_RECIPES_DOCKER_TEST === '1';

let dir: string;

function docker(image: string, cwd: string, script: string, network = true) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${uid}:${gid}`,
      ...(network ? [] : ['--network', 'none']),
      '-e',
      'HOME=/tmp',
      '-e',
      'npm_config_cache=/tmp/.npm',
      '-e',
      'GOCACHE=/tmp/gocache',
      '-e',
      'GOPATH=/tmp/gopath',
      '-v',
      `${cwd}:/workspace/repo`,
      '-w',
      '/workspace/repo',
      image,
      'sh',
      '-c',
      script,
    ],
    { encoding: 'utf8', timeout: 240_000 }
  );
}

const NODE = 'node:24-alpine';
const GO = 'golang:1.26-alpine';

describe.skipIf(!enabled)('campaign recipes in their images', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recipes-docker-'));
  });

  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  function repo(name: string, files: Record<string, string>): string {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(path, file), content);
    }
    return path;
  }

  it('npm: raises a dependency in package.json and the lockfile, running no script', async () => {
    const path = repo('npm', {
      // A root lifecycle script that would leave a marker if scripts ran at all.
      'package.json': JSON.stringify({
        dependencies: { 'is-odd': '3.0.0' },
        name: 'x',
        scripts: {
          preinstall: 'touch /workspace/repo/SCRIPT_RAN',
          prepare: 'touch /workspace/repo/SCRIPT_RAN',
        },
        version: '1.0.0',
      }),
    });
    // Create the starting lockfile with the same flags the recipe uses.
    const seed = docker(
      NODE,
      path,
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund'
    );
    expect(seed.status, seed.stderr).toBe(0);

    const result = docker(
      NODE,
      path,
      buildRecipeCommand('npm-dependency@1', { packageName: 'is-odd', targetVersion: '3.0.1' })
    );
    expect(result.status, result.stderr).toBe(0);
    const lock = JSON.parse(readFileSync(join(path, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/is-odd'].version).toBe('3.0.1');
    expect(
      JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).dependencies['is-odd']
    ).toBe('^3.0.1');
    expect(existsSync(join(path, 'SCRIPT_RAN'))).toBe(false);
  });

  it('npm: a repository that does not use the package is not affected, with no network', () => {
    const path = repo('npm-absent', {
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
      'package.json': JSON.stringify({ dependencies: { other: '1.0.0' }, name: 'x' }),
    });
    const result = docker(
      NODE,
      path,
      buildRecipeCommand('npm-dependency@1', { packageName: 'lodash', targetVersion: '4.17.21' }),
      false
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/not affected/);
  });

  it('npm: a yarn repository cannot apply, with no network', () => {
    const path = repo('npm-yarn', {
      'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.0' }, name: 'x' }),
      'yarn.lock': '# yarn lockfile v1\n',
    });
    const result = docker(
      NODE,
      path,
      buildRecipeCommand('npm-dependency@1', { packageName: 'lodash', targetVersion: '4.17.21' }),
      false
    );
    expect(result.status).toBe(RECIPE_EXIT_UNSUPPORTED);
  });

  it('npm: a name that only looks hostile to a shell is passed as data', () => {
    // `a.b_c~d` is a valid package name; nothing in it is special once quoted.
    const path = repo('npm-odd', {
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
      'package.json': JSON.stringify({ dependencies: { 'a.b_c~d': '^1.0.0' }, name: 'x' }),
    });
    const result = docker(
      NODE,
      path,
      buildRecipeCommand('npm-dependency@1', { packageName: 'a.b_c~d', targetVersion: '2.0.0' }),
      false
    );
    // No network: npm cannot resolve it, so it fails, but only as npm, never as the shell.
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/not found: |syntax error|unexpected/i);
    expect(existsSync(join(path, 'pwned'))).toBe(false);
  });

  it('go: raises a module in go.mod and tidies', async () => {
    const path = repo('go', {
      'go.mod': 'module example.test/x\n\ngo 1.22\n\nrequire github.com/google/uuid v1.3.0\n',
      'main.go':
        'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { _ = uuid.New() }\n',
    });
    const seed = docker(GO, path, 'go mod tidy');
    expect(seed.status, seed.stderr).toBe(0);
    const result = docker(
      GO,
      path,
      buildRecipeCommand('go-module@1', {
        packageName: 'github.com/google/uuid',
        targetVersion: 'v1.6.0',
      })
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(path, 'go.mod'), 'utf8')).toContain('github.com/google/uuid v1.6.0');
  });

  it('go: a module the repository does not require is not affected, with no network', () => {
    const path = repo('go-absent', {
      'go.mod': 'module example.test/x\n\ngo 1.22\n',
    });
    const result = docker(
      GO,
      path,
      buildRecipeCommand('go-module@1', {
        packageName: 'github.com/google/uuid',
        targetVersion: 'v1.6.0',
      }),
      false
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/not required/);
  });
});
