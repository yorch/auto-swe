import { detectedGateDefaults, detectedRootStack } from '@auto-swe/shared/lib/stackDetection';
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
 * The same chain as the `runTests` quality gate, so the loop and the gate never
 * run different commands: the repository's configured
 * `Connection.gateCommands.runTests` wins; then the default for the stack the
 * repository's root was detected as (a Python, JVM or Go root, not Node); then a guess from
 * package.json's scripts and devDependencies, falling back to `npm test`.
 */
export function detectTestCommand(
  packageJsonStr: string,
  gateCommands?: unknown,
  detectedStack?: unknown
): string {
  const configured =
    gateCommands && typeof gateCommands === 'object'
      ? (gateCommands as Record<string, unknown>).runTests
      : undefined;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  // A Node root is not given its package manager's `npm test`: the package.json
  // guess below is better informed (a missing test script, a vitest dependency).
  const stackTests =
    detectedRootStack(detectedStack) === 'node'
      ? undefined
      : detectedGateDefaults(detectedStack)?.runTests;
  if (stackTests) {
    return stackTests;
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
 * npm's one well-known "no such script" message, from either its `error` or `ERR!` prefix, and
 * the exit status npm uses for it (1). Both are required, and the line is anchored to the start
 * of a line: a suite that itself runs `npm test` in a fixture directory prints the same line
 * (indented or after a reporter prefix) and then fails on an assertion, which is an ordinary
 * failure the agent can fix.
 */
const NPM_MISSING_TEST_SCRIPT_STATUS = 1;
const NPM_MISSING_TEST_SCRIPT = /^npm (?:error|ERR!) Missing script: "test"/m;

/**
 * What npm 11 prints when the directory has no package.json, as the fallback
 * `npm test` meets in a repository that is not a Node project, and the exit
 * status it uses (254). Both are required. A suite that itself runs npm in an
 * empty directory prints the same line, un-indented, and then fails on an
 * assertion with exit 1; the status tells the two apart. The line is also
 * anchored to the start of a line and to npm's own prefix and exact message, so
 * output that merely mentions ENOENT or package.json does not match. Only the
 * `error` prefix is accepted: the older `ERR!` form's exit status is unverified.
 */
const NPM_NO_PACKAGE_JSON_STATUS = 254;
const NPM_NO_PACKAGE_JSON = /^npm error enoent Could not read package\.json: Error: ENOENT/m;

/**
 * Why a rejected test run could not run in this workspace at all, or
 * `undefined` for an ordinary failure (tests ran and failed, a timeout, an
 * unknown error). The string is the classifier's truth and the text reported
 * in the trace and notes, so the two cannot drift. Two signals, deliberately
 * narrow:
 *
 * - exit status 127 (command not found) or 126 (found, not executable). The
 *   status is read from `code` (what `child_process.exec` sets) or `status`
 *   (the `execSync` shape). Output text is never searched for "not found",
 *   because a runner's own output can say that about a test's subprocess.
 * - npm's `Missing script: "test"` message at the start of a line with exit 1.
 * - npm's no-package.json message with exit 254 (see `NPM_NO_PACKAGE_JSON`).
 *
 * A caller that stops on this accepts a trade-off: a missing local tool (a
 * runner the platform never installed) also exits 127 and a further agent pass
 * might have installed it. The implementer already runs the tests itself in
 * its first pass, so a second pass rarely changes the outcome, while a wasted
 * pass costs a whole budget and the diff is still committed and reviewed.
 */
export function unrunnableTestCause(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const e = err as { code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
  const exitStatus = typeof e.code === 'number' ? e.code : e.status;
  if (exitStatus === 127) {
    return 'exit status 127: command not found';
  }
  if (exitStatus === 126) {
    return 'exit status 126: command not executable';
  }
  const output = [e.stdout, e.stderr].filter((v): v is string => typeof v === 'string').join('\n');
  if (exitStatus === NPM_MISSING_TEST_SCRIPT_STATUS && NPM_MISSING_TEST_SCRIPT.test(output)) {
    return 'npm reports Missing script: "test"';
  }
  return exitStatus === NPM_NO_PACKAGE_JSON_STATUS && NPM_NO_PACKAGE_JSON.test(output)
    ? 'npm reports no package.json in the workspace'
    : undefined;
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
