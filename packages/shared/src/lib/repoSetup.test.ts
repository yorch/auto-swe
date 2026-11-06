import { describe, expect, it } from 'vitest';
import {
  parseRepoSetup,
  parseRepoSetupYaml,
  REPO_SETUP_FILE,
  repoSetupToYaml,
  resolveRepoSetup,
  stackDefaultSetup,
  starterRepoSetup,
} from './repoSetup.js';
import { detectStack } from './stackDetection.js';

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

  it('gives nothing without a detection, or without the file an install needs', () => {
    expect(stackDefaultSetup(null)).toBeNull();
    expect(stackDefaultSetup({ evidence: ['go.mod'], primary: 'go', stacks: ['go'] })).toBeNull();
    expect(
      stackDefaultSetup({ evidence: ['pyproject.toml'], primary: 'python', stacks: ['python'] })
    ).toBeNull();
    expect(
      stackDefaultSetup({ evidence: ['build.gradle'], primary: 'jvm', stacks: ['jvm'] })
    ).toBeNull();
  });

  const one = (stack: string, evidence: string[]) => ({
    evidence,
    primary: stack,
    stacks: [stack],
  });

  it.each([
    [
      'python',
      ['pyproject.toml', 'uv.lock', 'requirements.txt'],
      'uv sync --frozen',
      { keyFiles: ['uv.lock'], paths: ['.venv'] },
    ],
    [
      'python',
      ['requirements.txt'],
      'python -m venv .venv && .venv/bin/pip install -r requirements.txt',
      { keyFiles: ['requirements.txt'], paths: ['.venv'] },
    ],
    [
      'go',
      ['go.mod', 'go.sum'],
      'go mod download',
      { keyFiles: ['go.mod', 'go.sum'], paths: ['~/go/pkg/mod'] },
    ],
    [
      'jvm',
      ['pom.xml'],
      'mvn -B -q dependency:go-offline',
      { keyFiles: ['pom.xml'], paths: ['~/.m2/repository'] },
    ],
    [
      'jvm',
      ['settings.gradle.kts', 'gradlew'],
      './gradlew --no-daemon dependencies',
      {
        keyFiles: [
          'settings.gradle.kts',
          'gradle/libs.versions.toml',
          'gradle/wrapper/gradle-wrapper.properties',
        ],
        paths: ['~/.gradle/caches', '~/.gradle/wrapper'],
      },
    ],
  ])('installs %s from %j', (stack, evidence, run, cache) => {
    expect(stackDefaultSetup(one(stack, evidence))).toEqual({
      cache,
      steps: [{ name: 'install dependencies', run }],
    });
  });

  it('reads the install files from a fresh detection', () => {
    expect(
      stackDefaultSetup(detectStack(['go.mod', 'go.sum', 'docs/uv.lock']))?.steps?.[0]?.run
    ).toBe('go mod download');
    expect(detectStack(['go.mod', 'docs/uv.lock']).evidence).toEqual(['go.mod']);
    expect(stackDefaultSetup(detectStack(['pom.xml', 'gradlew']))?.steps?.[0]?.run).toBe(
      'mvn -B -q dependency:go-offline'
    );
  });

  it('runs a single component in its directory, keeping home paths as they are', () => {
    const detected = {
      components: [{ path: 'svc', stacks: ['go'] }],
      evidence: ['svc/go.mod', 'svc/go.sum'],
      primary: 'go',
      stacks: ['go'],
    };
    expect(stackDefaultSetup(detected)).toEqual({
      cache: { keyFiles: ['svc/go.mod', 'svc/go.sum'], paths: ['~/go/pkg/mod'] },
      steps: [{ name: 'install dependencies', run: 'go mod download', workdir: 'svc' }],
    });
  });
});

describe('repoSetupToYaml', () => {
  it('writes a commented file that parses back to the same definition', () => {
    const setup = {
      cache: { keyFiles: ['yarn.lock'], paths: ['node_modules'] },
      env: { CI: '1' },
      lfs: true,
      steps: [{ name: 'install', run: 'yarn install --immutable', timeoutSeconds: 900 }],
      submodules: 'recursive' as const,
    };
    const text = repoSetupToYaml(setup);
    expect(text.startsWith('# .auto-swe/setup.yml')).toBe(true);
    expect(text.indexOf('submodules:')).toBeLessThan(text.indexOf('steps:'));
    expect(parseRepoSetupYaml(text)).toEqual({ ok: true, setup });
  });

  it('starts from the stack default, else a placeholder step', () => {
    expect(starterRepoSetup(nodeStack('npm', ['package-lock.json']))?.steps?.[0]?.run).toBe(
      'npm ci'
    );
    expect(parseRepoSetup(starterRepoSetup(null)).ok).toBe(true);
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
