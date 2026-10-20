import { describe, expect, it } from 'vitest';
import { detectStack } from './stackDetection.js';

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
    expect(r.suggestedGateCommands).toEqual({ runTests: 'mvn -B -q test' });
    expect(r.suggestedDockerfile).toBe('jvm');
  });

  it('detects jvm from a gradle build file', () => {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      const r = detectStack([file]);
      expect(r.stacks).toEqual(['jvm']);
      expect(r.suggestedGateCommands).toEqual({ runTests: './gradlew test --no-daemon' });
    }
  });

  it('detects go with no curated image', () => {
    const r = detectStack(['go.mod']);
    expect(r).toMatchObject({
      primary: 'go',
      stacks: ['go'],
      suggestedDockerfile: null,
      suggestedGateCommands: { runTests: 'go test ./...' },
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
