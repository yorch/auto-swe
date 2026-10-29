import {
  COMPONENT_MARKER_RE,
  compositeComponentCount,
  detectedGateDefaults,
  detectedTarget,
  detectedTargetDir,
  inDir,
  PYTEST_NO_TESTS_STATUS,
} from '@auto-swe/shared/lib/stackDetection';
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
 * The same chain as the `runTests` quality gate, so the loop and the gate run the same
 * command wherever both have one (a layout the composite cannot cover — over 8 components, or
 * components that do not all have a test command — leaves the gate unconfigured and the loop on
 * its root guess, which then ends the loop as unrunnable): the repository's configured
 * `Connection.gateCommands.runTests` wins; then the default for the stack the
 * repository's root was detected as (a Python, JVM or Go root, not Node), or its only component
 * when the root has no stack (run in that directory), or the composite that runs the tests in
 * each of 2..8 components; then a guess from package.json's scripts
 * and devDependencies, falling back to `npm test`. `packageJsonStr` is the text of the target's
 * `package.json` — {@link packageJsonReadCommand} reads the right one — and a guess for a
 * component runs in its directory too.
 */
export function detectTestCommand(
  packageJsonStr: string,
  gateCommands?: unknown,
  detectedStack?: unknown
): string {
  return resolveTestCommand(packageJsonStr, gateCommands, detectedStack).command;
}

/** Where the test command came from: an admin, the detected stack, or the package.json guess. */
export type TestCommandSource = 'configured' | 'stack' | 'node-guess';

/**
 * The test command {@link detectTestCommand} returns and the link in its chain that supplied
 * it. The precedence lives here only: {@link testCommandSource} reads the same chain.
 */
function resolveTestCommand(
  packageJsonStr: string,
  gateCommands?: unknown,
  detectedStack?: unknown
): { command: string; source: TestCommandSource } {
  const configured =
    gateCommands && typeof gateCommands === 'object'
      ? (gateCommands as Record<string, unknown>).runTests
      : undefined;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return { command: configured, source: 'configured' };
  }
  // A Node target is not given its package manager's `npm test`: the package.json
  // guess below is better informed (a missing test script, a vitest dependency).
  const target = detectedTarget(detectedStack);
  const concrete = target !== null && target !== 'ambiguous' ? target : null;
  // An ambiguous layout of 2..8 components resolves to the composite `runTests`.
  const stackTests =
    target === 'ambiguous' || (concrete !== null && concrete.stack !== 'node')
      ? detectedGateDefaults(detectedStack)?.runTests
      : undefined;
  if (stackTests) {
    return { command: stackTests, source: 'stack' };
  }
  return {
    command: inDir(concrete?.dir ?? '', detectTestCommandFromPackageJson(packageJsonStr)),
    source: 'node-guess',
  };
}

/** Which link of {@link detectTestCommand}'s chain would supply the command for these inputs. */
export function testCommandSource(
  packageJsonStr: string,
  gateCommands?: unknown,
  detectedStack?: unknown
): TestCommandSource {
  return resolveTestCommand(packageJsonStr, gateCommands, detectedStack).source;
}

/**
 * The shell command that prints the `package.json` {@link detectTestCommand} should read: the
 * root's, or the target component's when the root has no stack. The directory is a
 * re-validated path from a stored detection, quoted.
 */
export function packageJsonReadCommand(detectedStack: unknown): string {
  const dir = detectedTargetDir(detectedStack);
  return `cat ${dir ? `'${dir}/package.json'` : 'package.json'} 2>/dev/null || echo "{}"`;
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
 * `none-collected`: the runner looked for tests and found none (pytest's exit 5).
 * `unreadable`: the run exited 0 but its output carries nothing `parseTestOutput` can read, so
 * whether tests ran is unknown (`go test`'s `[no test files]`, a Gradle build whose `test` task
 * was up to date, or one component of a composite whose output showed none).
 */
export type NoTestsKind = 'none-collected' | 'unreadable';

/**
 * Why a run of a stack-derived test command shows no tests, or `undefined`. Such a command in
 * an image that has the toolchain is not unrunnable (`unrunnableTestCause`) yet the loop would
 * otherwise spend every remaining agent pass on it. Two signals, both narrow: a rejected run
 * with pytest's exit status 5 (among the shipped stack defaults only pytest exits 5), and a
 * run that exited 0 with no counts and no evidence that tests ran. A rejected run with any other
 * status (a collection or compile error, real failures) is not matched: the agent can fix it. A
 * configured or package.json command never matches, so their behaviour is unchanged.
 *
 * Stopping is a deliberate trade-off, not a claim that no later pass could help: after exit 5
 * the agent could add a test file, but the implementer already runs the tests itself in its
 * first pass, so a further pass costs a whole budget for a rarely different outcome, and the
 * diff is still committed and reviewed.
 */
export function noTestsFoundCause(
  source: TestCommandSource,
  outcome: { error: unknown } | { result: TestRunResult }
): { kind: NoTestsKind; reason: string } | undefined {
  if (source !== 'stack') {
    return undefined;
  }
  if ('result' in outcome) {
    const r = outcome.result;
    // The run resolved, so it exited 0; not passed with nothing failing means some run showed no
    // tests. For a single run that is `total === 0` too (passed would be true with any count and
    // no failure); for a composite it can be one component whose output showed none beside
    // another's `12 passed`, which is just as little a failure the agent can fix.
    return !r.passed && r.failing === 0
      ? { kind: 'unreadable', reason: 'the run exited 0 but printed no test counts' }
      : undefined;
  }
  const e = outcome.error as { code?: unknown; status?: unknown } | null;
  const status = typeof e?.code === 'number' ? e.code : e?.status;
  return status === PYTEST_NO_TESTS_STATUS
    ? { kind: 'none-collected', reason: 'exit status 5: no tests ran' }
    : undefined;
}

/**
 * The notes sentence for a stopped run. `stoppedAfterRun` is the 1-based test run that ended
 * the TDD loop; leave it out in a fix session, which has one test run and no loop.
 */
export function noTestsFoundNotes(
  command: string,
  kind: NoTestsKind,
  stoppedAfterRun?: number
): string {
  const loop =
    stoppedAfterRun === undefined ? '' : `the TDD loop stopped after test run ${stoppedAfterRun}`;
  if (kind === 'none-collected') {
    return `The test command \`${command}\` found no tests to run${loop ? `, so ${loop}` : ''}; set \`runTests\` for this repository.`;
  }
  return `The test command \`${command}\` exited 0 but printed no test counts, so whether tests ran could not be determined${loop ? `; ${loop}.` : '.'} Set \`runTests\` for this repository for a command whose output can be read.`;
}

/** The activity event naming a stopped run: one per kind, so a trace says which. */
export function noTestsFoundEvent(
  kind: NoTestsKind
): 'tdd.no_tests_found' | 'tdd.tests_unreadable' {
  return kind === 'none-collected' ? 'tdd.no_tests_found' : 'tdd.tests_unreadable';
}

/** The result recorded when no test results exist to read: not a failure, nothing ran. */
export function noTestsRunResult(stdout: string): TestRunResult {
  return { duration_ms: 0, failing: 0, passed: false, passing: 0, stdout, total: 0 };
}

/**
 * How notes and the PR body word a test result. `not run` is a result with no counts and no
 * failures: nothing was read. The unrunnable shape (`failing: 1, total: 0`) stays `failing`.
 */
export function testStatusWord(result: TestRunResult): 'passing' | 'failing' | 'not run' {
  if (result.passed) {
    return 'passing';
  }
  // Not passed with nothing failing is "not run": for a single run `total` is 0 as well, and a
  // composite where one component showed no tests beside another's green run is the same state.
  return result.failing === 0 ? 'not run' : 'failing';
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
  // Gradle names a task it executed; `UP-TO-DATE` and `NO-SOURCE` follow the name on their line,
  // so a test task that did nothing does not match.
  /^> Task :(?:[\w.-]+:)*test$/m,
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
  const sections = splitComponentSections(output);
  if (sections) {
    // A composite run: every component must show its own evidence, and the counts add up.
    const scans = sections.map((s) => scanSection(s.body, exitCode));
    const passing = scans.reduce((n, s) => n + s.passing, 0);
    const failing = scans.reduce((n, s) => n + s.failing, 0);
    return {
      duration_ms: durationMs,
      failing,
      passed: (exitCode === undefined || exitCode === 0) && scans.every((s) => s.ok),
      passing,
      stdout: boundTestOutput(output),
      total: passing + failing,
    };
  }
  const { failing, ok, passing } = scanSection(output, exitCode);
  return {
    duration_ms: durationMs,
    failing,
    passed: exitCode !== undefined && exitCode !== 0 ? false : ok,
    passing,
    stdout: boundTestOutput(output),
    total: passing + failing,
  };
}

/**
 * Maven Surefire's `Tests run: N, Failures: F, Errors: E, Skipped: S` lines, as counts. It prints
 * one per test class and a total, so the line with the most tests is the total. `mvn -q` prints
 * none, which is why the default test command is not quiet. Passing is N minus F, E and S.
 */
function surefireCounts(output: string): { passing: number; failing: number } | null {
  let best: { run: number; failing: number; passing: number } | null = null;
  for (const m of output.matchAll(
    /Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/g
  )) {
    const run = Number(m[1]);
    const failing = Number(m[2]) + Number(m[3]);
    if (best === null || run > best.run) {
      best = { failing, passing: Math.max(run - failing - Number(m[4] ?? 0), 0), run };
    }
  }
  return best;
}

/** One run's (or one component's) counts, and whether they show that tests ran and none failed. */
function scanSection(
  output: string,
  exitCode?: number
): { passing: number; failing: number; ok: boolean } {
  const surefire = surefireCounts(output);
  const passCount = largestCount(output, PASS_COUNT_RES);
  const failCount = largestCount(output, FAIL_COUNT_RES);
  const passing = Math.max(passCount ?? 0, surefire?.passing ?? 0);
  const failing = Math.max(failCount ?? 0, surefire?.failing ?? 0);
  const countsParsed = passCount !== null || failCount !== null || surefire !== null;
  const ranTests = RAN_TESTS_RES.some((re) => re.test(output));
  const ok = countsParsed ? failing === 0 && passing > 0 : exitCode === 0 && ranTests;
  return { failing, ok, passing };
}

/**
 * A composite command's output split at its marker lines, or null when it has fewer than two (a
 * single run, which parses and truncates exactly as it always has). `marker` is the line itself.
 */
function splitComponentSections(output: string): Array<{ marker: string; body: string }> | null {
  const markers = [...output.matchAll(COMPONENT_MARKER_RE)];
  if (markers.length < 2) {
    return null;
  }
  return markers.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length + 1;
    const end = markers[i + 1]?.index ?? output.length;
    return { body: output.slice(start, end), marker: m[0] };
  });
}

const TEST_OUTPUT_BUDGET = 10_000;

/**
 * Test output bounded for what the agent is shown: the last `budget` characters of a single run;
 * for a composite run an even share (`floor(budget / sections)`) per component, each keeping its
 * marker line and its last characters, in order, so every component's failure is represented.
 */
export function boundTestOutput(output: string, budget = TEST_OUTPUT_BUDGET): string {
  const sections = splitComponentSections(output);
  // More sections than a composite has (the command itself covers at most 8), or markers too long
  // to leave each a share, is not a composite's output but something printing marker lines: bound
  // it like a single run, so the result never exceeds the budget.
  if (!sections || sections.length > 8) {
    return output.slice(-budget);
  }
  const share = Math.floor(budget / sections.length);
  if (sections.some(({ marker }) => marker.length + 2 > share)) {
    return output.slice(-budget);
  }
  return sections
    .map(({ body, marker }) => {
      const room = share - marker.length - 1;
      const tail = room > 0 ? body.slice(-room) : '';
      return `${marker}\n${tail}${tail === '' || tail.endsWith('\n') ? '' : '\n'}`;
    })
    .join('');
}

/**
 * The wall-clock cap for a test command: {@link TEST_RUN_TIMEOUT_MS}, times the number of
 * components a composite command runs, at most 4x — the components share one run's budget.
 */
export function testRunTimeoutMs(command: string): number {
  return TEST_RUN_TIMEOUT_MS * Math.min(Math.max(compositeComponentCount(command), 1), 4);
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
