import { describe, expect, it } from 'vitest';
import {
  parseRepoSetup,
  parseRepoSetupYaml,
  REPO_SETUP_FILE,
  resolveRepoSetup,
  stackDefaultSetup,
} from './repoSetup.js';

const nodeStack = (packageManager: string, evidence: string[], yarnFlavor?: string) => ({
  evidence,
  packageManager,
  primary: 'node',
  stacks: ['node'],
  yarnFlavor,
});

describe('RepoSetupSchema', () => {
  it('accepts the documented shape', () => {
    const parsed = parseRepoSetupYaml(
      [
        'submodules: recursive',
        'lfs: true',
        'env: { CI: "1" }',
        'steps:',
        '  - name: install',
        '    run: yarn install --immutable',
        '    timeoutSeconds: 600',
        '  - run: ./scripts/codegen.sh',
        '    workdir: packages/api',
        'cache:',
        '  paths: [node_modules, ~/.cache/pip]',
        '  keyFiles: [yarn.lock]',
      ].join('\n')
    );
    expect(parsed).toMatchObject({ ok: true, setup: { lfs: true, submodules: 'recursive' } });
  });

  it('reads an empty file as an empty definition', () => {
    expect(parseRepoSetupYaml('')).toEqual({ ok: true, setup: {} });
  });

  it.each([
    [{ steps: [{ run: '  ' }] }, 'steps.0.run'],
    [{ steps: [{ run: 'x', workdir: '../up' }] }, 'steps.0.workdir'],
    [{ steps: [{ run: 'x', workdir: '/abs' }] }, 'steps.0.workdir'],
    [{ cache: { paths: ['~/../etc'] } }, 'cache.paths.0'],
    [{ cache: { paths: ['a b'] } }, 'cache.paths.0'],
    [{ cache: { paths: ['-rf'] } }, 'cache.paths.0'],
    [{ cache: { paths: ['./x'] } }, 'cache.paths.0'],
    [{ submodules: 'shallow' }, 'submodules'],
    [{ env: { lower: 'x' } }, 'env'],
    [{ unknown: true }, '(root)'],
  ])('refuses %j', (value, path) => {
    const parsed = parseRepoSetup(value);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain(path);
  });

  it('reports invalid YAML rather than throwing', () => {
    expect(parseRepoSetupYaml('steps: [').ok).toBe(false);
  });
});

describe('stackDefaultSetup', () => {
  it('installs a Yarn Berry root faithfully to its lockfile and caches node_modules', () => {
    expect(stackDefaultSetup(nodeStack('yarn', ['package.json', 'yarn.lock'], 'berry'))).toEqual({
      cache: { keyFiles: ['yarn.lock'], paths: ['node_modules'] },
      steps: [{ name: 'install dependencies', run: 'yarn install --immutable' }],
    });
  });

  it('uses npm ci for npm and gives nothing without the lockfile', () => {
    expect(stackDefaultSetup(nodeStack('npm', ['package-lock.json']))?.steps?.[0]?.run).toBe(
      'npm ci'
    );
    expect(stackDefaultSetup(nodeStack('npm', ['package.json']))).toBeNull();
  });

  it('gives nothing for other stacks or no detection', () => {
    expect(stackDefaultSetup(null)).toBeNull();
    expect(stackDefaultSetup({ evidence: ['go.mod'], primary: 'go', stacks: ['go'] })).toBeNull();
  });
});

describe('resolveRepoSetup', () => {
  const field = { steps: [{ run: 'make deps' }] };

  it('prefers the repository field over the file', () => {
    expect(
      resolveRepoSetup({
        fileText: 'steps: [{ run: x }]',
        repositoryField: field,
        stackDefaults: true,
      })
    ).toEqual({ ok: true, resolved: { setup: field, source: 'repository' } });
  });

  it('reads the file when the field is unset, and fails on an invalid one', () => {
    expect(
      resolveRepoSetup({ fileText: 'lfs: true', repositoryField: null, stackDefaults: false })
    ).toEqual({ ok: true, resolved: { setup: { lfs: true }, source: 'file' } });
    const bad = resolveRepoSetup({
      fileText: 'lfs: 3',
      repositoryField: null,
      stackDefaults: true,
    });
    expect(bad.ok ? '' : bad.error).toContain(REPO_SETUP_FILE);
  });

  it('falls back to stack defaults only when enabled', () => {
    const detectedStack = nodeStack('pnpm', ['pnpm-lock.yaml']);
    const input = { detectedStack, fileText: null, repositoryField: null };
    expect(resolveRepoSetup({ ...input, stackDefaults: false })).toEqual({
      ok: true,
      resolved: { setup: null, source: null },
    });
    const on = resolveRepoSetup({ ...input, stackDefaults: true });
    expect(on.ok && on.resolved.source).toBe('stack');
  });
});
