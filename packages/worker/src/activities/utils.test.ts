import { describe, expect, it } from 'vitest';
import { detectTestCommand, parseTestOutput, testRunCommand } from './utils.js';

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
