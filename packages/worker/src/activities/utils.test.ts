import { describe, expect, it } from 'vitest';
import {
  detectTestCommand,
  noTestsFoundCause,
  noTestsFoundNotes,
  noTestsRunResult,
  packageJsonReadCommand,
  parseTestOutput,
  testCommandSource,
  testRunCommand,
  testStatusWord,
  unrunnableTestCause,
} from './utils.js';

describe('detectTestCommand with a component target', () => {
  const component = (path: string, stack: string, extra: object = {}) => ({
    components: [{ path, stacks: [stack], ...extra }],
    evidence: [],
  });

  it('runs a non-Node component’s default in its directory', () => {
    expect(detectTestCommand('{}', null, component('services/api', 'go'))).toBe(
      "cd 'services/api' && go test ./..."
    );
  });

  it('guesses a Node component’s command from ITS package.json and runs it there', () => {
    const pkg = JSON.stringify({ devDependencies: { vitest: '1' } });
    expect(detectTestCommand(pkg, null, component('web', 'node'))).toBe(
      "cd 'web' && npx vitest run"
    );
    expect(detectTestCommand('{}', null, component('web', 'node'))).toBe("cd 'web' && npm test");
  });

  it('never wraps a command an admin configured', () => {
    expect(
      detectTestCommand('{}', { runTests: 'make -C web test' }, component('web', 'node'))
    ).toBe('make -C web test');
  });

  it('leaves an ambiguous layout on the root guess, in the root', () => {
    const both = {
      components: [
        { path: 'a', stacks: ['go'] },
        { path: 'b', stacks: ['jvm'] },
      ],
      evidence: [],
    };
    expect(detectTestCommand('{}', null, both)).toBe('npm test');
  });

  it('reads the component’s package.json, quoting the directory', () => {
    expect(packageJsonReadCommand(component('web', 'node'))).toBe(
      `cat 'web/package.json' 2>/dev/null || echo "{}"`
    );
    expect(packageJsonReadCommand(undefined)).toBe('cat package.json 2>/dev/null || echo "{}"');
    expect(packageJsonReadCommand(component('a b; id', 'node'))).toBe(
      'cat package.json 2>/dev/null || echo "{}"'
    );
  });
});

describe('detectTestCommand with a detected stack', () => {
  const python = { components: [{ path: '', stacks: ['python'] }], evidence: ['pyproject.toml'] };
  const node = { components: [{ path: '', stacks: ['node'] }], evidence: ['package.json'] };

  it('uses the stack default where there is no package.json to read', () => {
    expect(detectTestCommand('{}', null, python)).toBe('python -m pytest');
  });

  it('still lets the configured runTests win over the stack default', () => {
    expect(detectTestCommand('{}', { runTests: 'tox' }, python)).toBe('tox');
  });

  it('keeps the package.json guess for an npm Node root, not the manager default', () => {
    const npm = { ...node, packageManager: 'npm' };
    const pkg = JSON.stringify({ devDependencies: { vitest: '1' } });
    expect(detectTestCommand(pkg, null, npm)).toBe('npx vitest run');
  });

  it('keeps the package.json guess for a Node or undetected root', () => {
    const pkg = JSON.stringify({ devDependencies: { vitest: '1' } });
    expect(detectTestCommand(pkg, null, node)).toBe('npx vitest run');
    expect(detectTestCommand(pkg, null, null)).toBe('npx vitest run');
  });
});

describe('detectTestCommand', () => {
  it("prefers the repository's configured runTests gate command", () => {
    const pkg = JSON.stringify({ devDependencies: { vitest: '4' } });
    expect(detectTestCommand(pkg, { runTests: 'pytest -xvs' })).toBe('pytest -xvs');
  });

  it('ignores a blank or non-string runTests command', () => {
    const pkg = JSON.stringify({ devDependencies: { vitest: '4' } });
    expect(detectTestCommand(pkg, { runTests: '   ' })).toBe('npx vitest run');
    expect(detectTestCommand(pkg, { runTests: 42 })).toBe('npx vitest run');
    expect(detectTestCommand(pkg, { runLint: 'ruff' })).toBe('npx vitest run');
    expect(detectTestCommand(pkg, null)).toBe('npx vitest run');
  });

  it('falls back to npm test for a real test script or unparseable package.json', () => {
    expect(detectTestCommand(JSON.stringify({ scripts: { test: 'jest' } }))).toBe('npm test');
    expect(detectTestCommand('not json')).toBe('npm test');
  });
});

describe('parseTestOutput', () => {
  it('passes on parsed counts with no failures', () => {
    const r = parseTestOutput('Tests  12 passed (12)', 5, 0);
    expect(r).toMatchObject({ failing: 0, passed: true, passing: 12, total: 12 });
  });

  it('fails on parsed failures', () => {
    expect(parseTestOutput('3 passed, 1 failed', 5, 0).passed).toBe(false);
  });

  it('passes go test on its per-package ok lines', () => {
    expect(parseTestOutput('ok  \texample.com/pkg\t0.214s', 5, 0).passed).toBe(true);
    // Untested packages print `[no test files]` beside the tested ones.
    const mixed = '?   \texample.com/cmd\t[no test files]\nok  \texample.com/pkg\t0.2s\n';
    expect(parseTestOutput(mixed, 5, 0).passed).toBe(true);
    expect(parseTestOutput('=== RUN   TestX\n--- PASS: TestX (0.00s)\nPASS\n', 5, 0).passed).toBe(
      true
    );
  });

  it('passes pytest, vitest, jest, mocha, cargo and node --test on their counts', () => {
    expect(parseTestOutput('===== 5 passed in 0.12s =====', 5, 0).passed).toBe(true);
    expect(
      parseTestOutput(' Test Files  2 passed (2)\n      Tests  12 passed (12)', 5, 0)
    ).toMatchObject({ passed: true });
    expect(
      parseTestOutput('PASS src/a.test.js\nTests:       7 passed, 7 total\n', 5, 0).passed
    ).toBe(true);
    expect(parseTestOutput('  4 passing (12ms)', 5, 0).passed).toBe(true);
    expect(parseTestOutput('test result: ok. 3 passed; 0 failed; 0 ignored', 5, 0).passed).toBe(
      true
    );
    expect(parseTestOutput('ℹ tests 5\nℹ pass 5\nℹ fail 0\n', 5, 0)).toMatchObject({
      failing: 0,
      passed: true,
      passing: 5,
    });
    expect(parseTestOutput('# tests 2\n# pass 1\n# fail 1\n', 5, 0)).toMatchObject({
      failing: 1,
      passed: false,
    });
    expect(parseTestOutput('Ran 3 tests in 0.001s\n\nOK\n', 5, 0).passed).toBe(true);
  });

  it('passes rspec, phpunit and dotnet test on their summaries', () => {
    expect(
      parseTestOutput('Finished in 0.1 seconds\n5 examples, 0 failures\n', 5, 0)
    ).toMatchObject({ passed: true, passing: 5 });
    expect(parseTestOutput('5 examples, 2 failures\n', 5, 0).passed).toBe(false);
    expect(parseTestOutput('OK (5 tests, 12 assertions)\n', 5, 0)).toMatchObject({
      passed: true,
      passing: 5,
    });
    expect(
      parseTestOutput('Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5', 5, 0)
    ).toMatchObject({ failing: 0, passed: true, passing: 5 });
    expect(
      parseTestOutput('Failed!  - Failed:     1, Passed:     4, Skipped:     0, Total:     5', 5, 0)
        .passed
    ).toBe(false);
  });

  it('reads every cargo test binary, not just the first', () => {
    const out = [
      'running 0 tests',
      'test result: ok. 0 passed; 0 failed; 0 ignored',
      'running 4 tests',
      'test result: ok. 4 passed; 0 failed; 0 ignored',
      '   Doc-tests crate',
      'test result: ok. 0 passed; 0 failed; 0 ignored',
    ].join('\n');
    expect(parseTestOutput(out, 5, 0)).toMatchObject({ passed: true, passing: 4 });
    const failedLater =
      'test result: ok. 3 passed; 0 failed\ntest result: FAILED. 1 passed; 2 failed';
    expect(parseTestOutput(failedLater, 5, 0).passed).toBe(false);
  });

  it('fails a suite that exits 0 having run no tests', () => {
    // Vitest --passWithNoTests
    expect(
      parseTestOutput('No test files found, exiting with code 0\n\ninclude: **/*.test.ts', 5, 0)
        .passed
    ).toBe(false);
    // Jest --passWithNoTests
    expect(
      parseTestOutput('No tests found, exiting with code 0\nRun with `--passWithNoTests`', 5, 0)
        .passed
    ).toBe(false);
    expect(parseTestOutput('Tests:       0 passed, 0 total', 5, 0).passed).toBe(false);
    // pytest with nothing collected
    expect(
      parseTestOutput('collected 0 items\n\n==== no tests ran in 0.01s ====', 5, 0).passed
    ).toBe(false);
    expect(parseTestOutput('Ran 0 tests in 0.000s\n\nOK\n', 5, 0).passed).toBe(false);
    // Go with no test files anywhere
    expect(parseTestOutput('?   \texample.com/pkg\t[no test files]\n', 5, 0).passed).toBe(false);
  });

  it('is not fooled by a runTests command that just prints ok or PASS', () => {
    expect(parseTestOutput('ok\n', 5, 0).passed).toBe(false);
    expect(parseTestOutput('ok', 5, 0).passed).toBe(false);
    expect(parseTestOutput('PASS\n', 5, 0).passed).toBe(false);
    expect(parseTestOutput('', 5, 0).passed).toBe(false);
  });

  it('never passes on a non-zero exit, whatever the output claims', () => {
    expect(parseTestOutput('12 passed', 5, 1).passed).toBe(false);
    expect(parseTestOutput('', 5, 2).passed).toBe(false);
  });

  it('keeps the count-only verdict when the exit code is unknown', () => {
    expect(parseTestOutput('ok', 5).passed).toBe(false);
    expect(parseTestOutput('4 passing', 5).passed).toBe(true);
  });
});

describe('testRunCommand', () => {
  it('folds stderr into stdout for the whole command, compound or commented', () => {
    expect(testRunCommand('npx jest')).toBe('{ npx jest\n} 2>&1');
    expect(testRunCommand('make build && go test ./... # all')).toBe(
      '{ make build && go test ./... # all\n} 2>&1'
    );
  });
});

describe('unrunnableTestCause', () => {
  const execError = (fields: Record<string, unknown>) => Object.assign(new Error('failed'), fields);

  it('treats exit 127 (command not found) and 126 (not executable) as unrunnable', () => {
    expect(
      unrunnableTestCause(execError({ code: 127, stdout: 'sh: bun: not found' }))
    ).toBeDefined();
    expect(unrunnableTestCause(execError({ code: 126, stdout: 'sh: ./test.sh: Permission' }))).toBe(
      'exit status 126: command not executable'
    );
  });

  it('reads the exit status from either `code` (async exec) or `status` (execSync)', () => {
    expect(unrunnableTestCause(execError({ status: 127 }))).toBe(
      'exit status 127: command not found'
    );
  });

  it("recognises npm's missing test script marker", () => {
    const stdout = 'npm error Missing script: "test"\nnpm error\nnpm error To see a list';
    expect(unrunnableTestCause(execError({ code: 1, stdout }))).toBeDefined();
    expect(
      unrunnableTestCause(execError({ code: 1, stdout: 'npm ERR! Missing script: "test"' }))
    ).toBeDefined();
  });

  it("recognises npm's missing package.json failure (exit 254)", () => {
    const stdout = [
      'npm error code ENOENT',
      'npm error syscall open',
      'npm error path /workspace/target-repo/package.json',
      'npm error errno -2',
      'npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open',
    ].join('\n');
    expect(unrunnableTestCause(execError({ code: 254, stdout }))).toBe(
      'npm reports no package.json in the workspace'
    );
  });

  it('needs exit 254 and an unindented line: a nested npm run inside a failing suite is not it', () => {
    const line = 'npm error enoent Could not read package.json: Error: ENOENT: no such file';
    const outputs = [
      line,
      `Tests: 1 failed\n${line}`,
      `    ${line}`,
      `stderr | x > ${line}`,
      `npm ERR! enoent Could not read package.json: Error: ENOENT`,
      `error Couldn't find a package.json file in "/workspace/target-repo"`,
    ];
    for (const stdout of outputs) {
      expect(unrunnableTestCause(execError({ code: 1, stdout }))).toBeUndefined();
    }
    for (const stdout of [
      `    ${line}`,
      `stderr | x > ${line}`,
      line.replace('npm error', 'npm ERR!'),
    ]) {
      expect(unrunnableTestCause(execError({ code: 254, stdout }))).toBeUndefined();
    }
  });

  it('does not match application output that merely mentions package.json or ENOENT', () => {
    const outputs = [
      'FAIL cfg.test.ts\n  Error: ENOENT: no such file or directory, open package.json\nTests: 1 failed',
      'enoent Could not read package.json: Error: ENOENT (printed by a test)',
      'console.log: npm error code ENOENT is what npm prints\nTests: 1 failed',
      'npm error enoent Could not read something.json: Error: ENOENT',
    ];
    for (const stdout of outputs) {
      expect(unrunnableTestCause(execError({ code: 254, stdout }))).toBeUndefined();
    }
  });

  it('does not treat an ordinary failing run as unrunnable', () => {
    expect(unrunnableTestCause(execError({ code: 1, stdout: 'Tests: 2 failed, 5 passed' }))).toBe(
      undefined
    );
    expect(
      unrunnableTestCause(execError({ code: 2, stdout: 'AssertionError: expected 1 to be 2' }))
    ).toBeUndefined();
  });

  it('does not match "not found" text in runner output when the exit status is an ordinary failure', () => {
    const stdout =
      'FAIL spawn.test.ts\n  sh: foo: command not found\nexit code 127 expected\nTests: 1 failed';
    expect(unrunnableTestCause(execError({ code: 1, stdout }))).toBeUndefined();
  });

  it('needs exit 1 and a line-start message: a nested npm run inside a failing suite is not it', () => {
    const line = 'npm error Missing script: "test"';
    for (const stdout of [`    ${line}`, `stderr | x > ${line}`, `Tests: 1 failed ${line}`]) {
      expect(unrunnableTestCause(execError({ code: 1, stdout }))).toBeUndefined();
    }
    expect(unrunnableTestCause(execError({ code: 2, stdout: line }))).toBeUndefined();
    expect(unrunnableTestCause(execError({ stdout: line }))).toBeUndefined();
    expect(unrunnableTestCause(execError({ code: 1, stdout: `Tests: 1 failed\n${line}` }))).toBe(
      'npm reports Missing script: "test"'
    );
  });

  it('does not match other missing scripts or a different npm error', () => {
    expect(
      unrunnableTestCause(execError({ code: 1, stdout: 'npm error Missing script: "build"' }))
    ).toBeUndefined();
  });

  it('is false for a timeout, a signal kill, or an error with no exit status', () => {
    expect(unrunnableTestCause(execError({ code: 124, killed: true, signal: 'SIGTERM' }))).toBe(
      undefined
    );
    expect(unrunnableTestCause(execError({ code: 'ETIMEDOUT' }))).toBeUndefined();
    expect(unrunnableTestCause(new Error('boom'))).toBeUndefined();
    expect(unrunnableTestCause('boom')).toBeUndefined();
    expect(unrunnableTestCause(null)).toBeUndefined();
  });

  it('names the cause, so the notes and the classifier share one answer', () => {
    expect(unrunnableTestCause(execError({ code: 127 }))).toBe(
      'exit status 127: command not found'
    );
    expect(unrunnableTestCause(execError({ code: 126 }))).toBe(
      'exit status 126: command not executable'
    );
    expect(
      unrunnableTestCause(execError({ code: 1, stdout: 'npm error Missing script: "test"' }))
    ).toBe('npm reports Missing script: "test"');
  });

  it('is undefined for neighbouring exit statuses 125, 128+ and 255', () => {
    for (const code of [125, 128, 130, 137, 255]) {
      expect(unrunnableTestCause(execError({ code, stdout: 'sh: x: not found' }))).toBeUndefined();
    }
  });
});

describe('testCommandSource', () => {
  const stackOf = (stack: string, dir = '') => ({
    components: [{ path: dir, stacks: [stack] }],
    evidence: [],
  });
  const pkg = JSON.stringify({ devDependencies: { vitest: '1' } });

  it.each([
    ['a configured runTests', pkg, { runTests: 'make test' }, stackOf('python'), 'configured'],
    [
      'a configured runTests over a Node root',
      pkg,
      { runTests: 'make test' },
      undefined,
      'configured',
    ],
    ['a Python root', '{}', null, stackOf('python'), 'stack'],
    ['a Go root', '{}', null, stackOf('go'), 'stack'],
    ['a non-Node component', '{}', null, stackOf('go', 'services/api'), 'stack'],
    ['a Node root', pkg, null, stackOf('node'), 'node-guess'],
    ['a Node component', pkg, null, stackOf('node', 'web'), 'node-guess'],
    ['no detection', pkg, null, undefined, 'node-guess'],
    ['a blank runTests', pkg, { runTests: '  ' }, null, 'node-guess'],
  ])('%s is %s', (_name, packageJson, gate, detected, expected) => {
    expect(testCommandSource(packageJson, gate, detected)).toBe(expected);
  });

  it('is an ambiguous layout falling back to the guess', () => {
    const both = {
      components: [
        { path: 'a', stacks: ['go'] },
        { path: 'b', stacks: ['jvm'] },
      ],
      evidence: [],
    };
    expect(testCommandSource('{}', null, both)).toBe('node-guess');
  });

  it('agrees with detectTestCommand on which link supplied the command', () => {
    expect(detectTestCommand('{}', null, stackOf('python'))).toBe('python -m pytest');
    expect(testCommandSource('{}', null, stackOf('python'))).toBe('stack');
  });
});

describe('noTestsFoundCause', () => {
  const execError = (fields: Record<string, unknown>) => Object.assign(new Error('failed'), fields);
  const result = (fields: Partial<ReturnType<typeof noTestsRunResult>>) => ({
    ...noTestsRunResult(''),
    ...fields,
  });

  it('names a pytest exit 5 from a stack command', () => {
    expect(noTestsFoundCause('stack', { error: execError({ code: 5 }) })).toEqual({
      kind: 'none-collected',
      reason: 'exit status 5: no tests ran',
    });
    expect(noTestsFoundCause('stack', { error: execError({ status: 5 }) })).toBeDefined();
  });

  it('names a zero-exit run with no counts and no failures (go test, mvn -q)', () => {
    expect(noTestsFoundCause('stack', { result: result({}) })).toEqual({
      kind: 'unreadable',
      reason: 'the run exited 0 but printed no test counts',
    });
  });

  it('keeps iterating on real failures, collection errors and compile errors', () => {
    for (const code of [1, 2, 3, 4]) {
      expect(noTestsFoundCause('stack', { error: execError({ code }) })).toBeUndefined();
    }
    expect(noTestsFoundCause('stack', { error: new Error('timeout') })).toBeUndefined();
    expect(noTestsFoundCause('stack', { error: null })).toBeUndefined();
  });

  it('does not fire for a result that passed, ran tests or failed', () => {
    expect(noTestsFoundCause('stack', { result: result({ passed: true }) })).toBeUndefined();
    expect(
      noTestsFoundCause('stack', { result: result({ passing: 3, total: 3 }) })
    ).toBeUndefined();
    expect(noTestsFoundCause('stack', { result: result({ failing: 1 }) })).toBeUndefined();
  });

  it('never fires for a configured or package.json command', () => {
    for (const source of ['configured', 'node-guess'] as const) {
      expect(noTestsFoundCause(source, { error: execError({ code: 5 }) })).toBeUndefined();
      expect(noTestsFoundCause(source, { result: result({}) })).toBeUndefined();
    }
  });
});

describe('noTestsFoundNotes', () => {
  it('says no tests were found for pytest exit 5, naming the run that stopped the loop', () => {
    expect(noTestsFoundNotes('python -m pytest', 'none-collected', 1)).toBe(
      'The test command `python -m pytest` found no tests to run, so the TDD loop stopped after test run 1; set `runTests` for this repository.'
    );
    expect(noTestsFoundNotes('python -m pytest', 'none-collected', 2)).toContain('test run 2;');
  });

  it('does not claim missing tests for an unreadable zero exit', () => {
    const notes = noTestsFoundNotes('mvn -B -q test', 'unreadable', 2);
    expect(notes).toBe(
      'The test command `mvn -B -q test` exited 0 but printed no test counts, so whether tests ran could not be determined; the TDD loop stopped after test run 2. Set `runTests` for this repository for a command whose output can be read.'
    );
    expect(notes).not.toContain('found no tests');
  });

  it('words a fix session without any loop', () => {
    expect(noTestsFoundNotes('pytest', 'none-collected')).toBe(
      'The test command `pytest` found no tests to run; set `runTests` for this repository.'
    );
    const unreadable = noTestsFoundNotes('mvn -q test', 'unreadable');
    expect(unreadable).toBe(
      'The test command `mvn -q test` exited 0 but printed no test counts, so whether tests ran could not be determined. Set `runTests` for this repository for a command whose output can be read.'
    );
    expect(unreadable).not.toContain('loop');
  });
});

describe('green quiet suites read as unreadable, not as missing tests', () => {
  it.each([
    ['mvn -B -q test (no output)', ''],
    ['surefire verbose summary', '[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0'],
    ['gradle', 'BUILD SUCCESSFUL in 4s\n3 actionable tasks: 3 executed'],
  ])('%s', (_name, stdout) => {
    const parsed = parseTestOutput(stdout, 1, 0);
    expect(noTestsFoundCause('stack', { result: parsed })?.kind).toBe('unreadable');
  });
});

describe('testStatusWord', () => {
  const base = { duration_ms: 0, failing: 0, passed: false, passing: 0, stdout: '', total: 0 };

  it('says passing, failing and not run', () => {
    expect(testStatusWord({ ...base, passed: true, passing: 2, total: 2 })).toBe('passing');
    expect(testStatusWord({ ...base, failing: 2, passing: 1, total: 3 })).toBe('failing');
    expect(testStatusWord(base)).toBe('not run');
  });

  it('keeps the unrunnable shape (failing 1, total 0) as failing', () => {
    expect(testStatusWord({ ...base, failing: 1 })).toBe('failing');
  });
});
