import type { FileChange, TestRunResult } from '@auto-swe/shared/types/workflow';

/**
 * Wall-clock cap for a full test-suite run inside the workspace. `Workspace.exec`
 * defaults to the 2-minute child-process timeout, which suits git and file
 * operations but kills a legitimate test run on any non-trivial repository —
 * the same 10-minute ceiling the agent's `bash` tool and `execCapture` use.
 */
export const TEST_RUN_TIMEOUT_MS = 600_000;

/**
 * The test command the TDD loop and the fix sessions run.
 *
 * The repository's configured `Connection.gateCommands.runTests` wins — it is
 * the same command the `runTests` quality gate uses, and the only way a
 * non-Node repository (pytest, go test, cargo test) gets a working command.
 * Without one, the command is guessed from package.json's scripts and
 * devDependencies, falling back to `npm test`.
 */
export function detectTestCommand(packageJsonStr: string, gateCommands?: unknown): string {
  const configured =
    gateCommands && typeof gateCommands === 'object'
      ? (gateCommands as Record<string, unknown>).runTests
      : undefined;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  return detectTestCommandFromPackageJson(packageJsonStr);
}

function detectTestCommandFromPackageJson(packageJsonStr: string): string {
  try {
    const pkg = JSON.parse(packageJsonStr);
    const testScript = pkg.scripts?.test;

    // No test script or npm's default placeholder — try to detect framework
    if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps.vitest) {
        return 'npx vitest run';
      }
      if (deps.jest) {
        return 'npx jest';
      }
      if (deps.mocha) {
        return 'npx mocha';
      }
      return 'npm test';
    }

    // Has a valid test script — use npm test which delegates to it
    return 'npm test';
  } catch {
    return 'npm test';
  }
}

/**
 * The shell text that runs `command` for the TDD loop and the fix sessions,
 * with stderr folded into stdout. `Workspace.exec` returns stdout only, and
 * several runners report there nothing `parseTestOutput` can read — Jest
 * writes its `PASS` lines and its `Tests: N passed` summary to stderr — so
 * without the merge a green Jest suite carries no evidence that it ran. The
 * braces group a compound command (`a && b`) whole; the newline before the
 * closing brace keeps a trailing `# comment` or `;` from swallowing it. The
 * group's exit status is the command's.
 */
export function testRunCommand(command: string): string {
  return `{ ${command}\n} 2>&1`;
}

/**
 * Runner output that shows tests actually ran, for runners whose summary
 * carries no `N passed` count: `go test`'s per-package `ok  <pkg>  0.2s` and
 * `-v`'s `--- PASS:` lines, Jest's per-file `PASS <path>`, and unittest's
 * `Ran N tests` (N ≥ 1). Each needs more than the bare word, so `echo ok` or
 * `echo PASS` is not evidence.
 */
const RAN_TESTS_RES: readonly RegExp[] = [
  /^ok[ \t]+\S+/m,
  /^--- PASS: \S/m,
  /^\s*PASS[ \t]+\S/m,
  /^Ran [1-9]\d* tests?\b/m,
];

/**
 * Passing-test counts, per runner: `12 passed` / `4 passing` (pytest, Vitest,
 * Jest, Mocha, cargo), `node --test` / TAP's `ℹ pass 5` / `# pass 5`, RSpec's
 * `5 examples, 0 failures`, PHPUnit's `OK (5 tests, …)` and `dotnet test`'s
 * `Passed:     5`.
 */
const PASS_COUNT_RES: readonly RegExp[] = [
  /(\d+)\s+pass(?:ed|ing)?\b/gi,
  /^[#ℹ]\s*pass\s+(\d+)\b/gim,
  /\b(\d+) examples?, 0 failures\b/g,
  /^OK \((\d+) tests?\b/gm,
  /\bPassed:\s+(\d+)/g,
];

/** Failing-test counts: the forms above, plus `Failed:` / PHPUnit's `Failures:`. */
const FAIL_COUNT_RES: readonly RegExp[] = [
  /(\d+)\s+fail(?:ed|ing|ures?)?\b/gi,
  /^[#ℹ]\s*fail\s+(\d+)\b/gim,
  /\b(?:Failed|Failures):\s+(\d+)/g,
];

/**
 * The largest count any of `res` finds anywhere in `output`, or null when none
 * matches. The largest rather than the first: `cargo test` prints one summary
 * per test binary, and a crate whose first binary holds no tests
 * (`test result: ok. 0 passed`) would otherwise read as a suite that ran
 * nothing, and a later binary's failure would be missed.
 */
function largestCount(output: string, res: readonly RegExp[]): number | null {
  let largest: number | null = null;
  for (const re of res) {
    for (const m of output.matchAll(re)) {
      const n = Number.parseInt(m[1] as string, 10);
      if (largest === null || n > largest) {
        largest = n;
      }
    }
  }
  return largest;
}

/**
 * Parse test runner output into a structured result.
 * Handles common output formats: Jest, Vitest, Mocha, pytest, cargo, `node
 * --test` / TAP, `go test`, unittest, RSpec, PHPUnit, `dotnet test`.
 *
 * `exitCode` is the test command's exit status when the caller knows it. A
 * non-zero exit is never a pass, whatever the output says. A zero exit is a
 * pass only with evidence that tests ran: a parsed count of at least one
 * passing test and no failures, or — for a runner that prints no count — one
 * of the `RAN_TESTS_RES` lines. Exit 0 alone is not enough: `--passWithNoTests`,
 * an empty test glob, or a `runTests` command of `echo ok` all exit 0 having
 * tested nothing, and the TDD loop must not stop on a suite that never ran.
 * A runner reporting that it found nothing — `No test files found`, `No tests
 * found`, pytest's `no tests ran`, unittest's `Ran 0 tests` — therefore fails
 * by carrying no evidence, with no list of such messages to keep complete.
 * Go's `[no test files]` for an untested package does not fail a run whose
 * other packages printed `ok` lines: that suite did run.
 */
export function parseTestOutput(
  output: string,
  durationMs: number,
  exitCode?: number
): TestRunResult {
  const passCount = largestCount(output, PASS_COUNT_RES);
  const failCount = largestCount(output, FAIL_COUNT_RES);
  const passing = passCount ?? 0;
  const failing = failCount ?? 0;
  const countsParsed = passCount !== null || failCount !== null;
  const ranTests = RAN_TESTS_RES.some((re) => re.test(output));

  let passed: boolean;
  if (exitCode !== undefined && exitCode !== 0) {
    passed = false;
  } else if (countsParsed) {
    passed = failing === 0 && passing > 0;
  } else if (exitCode === 0) {
    passed = ranTests;
  } else {
    passed = false;
  }

  return {
    duration_ms: durationMs,
    failing,
    passed,
    passing,
    stdout: output.slice(-10_000),
    total: passing + failing,
  };
}

/**
 * Parse a unified diff string into structured file change records.
 */
export function parseDiffToFileChanges(diff: string): FileChange[] {
  const files: FileChange[] = [];
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  for (const match of diff.matchAll(fileRegex)) {
    const path = match[2];
    const ext = path.split('.').pop() ?? '';
    const nextDiffIndex = diff.indexOf('diff --git', match.index + 1);
    const section = diff.slice(match.index, nextDiffIndex === -1 ? undefined : nextDiffIndex);
    const added = (section.match(/^\+[^+]/gm) || []).length;
    const removed = (section.match(/^-[^-]/gm) || []).length;
    const isNew = section.includes('new file mode');
    const isDeleted = section.includes('deleted file mode');

    files.push({
      language: ext,
      linesAdded: added,
      linesRemoved: removed,
      operation: isNew ? 'CREATE' : isDeleted ? 'DELETE' : 'MODIFY',
      path,
    });
  }
  return files;
}
