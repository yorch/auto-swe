/**
 * Test-integrity analysis of a unified diff: did a change reach green by deleting, skipping or
 * weakening tests rather than fixing the code under test? Pure and I/O-free — the fix-session gate
 * (`worker/src/lib/testIntegrityGate.ts`) feeds it the fixer's diff and decides what to do with
 * the findings.
 *
 * This is a heuristic over diff text, not a parse of any language. It reads removed and added
 * lines, ignores comment-only lines, and compares counts across the WHOLE diff (so a test moved to
 * another file nets to zero), with false positives (a legitimate consolidation of tests) and false
 * negatives (an assertion moved into a helper, a weakening it has no pattern for). A clean result is
 * "nothing this analyser recognises", never a proof. See docs/ci-failure-triggers.md, "Test-integrity
 * guard".
 */

/** The activity event the fix-session gate records on a trip; the outcome report counts it per repository. */
export const TEST_INTEGRITY_GUARD_EVENT = 'ci_fix.test_integrity_guard';

export type TestIntegrityKind =
  | 'test_file_deleted'
  | 'test_file_unreadable'
  | 'test_support_deleted'
  | 'snapshot_updated'
  | 'test_case_removed'
  | 'skip_marker_added'
  | 'assertions_reduced'
  | 'assertion_trivialized'
  | 'assertion_loosened'
  | 'test_config_excludes'
  | 'test_config_narrowed'
  | 'coverage_threshold_lowered'
  | 'test_run_bypassed'
  | 'test_command_changed'
  | 'ci_config_weakened'
  | 'gitattributes_changed';

/**
 * `high` findings are the ones `block` mode refuses a change for. `low` ones are recorded (and
 * reported) but never block: they are signals with many legitimate causes (a regenerated
 * snapshot, a deleted fixture).
 */
export type TestIntegritySeverity = 'high' | 'low';

export interface TestIntegrityFinding {
  kind: TestIntegrityKind;
  severity: TestIntegritySeverity;
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

// ── Generated and lock files ──────────────────────────────────────────────────────────────────

/** File names that are generated, so their diff says nothing about tests and can be huge. */
export const GENERATED_BASENAMES: readonly string[] = [
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'gradle.lockfile',
  'pubspec.lock',
  'Podfile.lock',
  'flake.lock',
];

/** Glob suffixes of generated output. */
export const GENERATED_GLOBS: readonly string[] = ['*.min.js', '*.min.css'];

/**
 * The `git diff` pathspec arguments (unquoted) that leave generated files out of the diff the
 * analyser reads, so a lockfile-regenerating fix does not push the diff past the size cap.
 */
export function generatedPathspecs(): string[] {
  return [
    ...GENERATED_BASENAMES.map((n) => `:(exclude,glob)**/${n}`),
    ...GENERATED_GLOBS.map((g) => `:(exclude,glob)**/${g}`),
  ];
}

/** Whether a path is a generated file the analyser skips. */
export function isGeneratedPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return GENERATED_BASENAMES.includes(base) || /\.min\.(?:js|css)$/.test(base);
}

// ── Diff parsing ──────────────────────────────────────────────────────────────────────────────

interface FileDiff {
  path: string;
  /** The path before a rename; equals `path` otherwise. */
  oldPath: string;
  deleted: boolean;
  isNew: boolean;
  renamed: boolean;
  /** The diff has a `Binary files … differ` or `GIT binary patch` stanza for this file. */
  binary: boolean;
  removed: string[];
  added: Array<{ line: number; text: string }>;
}

function stripPrefix(raw: string): string {
  const tabless = raw.replace(/\t.*$/, '');
  const unquoted =
    tabless.startsWith('"') && tabless.endsWith('"') ? tabless.slice(1, -1) : tabless;
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * Split a unified diff into per-file removed and added lines. A rename (`--find-renames`) is one
 * file: `path` is the new path and `oldPath` the old.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      // Best effort: the ---/+++/rename lines below are authoritative (a path may hold spaces).
      const match = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest);
      const oldPath = stripPrefix(match?.[1] ? `a/${match[1]}` : (rest.split(' ')[0] ?? rest));
      const path = stripPrefix(
        match?.[2] ? `b/${match[2]}` : (rest.split(' ').slice(-1)[0] ?? rest)
      );
      current = {
        added: [],
        binary: false,
        deleted: false,
        isNew: false,
        oldPath,
        path,
        removed: [],
        renamed: false,
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
      } else if (line.startsWith('new file mode')) {
        current.isNew = true;
      } else if (line.startsWith('rename from ')) {
        current.oldPath = stripPrefix(line.slice('rename from '.length));
        current.renamed = true;
      } else if (line.startsWith('rename to ')) {
        current.path = stripPrefix(line.slice('rename to '.length));
        current.renamed = true;
      } else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        current.oldPath = stripPrefix(line.slice(4));
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        current.path = stripPrefix(line.slice(4));
      } else if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
        current.binary = true;
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

// ── Path classification ───────────────────────────────────────────────────────────────────────

/** Directory segments that hold fixtures and helpers rather than tests. */
const SUPPORT_DIR = '(?:__?fixtures?__?|fixtures?|helpers?|__mocks__|mocks?|utils?|support|data)';

/** File names that a test runner collects as tests. */
const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.(py|rb|php)$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb|rs|exs?|php|dart)$/,
  /_spec\.rb$/,
  /(^|\/)[A-Z][A-Za-z0-9]*(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|swift)$/,
  /(^|\/)[A-Z][A-Za-z0-9]*(Test|Tests)\.(cs|php)$/,
  /\.feature$/,
  // Jest collects every script under __tests__; mocha every script under test/.
  new RegExp(`(^|/)__tests__/(?!(?:.*/)?${SUPPORT_DIR}/)[^/]+\\.[cm]?[jt]sx?$`),
  new RegExp(`(^|/)__tests__/(?!(?:.*/)?${SUPPORT_DIR}/)(?:.+/)[^/]+\\.[cm]?[jt]sx?$`),
  new RegExp(`(^|/)tests?/(?!(?:.*/)?${SUPPORT_DIR}/)(?:.+/)?[^/]+\\.[cm]?js$`),
];

/**
 * Whether a path names a test source file a runner collects, by file-name convention. Fixtures and
 * helpers under a `test/` or `tests/` directory are not (see {@link isTestSupportPath}): deleting
 * `tests/fixtures/old.json` is not deleting a test.
 */
export function isTestFilePath(path: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(path));
}

/** A fixture, helper, mock or snapshot that belongs to the tests but is not itself a test. */
export function isTestSupportPath(path: string): boolean {
  if (isTestFilePath(path)) {
    return false;
  }
  return (
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)(tests?|spec|specs|e2e|integration-tests?)\//i.test(path) ||
    /(^|\/)__snapshots__\//.test(path) ||
    /\.snap$/.test(path) ||
    /(^|\/)conftest\.py$/.test(path)
  );
}

const TEST_CONFIG_PATTERNS: RegExp[] = [
  /(^|\/)(jest|vitest|vite|playwright|cypress|karma|mocha|ava|babel)[\w.-]*\.(config|workspace)(\.[\w-]+)*\.[cm]?[jt]s$/,
  /(^|\/)(jest|vitest|playwright)[\w.-]*\.config(\.[\w-]+)*\.json$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|\.coveragerc|conftest\.py)$/,
  /(^|\/)(phpunit\.xml(\.dist)?|\.nycrc(\.json)?|codecov\.ya?ml|\.codecov\.ya?ml)$/,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[\w.-]*\.json$/,
];

/** A configuration file that configures only a test runner, so any exclusion in it is about tests. */
function isPureTestConfig(path: string): boolean {
  return (
    /(^|\/)(jest|vitest|playwright|cypress|karma|mocha|ava)[\w.-]*\.(config|workspace)(\.[\w-]+)*\.[cm]?[jt]s(on)?$/.test(
      path
    ) ||
    /(^|\/)(\.mocharc(\.[a-z]+)?|pytest\.ini|phpunit\.xml(\.dist)?|\.nycrc(\.json)?)$/.test(path)
  );
}

function isTestConfigPath(path: string): boolean {
  return TEST_CONFIG_PATTERNS.some((p) => p.test(path));
}

const CI_CONFIG_PATTERN =
  /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.yml|Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.yml|bitbucket-pipelines\.yml)$/;

function isRustSource(path: string): boolean {
  return /\.rs$/.test(path);
}

function isGitattributes(path: string): boolean {
  return /(^|\/)\.gitattributes$/.test(path) || /(^|\/)\.git\/info\/attributes$/.test(path);
}

// ── Comment handling ──────────────────────────────────────────────────────────────────────────

interface CommentStyle {
  slash: boolean;
  hash: boolean;
}

function commentStyle(path: string): CommentStyle {
  if (/\.(py|rb|toml|ya?ml|sh|cfg|ini|exs?|feature)$/.test(path) || /Makefile$/.test(path)) {
    return { hash: true, slash: false };
  }
  if (/\.(json|jsonc)$/.test(path)) {
    return { hash: false, slash: true };
  }
  return { hash: true, slash: true };
}

/** Index of `token` in `text` at or after `from`, outside a quoted string; -1 when none. */
function indexOutsideString(text: string, token: string, from = 0): number {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (i >= from && text.startsWith(token, i)) {
      return i;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    }
  }
  return -1;
}

/**
 * The code of each line with comments removed: a comment-only line becomes empty, so commenting a
 * test or an assertion out counts as removing it, and deleting a comment is not an edit to a test.
 * Block comments are tracked across the lines given; `#[` and `#!` (Rust attributes) are not
 * comments. A heuristic: it knows nothing of template literals or regular expressions.
 */
function stripComments(lines: readonly string[], style: CommentStyle): string[] {
  let inBlock = false;
  return lines.map((original) => {
    let s = original;
    if (inBlock) {
      const end = s.indexOf('*/');
      if (end < 0) {
        return '';
      }
      s = s.slice(end + 2);
      inBlock = false;
    }
    if (style.slash) {
      if (/^\s*\*(?!\/)(\s|$)/.test(s)) {
        return '';
      }
      for (let from = 0; ; ) {
        const open = indexOutsideString(s, '/*', from);
        if (open < 0) {
          break;
        }
        const close = s.indexOf('*/', open + 2);
        if (close < 0) {
          s = s.slice(0, open);
          inBlock = true;
          break;
        }
        s = `${s.slice(0, open)} ${s.slice(close + 2)}`;
        from = open;
      }
      const line = indexOutsideString(s, '//');
      if (line >= 0) {
        s = s.slice(0, line);
      }
    }
    if (style.hash) {
      const hash = indexOutsideString(s, '#');
      if (hash >= 0 && !/^[[!]/.test(s.slice(hash + 1, hash + 2))) {
        s = s.slice(0, hash);
      }
    }
    return s.trim() === '' ? '' : s;
  });
}

// ── Patterns ──────────────────────────────────────────────────────────────────────────────────

// A test case declaration, one match per case.
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

const RUST_CASE_PATTERNS: RegExp[] = [/#\[(?:tokio::)?test\b/g];
const RUST_SKIP_PATTERNS: RegExp[] = [/#\[ignore\b/g];

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let n = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    n += text.match(pattern)?.length ?? 0;
  }
  return n;
}

// A test that is switched off, or an assertion that can never run.
const SKIP_PATTERNS: RegExp[] = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo|fixme|fails)\b/g,
  /\b(?:it|test|describe|context|suite)\.skipIf\s*\(\s*(?:true|1|!0)\s*\)/g,
  /\b(?:it|test|describe|context|suite)\.runIf\s*\(\s*(?:false|0|!1)\s*\)/g,
  /\b(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/g,
  /\b(?:it|test|describe)\.only\s*\(/g,
  /\bpytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bpytest\.(?:skip|xfail)\s*\(/g,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
  /\bself\.skipTest\s*\(/g,
  /\braise\s+(?:unittest\.)?SkipTest\b/g,
  /@(?:Ignore|Disabled|DisabledIf\w*|DisabledOn\w*)\b/g,
  /\bt\.Skip(?:f|Now)?\s*\(/g,
  /#\[ignore\b/g,
  /\bSkip\s*=\s*["']/g,
  /^\s*(?:skip|pending|xit|xdescribe)\b(?:\s+['"(]|\s*$)/gm,
  // Assertions that can never run, or whose failure is swallowed.
  /\bif\s*\(\s*(?:false|0)\s*\)/g,
  /^\s*if\s+False\s*:/gm,
  /(?:=>|\bfunction\s*\([^)]*\))\s*\{\s*return\b/g,
  /\btry\s*\{[^}]*\bexpect\b[^}]*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
];

// Assertions, counted per occurrence. Deliberately broad across languages: the signal is the net
// change in the test files, not what any one line is.
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
  /\bexpect\s*\(\s*([\w.]+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
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

// A construct that stands for many cases: a consolidation into one of these is not a removal.
const PARAMETERISED_PATTERNS: RegExp[] = [
  /\.each\s*[(`[]/g,
  /@pytest\.mark\.parametrize\b/g,
  /@ParameterizedTest\b/g,
  /\bt\.Run\s*\(/g,
  /\[Theory\]/g,
  /\bfor\s*\(.*\)\s*\{?\s*(?:it|test)\s*\(/g,
  /\.forEach\s*\([^)]*=>\s*\{?\s*(?:it|test)\s*\(/g,
];

// A setting that is about tests by its own name.
const TEST_IGNORE_STRONG: RegExp[] = [
  /\btestPathIgnorePatterns\b/g,
  /\btestIgnore\b/g,
  /\btestPathIgnore\b/g,
  /\bnorecursedirs\b/g,
  /\bcollect_ignore(?:_glob)?\b/g,
  /--(?:ignore|ignore-glob|deselect)\b/g,
  /\s-k\s+['"]?not\b/g,
  /\bskipTests\b|-DskipTests|-Dmaven\.test\.skip|<maven\.test\.skip>/g,
  /\bwatchPathIgnorePatterns\b/g,
  /<testFailureIgnore>\s*true/g,
];

// A generic exclusion: only a test exclusion when the same line names a test.
const TEST_IGNORE_GENERIC: RegExp[] = [
  /\b(?:test|tests)\s*:\s*\{[^}]*\bexclude\b/g,
  /\bexclude["']?\s*:\s*\[/g,
  /\bexcludes?\b["']?\s*[:=]/g,
  /<exclude>/g,
  /\bexclude\s+['"]/g,
  /\benabled\s*=\s*false\b/g,
  /\bignore\w*\s*[:=]\s*\[/g,
];

const TEST_TOKEN =
  /(?:^|[^a-z])(?:tests?|specs?|e2e|__tests__)(?:[^a-z]|$)|\.(?:test|spec)\.|[a-z](?:Test|Tests|IT|Spec)\b|\bTest[A-Z]/;

/** Count test exclusions among the lines; entries of a multi-line exclude array count too. */
function countTestExclusions(lines: readonly string[], pureTestConfig: boolean): number {
  let n = 0;
  let inArray = false;
  for (const line of lines) {
    n += countMatches(line, TEST_IGNORE_STRONG);
    // In a file that configures only a test runner every exclusion is a test exclusion; in a
    // build or project file it is one only when the line names a test.
    if (pureTestConfig || TEST_TOKEN.test(line)) {
      n += countMatches(line, TEST_IGNORE_GENERIC) > 0 ? 1 : 0;
      if (inArray && /['"`]/.test(line)) {
        n += 1;
      }
    }
    if (/\b(?:exclude\w*|ignore\w*|testPathIgnorePatterns|testIgnore)\s*[:=]\s*\[\s*$/.test(line)) {
      inArray = true;
    } else if (inArray && /\]/.test(line)) {
      inArray = false;
    }
  }
  return n;
}

const THRESHOLD_KEY =
  /\b(branches|functions|lines|statements|fail[_-]under|cov-fail-under|threshold|minimum|minimumCoverage)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/g;
const THRESHOLD_CLI = /--cov-fail-under[= ](\d+(?:\.\d+)?)/g;

const TEST_BYPASS_PATTERNS: RegExp[] = [
  /--passWithNoTests\b/g,
  /(?:\bjest|\bvitest|\bpytest|\bgo test|\bmvn\b[^\n|]*\btest|\bcargo test|\brspec|\b(?:npm|yarn|pnpm)(?: run)? test)\b[^\n|]*(?:\|\||;)\s*(?:true|exit 0|:)\b/g,
  /"test[\w:-]*"\s*:\s*"\s*(?:echo\b[^"]*|true|exit\s+0|:)\s*"/g,
  /\bgo test\b[^\n]*-run[ =]['"]?(?:\^?\$|X{3,}|NONE|nothing)/gi,
];

const TEST_SCRIPT_LINE = /"test(?::[\w-]+)?"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const CI_TEST_STEP =
  /\b(?:yarn|npm|pnpm|bun)(?: run)? test|\b(?:jest|vitest|pytest|go test|cargo test|rspec|phpunit|mocha|mvn\b[^\n]*\btest|gradle[w]?\b[^\n]*\btest|dotnet test|playwright test|cypress run)\b/g;
const CI_SOFT_FAIL = /\bcontinue-on-error\s*:\s*true\b|\ballow_failure\s*:\s*true\b|\|\|\s*true\b/g;

const NARROWING_KEY = /\b(testMatch|testRegex|include|roots|testpaths|testPathPattern)\b/;

// ── Analysis ──────────────────────────────────────────────────────────────────────────────────

interface Prepared {
  file: FileDiff;
  /** Removed lines, comments stripped. */
  removed: string[];
  /** Added lines, comments stripped. */
  added: Array<{ line: number; text: string }>;
  source: boolean;
  rust: boolean;
}

function prepare(file: FileDiff): Prepared {
  const style = commentStyle(file.path);
  const removed = stripComments(file.removed, style);
  const addedText = stripComments(
    file.added.map((a) => a.text),
    style
  );
  return {
    added: file.added.map((a, i) => ({ line: a.line, text: addedText[i] as string })),
    file,
    removed,
    rust: !isTestFilePath(file.path) && isRustSource(file.path),
    source: isTestFilePath(file.path),
  };
}

function firstLine(added: ReadonlyArray<{ line: number; text: string }>, p: readonly RegExp[]) {
  for (const a of added) {
    if (countMatches(a.text, p) > 0) {
      return a.line;
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

function stringsOnKey(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    if (NARROWING_KEY.test(line)) {
      for (const m of line.matchAll(/(['"`])((?:(?!\1).)+)\1/g)) {
        const value = m[2] as string;
        if (!NARROWING_KEY.test(value)) {
          out.add(value);
        }
      }
    }
  }
  return out;
}

const norm = (line: string) => line.trim();

/** Assertion lines of a prepared file after cancelling lines present on both sides of the diff. */
function assertionCounts(
  prepared: Prepared[]
): Map<Prepared, { removed: number; added: number; weakR: number; weakA: number }> {
  const removedSet = new Set<string>();
  const addedSet = new Set<string>();
  for (const p of prepared) {
    for (const r of p.removed) {
      removedSet.add(norm(r));
    }
    for (const a of p.added) {
      addedSet.add(norm(a.text));
    }
  }
  const out = new Map<Prepared, { removed: number; added: number; weakR: number; weakA: number }>();
  for (const p of prepared) {
    let removed = 0;
    let added = 0;
    let weakR = 0;
    let weakA = 0;
    for (const r of p.removed) {
      if (!addedSet.has(norm(r))) {
        removed += countMatches(r, ASSERTION_PATTERNS);
        weakR += countMatches(r, WEAK_ASSERTION_PATTERNS);
      }
    }
    for (const a of p.added) {
      if (!removedSet.has(norm(a.text))) {
        added += countMatches(a.text, ASSERTION_PATTERNS);
        weakA += countMatches(a.text, WEAK_ASSERTION_PATTERNS);
      }
    }
    out.set(p, { added, removed, weakA, weakR });
  }
  return out;
}

function analyseFiles(parsed: FileDiff[]): TestIntegrityFinding[] {
  const files = parsed.filter((f) => !isGeneratedPath(f.path));
  const prepared = files.map(prepare);
  const findings: TestIntegrityFinding[] = [];
  const add = (
    f: FileDiff,
    kind: TestIntegrityKind,
    detail: string,
    options: { line?: number; severity?: TestIntegritySeverity } = {}
  ) => {
    findings.push({
      detail,
      file: f.path,
      kind,
      severity: options.severity ?? 'high',
      ...(options.line !== undefined ? { line: options.line } : {}),
    });
  };

  // Whole-diff totals over the test source files (and Rust files, whose tests live inline).
  const counted = prepared.filter((p) => p.source || p.rust);
  const tests = prepared.filter((p) => p.source);
  const caseOf = (p: Prepared) => ({
    added: countMatches(
      p.added.map((a) => a.text).join('\n'),
      p.rust ? RUST_CASE_PATTERNS : TEST_CASE_PATTERNS
    ),
    removed: countMatches(p.removed.join('\n'), p.rust ? RUST_CASE_PATTERNS : TEST_CASE_PATTERNS),
  });
  const skipOf = (p: Prepared) => ({
    added: countMatches(
      p.added.map((a) => a.text).join('\n'),
      p.rust ? RUST_SKIP_PATTERNS : SKIP_PATTERNS
    ),
    removed: countMatches(p.removed.join('\n'), p.rust ? RUST_SKIP_PATTERNS : SKIP_PATTERNS),
  });
  const cases = new Map(counted.map((p) => [p, caseOf(p)]));
  const skips = new Map(counted.map((p) => [p, skipOf(p)]));
  const assertions = assertionCounts(tests);
  const sum = <T>(items: Iterable<T>, f: (t: T) => number) => {
    let n = 0;
    for (const i of items) {
      n += f(i);
    }
    return n;
  };
  const netCases = sum(cases.values(), (c) => c.removed) - sum(cases.values(), (c) => c.added);
  const netSkips = sum(skips.values(), (c) => c.added) - sum(skips.values(), (c) => c.removed);
  const netAssertions =
    sum(assertions.values(), (c) => c.removed) - sum(assertions.values(), (c) => c.added);
  const anyNewTestFile = tests.some((p) => p.file.isNew || p.file.renamed);

  // Coverage thresholds are compared across all the test-config files: one moved from
  // package.json to jest.config.js is not lowered.
  const configFiles = prepared.filter((p) => isTestConfigPath(p.file.path));
  const before = thresholds(configFiles.flatMap((p) => p.removed));
  const after = thresholds(configFiles.flatMap((p) => p.added.map((a) => a.text)));
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
  let thresholdReported = false;

  for (const p of prepared) {
    const f = p.file;
    const addedText = p.added.map((a) => a.text).join('\n');
    const removedText = p.removed.join('\n');

    if (isGitattributes(f.path) || isGitattributes(f.oldPath)) {
      add(
        f,
        'gitattributes_changed',
        'attributes can change how a diff is rendered (binary, no-diff), which hides what a change did'
      );
    }

    if (f.binary && (p.source || isTestConfigPath(f.path))) {
      add(
        f,
        'test_file_unreadable',
        'git reports this test or test-configuration file as binary, so its change cannot be read'
      );
    }

    if (f.renamed && isTestFilePath(f.oldPath) && !isTestFilePath(f.path)) {
      add(
        f,
        'test_file_deleted',
        `test file renamed to ${f.path}, a name no test runner collects by convention`
      );
    }

    if (isTestSupportPath(f.path) && f.deleted && !/\.snap$/.test(f.path)) {
      add(f, 'test_support_deleted', 'test fixture or helper deleted', { severity: 'low' });
    }
    if (/\.snap$/.test(f.path) && (p.removed.length > 0 || f.deleted)) {
      add(f, 'snapshot_updated', 'snapshot changed or removed', { severity: 'low' });
    }

    if (p.source || p.rust) {
      const c = cases.get(p) as { added: number; removed: number };
      const parameterised = countMatches(addedText, PARAMETERISED_PATTERNS) > 0;
      if (f.deleted && p.source) {
        const lostElsewhere = netCases > 0 || netAssertions > 0;
        if (lostElsewhere || (c.removed === 0 && !anyNewTestFile)) {
          add(
            f,
            'test_file_deleted',
            `test file deleted (${c.removed} test case(s) in it; ${netCases} more removed than added across the change)`
          );
        }
        continue;
      }
      if (netCases > 0 && c.removed > c.added) {
        add(
          f,
          'test_case_removed',
          `${c.removed - c.added} more test case(s) removed than added (${c.removed} removed, ${c.added} added; net ${netCases} across the change)` +
            (parameterised ? '; a parameterised test was added, which may account for it' : ''),
          { severity: parameterised ? 'low' : 'high' }
        );
      }
      const s = skips.get(p) as { added: number; removed: number };
      if (netSkips > 0 && s.added > s.removed) {
        add(
          f,
          'skip_marker_added',
          `${s.added - s.removed} more skip, focus, disabling or expected-failure marker(s) added than removed`,
          {
            line: firstLine(p.added, p.rust ? RUST_SKIP_PATTERNS : SKIP_PATTERNS),
          }
        );
      }
    }

    if (p.source) {
      const a = assertions.get(p) as {
        added: number;
        removed: number;
        weakA: number;
        weakR: number;
      };
      const parameterised = countMatches(addedText, PARAMETERISED_PATTERNS) > 0;
      if (netAssertions > 0 && a.removed > a.added) {
        add(
          f,
          'assertions_reduced',
          `net ${a.removed - a.added} fewer assertion(s) (${a.removed} removed, ${a.added} added; net ${netAssertions} across the change)` +
            (parameterised ? '; a parameterised test was added, which may account for it' : ''),
          { severity: parameterised ? 'low' : 'high' }
        );
      }
      const trivialAdded = p.added.filter((x) =>
        TRIVIAL_ASSERTION_PATTERNS.some((re) => re.test(x.text))
      );
      const trivialRemoved = p.removed.filter((r) =>
        TRIVIAL_ASSERTION_PATTERNS.some((re) => re.test(r))
      ).length;
      if (trivialAdded.length > trivialRemoved) {
        add(
          f,
          'assertion_trivialized',
          `${trivialAdded.length - trivialRemoved} assertion(s) that hold whatever the code does (e.g. \`${(trivialAdded[0] as { text: string }).text.trim().slice(0, 80)}\`)`,
          { line: (trivialAdded[0] as { line: number }).line }
        );
      }
      const strongLost = a.removed - a.weakR - (a.added - a.weakA);
      const weakened = a.weakA - a.weakR;
      if (weakened > 0 && strongLost >= weakened) {
        add(
          f,
          'assertion_loosened',
          `${weakened} specific assertion(s) replaced by a weak matcher (toBeDefined, toBeTruthy, assertNotNull, …)`,
          { line: firstLine(p.added, WEAK_ASSERTION_PATTERNS) }
        );
      }
    }

    if (isTestConfigPath(f.path)) {
      const pure = isPureTestConfig(f.path);
      const ignoreAdded = countTestExclusions(
        p.added.map((a) => a.text),
        pure
      );
      const ignoreRemoved = countTestExclusions(p.removed, pure);
      if (ignoreAdded > ignoreRemoved) {
        add(
          f,
          'test_config_excludes',
          `${ignoreAdded - ignoreRemoved} more test exclusion/ignore setting(s) added than removed`,
          {
            line: p.added.find((x) => countTestExclusions([x.text], pure) > 0)?.line,
          }
        );
      }
      if (
        lowered.length > 0 &&
        !thresholdReported &&
        (p.removed.length > 0 || p.added.length > 0)
      ) {
        const touches = thresholds(p.removed).size > 0;
        if (touches) {
          thresholdReported = true;
          add(f, 'coverage_threshold_lowered', `coverage threshold lowered: ${lowered.join(', ')}`);
        }
      }
      if (!/package\.json$/.test(f.path)) {
        const was = stringsOnKey(p.removed);
        const now = stringsOnKey(p.added.map((x) => x.text));
        if (was.size > 0 && now.size > 0) {
          if (now.size < was.size) {
            add(
              f,
              'test_config_narrowed',
              `the set of test files collected narrowed (${was.size} -> ${now.size} pattern(s))`
            );
          } else if (![...now].some((v) => was.has(v))) {
            add(f, 'test_config_narrowed', 'the patterns that select test files were replaced', {
              severity: 'low',
            });
          }
        }
      }
    }

    // A test command that cannot fail or runs fewer tests, in any file a fixer might change.
    if (
      countMatches(addedText, TEST_BYPASS_PATTERNS) >
      countMatches(removedText, TEST_BYPASS_PATTERNS)
    ) {
      add(
        f,
        'test_run_bypassed',
        'a test command was changed so that it cannot fail or runs no tests (--passWithNoTests, `|| true`, echo, -run XXX)',
        { line: firstLine(p.added, TEST_BYPASS_PATTERNS) }
      );
    }
    if (/(^|\/)package\.json$/.test(f.path)) {
      const oldScript = p.removed.map((r) => TEST_SCRIPT_LINE.exec(r)?.[1]).find((v) => v);
      const newScript = p.added
        .map((a) => ({ line: a.line, value: TEST_SCRIPT_LINE.exec(a.text)?.[1] }))
        .find((v) => v.value);
      if (oldScript && newScript?.value && oldScript !== newScript.value) {
        const named = /\S+\.(?:test|spec)\.\w+|\b(?:src|tests?|spec|__tests__)\/\S+/;
        if (named.test(newScript.value) && !named.test(oldScript)) {
          add(
            f,
            'test_run_bypassed',
            'the test script was narrowed to named files or directories',
            {
              line: newScript.line,
            }
          );
        } else {
          add(f, 'test_command_changed', 'the test script was changed', {
            line: newScript.line,
            severity: 'low',
          });
        }
      }
    }

    if (CI_CONFIG_PATTERN.test(f.path)) {
      const softAdded = countMatches(addedText, [CI_SOFT_FAIL]);
      const softRemoved = countMatches(removedText, [CI_SOFT_FAIL]);
      const stepsRemoved = countMatches(removedText, [CI_TEST_STEP]);
      const stepsAdded = countMatches(addedText, [CI_TEST_STEP]);
      if (softAdded > softRemoved) {
        add(
          f,
          'ci_config_weakened',
          'a CI job or step was allowed to fail (continue-on-error, allow_failure, `|| true`)',
          {
            line: firstLine(p.added, [CI_SOFT_FAIL]),
          }
        );
      } else if (stepsRemoved > stepsAdded) {
        add(f, 'ci_config_weakened', `${stepsRemoved - stepsAdded} CI test step(s) removed`);
      }
    }
  }
  return findings;
}

/**
 * Findings for one unified diff. Read it with `git diff --text --find-renames
 * --src-prefix=a/ --dst-prefix=b/` (see the gate); no context lines are needed. An empty list means the
 * analyser recognised nothing, not that the tests are intact.
 */
export function analyseTestIntegrity(diff: string): TestIntegrityResult {
  const truncatedDiff = diff.length > MAX_ANALYSED_DIFF_CHARS;
  const all = analyseFiles(
    parseUnifiedDiff(truncatedDiff ? diff.slice(0, MAX_ANALYSED_DIFF_CHARS) : diff)
  );
  return {
    findings: all.slice(0, MAX_FINDINGS),
    truncatedDiff,
    truncatedFindings: all.length > MAX_FINDINGS,
  };
}

/**
 * Findings from `git diff --name-status` output alone: what can still be said when the full diff
 * was too large to read. Deleted or renamed-away test files and attribute changes only.
 */
export function analyseNameStatus(text: string): TestIntegrityFinding[] {
  const findings: TestIntegrityFinding[] = [];
  for (const line of text.split('\n')) {
    const [status, first, second] = line.split('\t');
    if (!status || !first) {
      continue;
    }
    const finding = (
      kind: TestIntegrityKind,
      file: string,
      detail: string
    ): TestIntegrityFinding => ({ detail, file, kind, severity: 'high' });
    if (status === 'D' && isTestFilePath(first)) {
      findings.push(
        finding('test_file_deleted', first, 'test file deleted (diff too large to read)')
      );
    } else if (
      status.startsWith('R') &&
      second &&
      isTestFilePath(first) &&
      !isTestFilePath(second)
    ) {
      findings.push(finding('test_file_deleted', second, `test file renamed away from ${first}`));
    }
    if (isGitattributes(first) || (second && isGitattributes(second))) {
      findings.push(finding('gitattributes_changed', second ?? first, 'attributes file changed'));
    }
  }
  return findings;
}

/** One line per finding, for an error message or a log. */
export function summariseTestIntegrity(findings: readonly TestIntegrityFinding[]): string {
  return findings
    .map(
      (f) =>
        `${f.kind} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}${f.severity === 'low' ? ' (low severity)' : ''}`
    )
    .join('\n');
}
