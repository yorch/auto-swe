/**
 * Test-integrity analysis of a unified diff: did a change reach green by deleting, skipping or
 * weakening tests rather than fixing the code under test? Pure and I/O-free — the CI-fix gate
 * (`worker/src/lib/testIntegrityGate.ts`) feeds it the fixer's diff and decides what to do with
 * the findings.
 *
 * This is a heuristic over diff text, not a parse of any language. It reads removed and added
 * lines per file and compares counts, so it has false positives (a legitimate consolidation of
 * tests) and false negatives (an assertion moved into a helper, a weakening it has no pattern
 * for). A clean result is "nothing this analyser recognises", never a proof. See
 * docs/ci-failure-triggers.md, "Test-integrity guard".
 */

/** The activity event the CI-fix gate records on a trip; the outcome report counts it per repository. */
export const TEST_INTEGRITY_GUARD_EVENT = 'ci_fix.test_integrity_guard';

export type TestIntegrityKind =
  | 'test_file_deleted'
  | 'test_case_removed'
  | 'skip_marker_added'
  | 'assertions_reduced'
  | 'assertion_trivialized'
  | 'assertion_loosened'
  | 'test_config_excludes'
  | 'coverage_threshold_lowered'
  | 'test_run_bypassed';

export interface TestIntegrityFinding {
  kind: TestIntegrityKind;
  file: string;
  /** Line in the new file of the first offending added line, when the finding has one. */
  line?: number;
  detail: string;
}

export interface TestIntegrityResult {
  findings: TestIntegrityFinding[];
  /** The findings list was cut at {@link MAX_FINDINGS}. */
  truncatedFindings: boolean;
  /** The diff was longer than {@link MAX_ANALYSED_DIFF_CHARS}; only its head was read. */
  truncatedDiff: boolean;
}

export const MAX_FINDINGS = 50;
export const MAX_ANALYSED_DIFF_CHARS = 4_000_000;

interface FileDiff {
  path: string;
  deleted: boolean;
  removed: string[];
  added: Array<{ line: number; text: string }>;
}

function stripPrefix(raw: string): string {
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, '');
}

/** Split a unified diff into per-file removed and added lines. Renames are read as the new path. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (.+?) (\S+)$/.exec(line);
      current = {
        added: [],
        deleted: false,
        path: stripPrefix(match?.[2] ?? line.slice('diff --git '.length)),
        removed: [],
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) {
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('deleted file mode')) {
        current.deleted = true;
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        current.path = stripPrefix(line.slice(4));
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      current.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      current.removed.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return files;
}

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)(tests?|spec|specs|e2e|integration-tests?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.(py|rb|php)$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb|rs|exs?)$/,
  /_spec\.rb$/,
  /(^|\/)[A-Z][A-Za-z0-9]*(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|swift)$/,
  /(^|\/)[A-Z][A-Za-z0-9]*(Test|Tests)\.(cs|php)$/,
  /\.feature$/,
];

/** Whether a path names a test file, by directory or file-name convention. */
export function isTestFilePath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((p) => p.test(path));
}

const TEST_CONFIG_PATTERNS: RegExp[] = [
  /(^|\/)(jest|vitest|vite|playwright|cypress|karma|babel)\.(config|workspace)\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.json$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|\.coveragerc|conftest\.py)$/,
  /(^|\/)(phpunit\.xml(\.dist)?|\.nycrc(\.json)?|codecov\.ya?ml|\.codecov\.ya?ml)$/,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/,
  /(^|\/)package\.json$/,
];

function isTestConfigPath(path: string): boolean {
  return TEST_CONFIG_PATTERNS.some((p) => p.test(path));
}

// A test case declaration, one match per case. Counted on removed and added lines of a test file;
// a renamed or rewritten test is one removal and one addition and so nets to zero.
const TEST_CASE_PATTERNS: RegExp[] = [
  /(?:^|[^\w.])(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|todo|fails))?\s*[(`]/gm,
  /^\s*(?:async\s+)?def\s+test_\w*/gm,
  /^\s*func\s+Test\w*\s*\(/gm,
  /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g,
  /#\[(?:tokio::)?test\b/g,
  /\[(?:Fact|Theory|Test|TestCase)\b/g,
  /^\s*(?:it|specify|scenario|example)\s+['"]/gm,
  /^\s*Scenario(?: Outline)?:/gm,
];

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let n = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    n += text.match(pattern)?.length ?? 0;
  }
  return n;
}

const SKIP_PATTERNS: RegExp[] = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo|fixme|fails)\b/g,
  /\b(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/g,
  /\b(?:it|test|describe)\.only\s*\(/g,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bpytest\.(?:skip|xfail)\s*\(/g,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
  /\bself\.skipTest\s*\(/g,
  /@(?:Ignore|Disabled|DisabledIf\w*|DisabledOn\w*)\b/g,
  /\bt\.Skip(?:f|Now)?\s*\(/g,
  /#\[ignore\b/g,
  /\bSkip\s*=\s*["']/g,
  /^\s*(?:skip|pending|xit|xdescribe)\b(?:\s+['"(]|\s*$)/gm,
];

// Assertions, counted per occurrence. Deliberately broad across languages: the signal is the net
// change in a test file, not what any one line is.
const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\s*\(/g,
  /\bexpect\s*!?\s*\{/g,
  /\bassert[A-Za-z_]*!?\s*[(.]/g,
  /^\s*assert\s+\S/gm,
  /\brequire\.[A-Za-z]+\s*\(/g,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/g,
  /\.should(?:\.|\()/g,
  /\bshould_receive\b|\bshould\s+(?:eq|be|have)\b/g,
  /\bverify\s*\(/g,
];

// Assertions that hold whatever the code does.
const TRIVIAL_ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:not\s*\.\s*)?(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeDefined)\b/,
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/,
  /^\s*assert\s*\(?\s*(?:True|true|1)\s*\)?\s*;?\s*(?:#.*)?$/,
  /^\s*assert\s+(\w+|\d+)\s*==\s*\1\s*(?:#.*)?$/,
  /\b(?:self\.)?assert(?:True|That)\s*\(\s*(?:True|true)\s*\)/,
  /\b(?:self\.)?assertEquals?\s*\(\s*(\w+|\d+|"[^"]*"|'[^']*')\s*,\s*\1\s*\)/,
  /\bassert\.(?:ok|true|isTrue)\s*\(\s*(?:true|1)\s*\)/,
  /\bassert!\s*\(\s*true\s*\)/,
];

// Matchers that pass for almost any value; swapped in for a specific one they loosen a test.
const WEAK_ASSERTION_PATTERNS: RegExp[] = [
  /\.\s*(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(\s*\)/g,
  /\.\s*not\s*\.\s*(?:toBeNull|toBeUndefined|toThrow)\s*\(/g,
  /\bexpect\.(?:anything|any)\s*\(/g,
  /\bassert(?:NotNull|NotEmpty|IsNotNone)\s*\(/g,
  /\bassert\s+\w[\w.()]*\s+is\s+not\s+None\b/g,
  /\bassertIsNotNone\s*\(/g,
  /\.toThrow\s*\(\s*\)/g,
];

const TEST_IGNORE_PATTERNS: RegExp[] = [
  /\btestPathIgnorePatterns\b/g,
  /\btestIgnore\b/g,
  /\btestPathIgnore\b/g,
  /\bnorecursedirs\b/g,
  /\bcollect_ignore(?:_glob)?\b/g,
  /--(?:ignore|ignore-glob|deselect)\b/g,
  /\s-k\s+['"]?not\b/g,
  /\b(?:test|tests)\s*:\s*\{[^}]*\bexclude\b/g,
  /\bexclude\s*:\s*\[/g,
  /\bexcludes?\b\s*[:=]/g,
  /<exclude>/g,
  /\bexclude\s+['"]/g,
  /\bskipTests\b|-DskipTests|-Dmaven\.test\.skip/g,
  /\benabled\s*=\s*false\b/g,
  /\bwatchPathIgnorePatterns\b/g,
];

const THRESHOLD_KEY =
  /\b(branches|functions|lines|statements|fail[_-]under|cov-fail-under|threshold|minimum|minimumCoverage)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/g;
const THRESHOLD_CLI = /--cov-fail-under[= ](\d+(?:\.\d+)?)/g;

const TEST_BYPASS_PATTERNS: RegExp[] = [
  /--passWithNoTests\b/g,
  /(?:\bjest|\bvitest|\bpytest|\bgo test|\bmvn\b[^\n|]*\btest|\b(?:npm|yarn|pnpm)(?: run)? test)\b[^\n|]*\|\|\s*(?:true|exit 0|:)\b/g,
];

function firstLine(file: FileDiff, patterns: readonly RegExp[]): number | undefined {
  for (const added of file.added) {
    if (countMatches(added.text, patterns) > 0) {
      return added.line;
    }
  }
  return undefined;
}

function thresholds(lines: readonly string[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const push = (key: string, value: number) => {
    const list = found.get(key) ?? [];
    list.push(value);
    found.set(key, list);
  };
  for (const text of lines) {
    THRESHOLD_KEY.lastIndex = 0;
    for (const m of text.matchAll(THRESHOLD_KEY)) {
      push((m[1] as string).replace(/[_-]/g, ''), Number(m[2]));
    }
    THRESHOLD_CLI.lastIndex = 0;
    for (const m of text.matchAll(THRESHOLD_CLI)) {
      push('failunder', Number(m[1]));
    }
  }
  return found;
}

function analyseFile(file: FileDiff): TestIntegrityFinding[] {
  const findings: TestIntegrityFinding[] = [];
  const add = (kind: TestIntegrityKind, detail: string, line?: number) => {
    findings.push({ detail, file: file.path, kind, ...(line !== undefined ? { line } : {}) });
  };
  const removedText = file.removed.join('\n');
  const addedText = file.added.map((a) => a.text).join('\n');

  if (isTestFilePath(file.path)) {
    if (file.deleted) {
      add(
        'test_file_deleted',
        `test file deleted (${countMatches(removedText, TEST_CASE_PATTERNS)} test case(s) in it)`
      );
      return findings;
    }
    const casesRemoved = countMatches(removedText, TEST_CASE_PATTERNS);
    const casesAdded = countMatches(addedText, TEST_CASE_PATTERNS);
    if (casesRemoved > casesAdded) {
      add(
        'test_case_removed',
        `${casesRemoved - casesAdded} more test case(s) removed than added (${casesRemoved} removed, ${casesAdded} added)`
      );
    }

    const skipsAdded = countMatches(addedText, SKIP_PATTERNS);
    const skipsRemoved = countMatches(removedText, SKIP_PATTERNS);
    if (skipsAdded > skipsRemoved) {
      add(
        'skip_marker_added',
        `${skipsAdded - skipsRemoved} more skip, focus or expected-failure marker(s) added than removed`,
        firstLine(file, SKIP_PATTERNS)
      );
    }

    const assertionsRemoved = countMatches(removedText, ASSERTION_PATTERNS);
    const assertionsAdded = countMatches(addedText, ASSERTION_PATTERNS);
    if (assertionsRemoved > assertionsAdded) {
      add(
        'assertions_reduced',
        `net ${assertionsRemoved - assertionsAdded} fewer assertion(s) (${assertionsRemoved} removed, ${assertionsAdded} added)`
      );
    }

    const trivialAdded = file.added.filter((a) =>
      TRIVIAL_ASSERTION_PATTERNS.some((p) => p.test(a.text))
    );
    const trivialRemoved = file.removed.filter((r) =>
      TRIVIAL_ASSERTION_PATTERNS.some((p) => p.test(r))
    ).length;
    if (trivialAdded.length > trivialRemoved) {
      add(
        'assertion_trivialized',
        `${trivialAdded.length - trivialRemoved} assertion(s) that hold whatever the code does (e.g. \`${(trivialAdded[0] as { text: string }).text.trim().slice(0, 80)}\`)`,
        (trivialAdded[0] as { line: number }).line
      );
    }

    const weakAdded = countMatches(addedText, WEAK_ASSERTION_PATTERNS);
    const weakRemoved = countMatches(removedText, WEAK_ASSERTION_PATTERNS);
    // Specific assertions lost on net, and weak ones gained on net: the former became the latter.
    const strongLost = assertionsRemoved - weakRemoved - (assertionsAdded - weakAdded);
    const weakened = weakAdded - weakRemoved;
    if (weakened > 0 && strongLost >= weakened) {
      add(
        'assertion_loosened',
        `${weakened} specific assertion(s) replaced by a weak matcher (toBeDefined, toBeTruthy, assertNotNull, …)`,
        firstLine(file, WEAK_ASSERTION_PATTERNS)
      );
    }
  }

  if (isTestConfigPath(file.path)) {
    const ignoreAdded = countMatches(addedText, TEST_IGNORE_PATTERNS);
    const ignoreRemoved = countMatches(removedText, TEST_IGNORE_PATTERNS);
    if (ignoreAdded > ignoreRemoved) {
      add(
        'test_config_excludes',
        `${ignoreAdded - ignoreRemoved} more test exclusion/ignore setting(s) added than removed`,
        firstLine(file, TEST_IGNORE_PATTERNS)
      );
    }
    const before = thresholds(file.removed);
    const after = thresholds(file.added.map((a) => a.text));
    const lowered: string[] = [];
    for (const [key, oldValues] of before) {
      const newValues = after.get(key);
      const oldMax = Math.max(...oldValues);
      if (!newValues) {
        lowered.push(`${key} ${oldMax} removed`);
      } else if (Math.min(...newValues) < oldMax) {
        lowered.push(`${key} ${oldMax} -> ${Math.min(...newValues)}`);
      }
    }
    if (lowered.length > 0) {
      add('coverage_threshold_lowered', `coverage threshold lowered: ${lowered.join(', ')}`);
    }
  }

  // A test command that cannot fail, in any file a fixer might change (scripts, Makefiles, CI).
  if (
    countMatches(addedText, TEST_BYPASS_PATTERNS) > countMatches(removedText, TEST_BYPASS_PATTERNS)
  ) {
    add(
      'test_run_bypassed',
      'a test command was changed so that it cannot fail (--passWithNoTests, `|| true`)',
      firstLine(file, TEST_BYPASS_PATTERNS)
    );
  }
  return findings;
}

/**
 * Findings for one unified diff (`git diff`, no context needed). An empty list means the analyser
 * recognised nothing, not that the tests are intact.
 */
export function analyseTestIntegrity(diff: string): TestIntegrityResult {
  const truncatedDiff = diff.length > MAX_ANALYSED_DIFF_CHARS;
  const all = parseUnifiedDiff(
    truncatedDiff ? diff.slice(0, MAX_ANALYSED_DIFF_CHARS) : diff
  ).flatMap(analyseFile);
  return {
    findings: all.slice(0, MAX_FINDINGS),
    truncatedDiff,
    truncatedFindings: all.length > MAX_FINDINGS,
  };
}

/** One line per finding, for an error message or a log. */
export function summariseTestIntegrity(findings: readonly TestIntegrityFinding[]): string {
  return findings
    .map((f) => `${f.kind} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}`)
    .join('\n');
}
