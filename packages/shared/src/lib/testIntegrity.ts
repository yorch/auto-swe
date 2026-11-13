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
  | 'test_commented_out'
  | 'early_return_added'
  | 'assertions_reduced'
  | 'assertion_trivialized'
  | 'assertion_loosened'
  | 'test_config_excludes'
  | 'test_config_narrowed'
  | 'coverage_threshold_lowered'
  | 'test_run_bypassed'
  | 'test_command_changed'
  | 'ci_config_weakened'
  | 'gitattributes_changed'
  | 'test_setup_changed'
  | 'test_double_changed';

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
 * The `git diff-tree` pathspec arguments (unquoted, anchored at the top of the repository) that leave generated files out of the diff the
 * analyser reads, so a lockfile-regenerating fix does not push the diff past the size cap.
 */
export function generatedPathspecs(): string[] {
  return [
    ...GENERATED_BASENAMES.map((n) => `:(top,exclude,glob)**/${n}`),
    ...GENERATED_GLOBS.map((g) => `:(top,exclude,glob)**/${g}`),
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
  /**
   * Parallel to `removed`: an id that changes wherever the removed lines stop being consecutive in
   * the old file (a context line, an added line or a new hunk comes between).
   */
  removedRun: number[];
  added: AddedLine[];
}

interface AddedLine {
  /** Line in the new file. */
  line: number;
  text: string;
  /**
   * Added lines with the same `run` are consecutive in the new file: nothing unchanged or removed
   * comes between them. A comment can only be read across lines of one run.
   */
  run: number;
  /** The line before this one in the new file, when the diff shows it (context or added). */
  prev?: string;
  /** The lines removed directly before this run of added lines: what it replaces, if anything. */
  replaced?: string[];
}

/**
 * The line terminators a language treats as a line break and `git` does not: a lone CR, U+2028 and
 * U+2029. `// note<CR>it.skip(…)` is a comment and a statement to a JavaScript engine, and one
 * diff line to git, so the analyser splits there too.
 */
const LINE_BREAKS = /\r\n|[\r\u2028\u2029]/;

function logicalLines(text: string): string[] {
  const parts = text.split(LINE_BREAKS);
  // A CRLF file's lines end in a CR: that is a terminator, not an extra empty line.
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
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
  let run = 0;
  let prev: string | undefined;
  let lastKind = '';
  let removedGroup: string[] = [];
  let replaced: string[] | undefined;
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
        removedRun: [],
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
      run += 1;
      prev = undefined;
      lastKind = '';
      removedGroup = [];
      replaced = undefined;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      if (lastKind !== '+') {
        run += 1;
        replaced = lastKind === '-' ? removedGroup : undefined;
      }
      lastKind = '+';
      for (const text of logicalLines(line.slice(1))) {
        current.added.push({ line: newLine, prev, replaced, run, text });
        prev = text;
      }
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (lastKind !== '-') {
        run += 1;
        removedGroup = [];
      }
      lastKind = '-';
      for (const text of logicalLines(line.slice(1))) {
        removedGroup.push(text);
        current.removed.push(text);
        current.removedRun.push(run);
      }
    } else if (line.startsWith(' ')) {
      lastKind = ' ';
      run += 1;
      const parts = logicalLines(line.slice(1));
      prev = parts[parts.length - 1];
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

/**
 * A file a test runner loads before every test to set the run up: a Jest or Vitest setup file
 * (`jest.setup.js`, `vitest.setup.ts`, `setupTests.ts`, `test-setup.ts`, `setup-jest.ts`, and
 * `setup.*` under a `jest/` or `.jest/` directory), Karma's `karma.conf.js`, Angular's Karma entry
 * `src/test.ts`, anything under `cypress/support/` (Cypress loads it before every spec), RSpec's
 * `.rspec`. It runs inside every test, so it can redefine what an assertion does (replace
 * `expect`, stub the module under test) without touching a test file.
 */
export function isTestSetupPath(path: string): boolean {
  return (
    /(^|\/)(?:jest|vitest)[-_.]setup(?:[-_.][\w-]+)*\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)(?:setupTests|setup[-_]tests|test[-_]setup|setup[-_]jest)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)\.?jest\/setup(?:[-_.][\w-]+)*\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)karma\.conf\.[cm]?[jt]s$/.test(path) ||
    /(^|\/)src\/test\.ts$/.test(path) ||
    /(^|\/)cypress\/support\//.test(path) ||
    /(^|\/)\.rspec$/.test(path)
  );
}

/**
 * A directory that holds only test doubles, test data or test helpers wherever it sits, so its
 * files belong to the tests even outside a `test/` directory: Jest's `__mocks__` (module mocks the
 * runner substitutes automatically), Go's `testdata` (ignored by the build; golden files and
 * fixtures), `fixtures/` and `__fixtures__/`, Mock Service Worker's `src/mocks/` (request
 * handlers the tests run against), and helper packages named `testutil(s)`, `testhelper(s)`,
 * `test-utils`, `test_helpers`. A test-utilities module beside the source (`src/test-utils.tsx`)
 * counts too.
 */
function isTestHarnessDirOrModule(path: string): boolean {
  return (
    /(^|\/)(?:__mocks__|__fixtures__|fixtures|testdata|testutils?|testhelpers?|test[-_]utils?|test[-_]helpers?)\//.test(
      path
    ) ||
    /(^|\/)src\/mocks\//.test(path) ||
    /(^|\/)test[-_]utils?\.[cm]?[jt]sx?$/.test(path)
  );
}

/**
 * A fixture, helper, mock, snapshot or runner setup file that belongs to the tests but is not
 * itself a test.
 */
export function isTestSupportPath(path: string): boolean {
  if (isTestFilePath(path)) {
    return false;
  }
  return (
    isTestSetupPath(path) ||
    isTestHarnessDirOrModule(path) ||
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
export function isPureTestConfig(path: string): boolean {
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
  // `#` is a private-field sigil in JavaScript and TypeScript, never a comment.
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    return { hash: false, slash: true };
  }
  return { hash: true, slash: true };
}

interface LineState {
  text: string;
  inBlock: boolean;
}

/**
 * One line with comments removed, scanned left to right so whichever of `//` and `/*` comes first
 * wins. A backslash outside a string escapes the next character, which keeps the `//` inside a
 * regular expression literal such as `/a\//` from reading as a comment. Quoted strings are
 * skipped. `#[` and `#!` (Rust attributes, shebangs) are not comments.
 */
function stripLineLenient(original: string, style: CommentStyle, startInBlock: boolean): LineState {
  let out = '';
  let inBlock = startInBlock;
  let quote = '';
  for (let i = 0; i < original.length; ) {
    const ch = original[i] as string;
    if (inBlock) {
      const end = original.indexOf('*/', i);
      if (end < 0) {
        return { inBlock: true, text: out };
      }
      inBlock = false;
      out += ' ';
      i = end + 2;
      continue;
    }
    if (ch === '\\') {
      out += ch + (original[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }
    if (style.slash && original.startsWith('/*', i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    if (style.slash && original.startsWith('//', i)) {
      break;
    }
    if (style.hash && ch === '#' && !/[[!]/.test(original[i + 1] ?? '')) {
      break;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    }
    out += ch;
    i += 1;
  }
  return { inBlock, text: out };
}

/**
 * One line with only the comments that cannot be code removed: a line that starts (after
 * whitespace) with `//` or `#`, and a block comment that starts a line. A `//` or `/*` after code
 * is kept as code, because a comment reader that is wrong there hides what a JavaScript engine,
 * Python or a shell would run (`const re = /[/]/; it.skip(…)`, a lone line break, a regex). The
 * price is that a trailing comment that mentions `it.skip(` reads as a skip.
 */
function stripLineStrict(original: string, style: CommentStyle, startInBlock: boolean): LineState {
  let s = original;
  let inBlock = startInBlock;
  for (;;) {
    if (inBlock) {
      const end = s.indexOf('*/');
      if (end < 0) {
        return { inBlock: true, text: '' };
      }
      s = s.slice(end + 2);
      inBlock = false;
    }
    const t = s.trimStart();
    if (style.slash && t.startsWith('/*')) {
      s = t.slice(2);
      inBlock = true;
      continue;
    }
    if (style.slash && t.startsWith('//')) {
      return { inBlock: false, text: '' };
    }
    if (style.hash && t.startsWith('#') && !/^#[[!]/.test(t)) {
      return { inBlock: false, text: '' };
    }
    return { inBlock: false, text: t === '' ? '' : s };
  }
}

/**
 * The code of each line with comments removed: a comment-only line becomes empty, so commenting a
 * test or an assertion out counts as removing it, and deleting a comment is not an edit to a test.
 *
 * `lenient` removes every comment it can find, wherever on the line, and is what a line is
 * credited with (an assertion, a test case: a comment must not count as one). `strict` removes
 * only what cannot be code, and is what a line is charged with (a skip marker, a trivial
 * assertion). Block comments are tracked across lines, but only across lines that are consecutive
 * in the file (`runs`): the lines of two hunks are not, so a comment opened in one hunk says
 * nothing about the next. Without that, editing a doc-comment opener blanked every later deleted
 * assertion of the file.
 */
function stripComments(
  lines: readonly string[],
  runs: readonly number[],
  style: CommentStyle,
  mode: 'lenient' | 'strict'
): string[] {
  let inBlock = false;
  let lastRun = Number.NaN;
  return lines.map((original, i) => {
    if (runs[i] !== lastRun) {
      inBlock = false;
      lastRun = runs[i] as number;
    }
    // A leading ` * text` is the body of a block comment whose opener the diff did not show.
    if (mode === 'lenient' && !inBlock && style.slash && /^\s*\*(?!\/)(\s|$)/.test(original)) {
      return '';
    }
    const result =
      mode === 'lenient'
        ? stripLineLenient(original, style, inBlock)
        : stripLineStrict(original, style, inBlock);
    inBlock = result.inBlock;
    return result.text.trim() === '' ? '' : result.text;
  });
}

/**
 * Added lines that open a block comment (`/*`, a Python triple-quote line, Ruby `=begin`) whose end is not
 * among the same run of added lines: the body it hides is unchanged code the diff does not show,
 * so adding only the delimiters comments a test out without removing a line. A comment added whole
 * (opener, body and closer all new, consecutive) is not flagged.
 */
function wrappedBlockComments(file: FileDiff, style: CommentStyle): number[] {
  const python = /\.pyi?$/.test(file.path);
  const ruby = /\.rb$/.test(file.path);
  const flagged: number[] = [];
  let open: { line: number; run: number; closes: (text: string) => boolean } | undefined;
  for (const a of file.added) {
    if (open) {
      if (a.run !== open.run) {
        flagged.push(open.line);
        open = undefined;
      } else if (open.closes(a.text)) {
        open = undefined;
        continue;
      } else {
        continue;
      }
    }
    if (python && /^\s*(?:"{3}|'{3})\s*$/.test(a.text)) {
      open = { closes: (t) => /^\s*(?:"{3}|'{3})\s*$/.test(t), line: a.line, run: a.run };
    } else if (ruby && /^=begin\b/.test(a.text)) {
      open = { closes: (t) => /^=end\b/.test(t), line: a.line, run: a.run };
    } else if (
      style.slash &&
      stripLineLenient(a.text, style, false).inBlock &&
      // An opener that replaces an opener (`/** old` -> `/** new`) leaves the comment where it was.
      !a.replaced?.some((r) => stripLineLenient(r, style, false).inBlock)
    ) {
      open = { closes: (t) => t.includes('*/'), line: a.line, run: a.run };
    }
  }
  if (open) {
    flagged.push(open.line);
  }
  return flagged;
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
  /** Added lines, only what cannot be code stripped: what a line is charged with. */
  added: Array<{ line: number; text: string }>;
  /** Parallel to `added`, every comment stripped: what a line is credited with. */
  addedLenient: string[];
  source: boolean;
  rust: boolean;
}

function prepare(file: FileDiff): Prepared {
  const style = commentStyle(file.path);
  const removed = stripComments(file.removed, file.removedRun, style, 'lenient');
  const addedRaw = file.added.map((a) => a.text);
  const addedRuns = file.added.map((a) => a.run);
  const addedStrict = stripComments(addedRaw, addedRuns, style, 'strict');
  return {
    added: file.added.map((a, i) => ({ line: a.line, text: addedStrict[i] as string })),
    addedLenient: stripComments(addedRaw, addedRuns, style, 'lenient'),
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

function strictPrev(prev: string | undefined, style: CommentStyle): string {
  return prev === undefined ? '' : stripLineStrict(prev, style, false).text;
}

/** A line that opens a test case's body: a declaration of one that ends where its body starts. */
function isTestOpenerLine(line: string): boolean {
  return countMatches(line, TEST_CASE_PATTERNS) > 0 && /(?:\{|:|=>|\bdo)\s*$/.test(line);
}

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
    for (const a of p.addedLenient) {
      addedSet.add(norm(a));
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
    p.added.forEach((a, i) => {
      const credited = p.addedLenient[i] as string;
      if (!removedSet.has(norm(credited))) {
        added += countMatches(credited, ASSERTION_PATTERNS);
        weakA += countMatches(a.text, WEAK_ASSERTION_PATTERNS);
      }
    });
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
      p.addedLenient.join('\n'),
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
  const after = thresholds(configFiles.flatMap((p) => p.addedLenient));
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
    const addedCredit = p.addedLenient.join('\n');
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
    // A runner setup file runs inside every test, so any change to it can change what every
    // assertion means; a mock or a golden file decides what a test compares against.
    const touched =
      f.isNew || f.deleted || f.renamed || f.binary || p.added.length > 0 || p.removed.length > 0;
    if (touched && (isTestSetupPath(f.path) || (f.renamed && isTestSetupPath(f.oldPath)))) {
      add(
        f,
        'test_setup_changed',
        'a test-runner setup file changed; it runs before every test and can redefine what an assertion does'
      );
    } else if (
      touched &&
      !f.deleted &&
      isTestHarnessDirOrModule(f.path) &&
      !isTestFilePath(f.path)
    ) {
      add(
        f,
        'test_double_changed',
        'a mock, test-data (golden) file or test helper changed, which decides what tests compare against',
        { severity: 'low' }
      );
    }
    if (/\.snap$/.test(f.path) && (p.removed.length > 0 || f.deleted)) {
      add(f, 'snapshot_updated', 'snapshot changed or removed', { severity: 'low' });
    }

    if (p.source || p.rust) {
      const c = cases.get(p) as { added: number; removed: number };
      const parameterised = countMatches(addedCredit, PARAMETERISED_PATTERNS) > 0;
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
      const wrapped = wrappedBlockComments(f, commentStyle(f.path));
      if (wrapped.length > 0) {
        add(
          f,
          'test_commented_out',
          'a block comment is opened in the test file and not closed among the lines added with it, ' +
            'so it comments out code the diff does not show',
          { line: wrapped[0] }
        );
      }
      const early = p.added.find(
        (x, i) =>
          /^\s*return(?:\s+(?:undefined|null|void\s+0))?\s*;?\s*$/.test(x.text) &&
          isTestOpenerLine(strictPrev(f.added[i]?.prev, commentStyle(f.path)))
      );
      if (early) {
        add(
          f,
          'early_return_added',
          'a bare return was added as the first statement of a test, so its assertions never run',
          { line: early.line }
        );
      }
      const a = assertions.get(p) as {
        added: number;
        removed: number;
        weakA: number;
        weakR: number;
      };
      const parameterised = countMatches(addedCredit, PARAMETERISED_PATTERNS) > 0;
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
        const now = stringsOnKey(p.addedLenient);
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
 * Findings for one unified diff. Read it with `git diff-tree -p --text --find-renames -U1
 * --src-prefix=a/ --dst-prefix=b/` (see the gate); one line of context is what lets it see the
 * line before an added one. An empty list means the analyser recognised nothing, not that the
 * tests are intact.
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
 * was too large to read. Deleted or renamed-away test files, attribute changes and test-runner
 * setup changes only.
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
    if (isTestSetupPath(first) || (second && isTestSetupPath(second))) {
      findings.push(
        finding('test_setup_changed', second ?? first, 'test-runner setup file changed')
      );
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
