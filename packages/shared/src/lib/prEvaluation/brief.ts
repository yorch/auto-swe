import { CONTRACT_GLOBS, isTestFile, matchesAny, NON_SOURCE_GLOBS } from './paths.js';
import type {
  Brief,
  BriefEvidence,
  BriefFinding,
  BriefIntent,
  ChangedFile,
  Classification,
  EffectivePolicy,
  Reason,
  SkimProof,
} from './types.js';

/** Info reason codes that say the evaluator's own approval stood behind the status. */
export const BOT_APPROVED_REASON_CODES: readonly string[] = [
  'bot-approval-posted',
  'bot-approval-present',
];
/** The one sentence the brief says about a bot approval; fixed text, never a name or an id. */
export const BOT_APPROVED_BRIEF_SENTENCE =
  'Approved by the evaluator; no human approval was required.';

/** First line of the comment, so the writer can find and update its own comment. */
export const BRIEF_MARKER = '<!-- auto-swe:pr-evaluation -->';
/** Files of the reading path always listed; the rest of an unflagged tail is collapsed. */
export const MAX_READ_VISIBLE = 10;
/** Flagged files listed beyond the first ones, so a risky file is never hidden in the collapse. */
const MAX_READ_FLAGGED = 30;
/** Entries inside the collapsed block; keeps the block closing inside `MAX_BRIEF_CHARS`. */
const MAX_READ_COLLAPSED = 100;
export const MAX_BRIEF_CHARS = 60_000;
const MAX_SKIM_SHOWN = 50;
const MAX_CRITERIA_SHOWN = 20;
const MAX_QUESTIONS_SHOWN = 10;
const MAX_FINDINGS_SHOWN = 10;
const MAX_REASON_PATHS_SHOWN = 5;
const MAX_DISPLAY_PATH = 200;

/**
 * Files where leading or interior whitespace changes behaviour (indentation is
 * syntax, a tab is a recipe, a space splits a word). A whitespace-only proof is
 * never given for them, nor for a file with no extension.
 */
export const WHITESPACE_SIGNIFICANT_EXTENSIONS: readonly string[] = [
  '.py',
  '.pyi',
  '.yml',
  '.yaml',
  '.mk',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.haml',
  '.pug',
  '.slim',
  '.coffee',
  '.nim',
  '.fs',
  '.fsx',
  '.hs',
  '.jade',
  '.styl',
  '.sass',
];
export const WHITESPACE_SIGNIFICANT_NAMES: readonly string[] = ['makefile', 'gnumakefile'];

function isWhitespaceSignificant(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return true; // no extension
  }
  return (
    name.startsWith('dockerfile') ||
    WHITESPACE_SIGNIFICANT_NAMES.includes(name) ||
    WHITESPACE_SIGNIFICANT_EXTENSIONS.includes(name.slice(dot)) ||
    name.endsWith('.dockerfile')
  );
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * True only when every contiguous run of changed lines removes exactly the
 * lines it adds, in order, once trailing whitespace is ignored (leading and
 * interior whitespace must be identical, and blank lines may come or go). Runs are compared
 * one by one: comparing whole-patch totals would "prove" a block moved between
 * two places. A patch whose line counts disagree with the file's counts is
 * truncated and proves nothing.
 */
function isWhitespaceOnly(file: ChangedFile): boolean {
  if (file.status !== 'modified' || !file.patch || isWhitespaceSignificant(file.path)) {
    return false;
  }
  let added = 0;
  let removed = 0;
  let removedRun: string[] = [];
  let addedRun: string[] = [];
  const flush = (): boolean => {
    const ok = sameSequence(
      removedRun.filter((line) => line !== ''),
      addedRun.filter((line) => line !== '')
    );
    removedRun = [];
    addedRun = [];
    return ok;
  };
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('-')) {
      removed++;
      removedRun.push(line.slice(1).trimEnd());
    } else if (line.startsWith('+')) {
      added++;
      addedRun.push(line.slice(1).trimEnd());
    } else if (!flush()) {
      return false;
    }
  }
  return flush() && added + removed > 0 && added === file.additions && removed === file.deletions;
}

/** The deterministic proof that a file is safe to skim, or null. Nothing else ever qualifies. */
export function skimProof(file: ChangedFile, ignoredFromSkim: readonly string[]): SkimProof | null {
  if (
    matchesAny(file.path, ignoredFromSkim) ||
    (file.previousPath !== undefined && matchesAny(file.previousPath, ignoredFromSkim))
  ) {
    return null;
  }
  if (
    file.status === 'renamed' &&
    file.similarity === 100 &&
    file.additions === 0 &&
    file.deletions === 0 &&
    file.previousPath !== undefined &&
    file.previousPath !== file.path &&
    dirname(file.previousPath) === dirname(file.path)
  ) {
    return 'exact-rename';
  }
  return isWhitespaceOnly(file) ? 'whitespace-only' : null;
}

/** Control, zero-width and bidi-override characters: invisible in a rendered comment. */
function replaceUnsafe(raw: string, substitute: string): string {
  return Array.from(raw, (ch) => {
    const code = ch.codePointAt(0) as number;
    const unsafe =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xad ||
      code === 0x61c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    return unsafe ? substitute : ch;
  }).join('');
}

/** Cuts on a code point boundary, so a surrogate pair is never split. */
function clipCodePoints(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${Array.from(text).slice(0, max).join('')}...`;
}

/** Fenced inline code with a fence longer than any backtick run, so a name cannot escape it. */
function codeSpan(raw: string): string {
  let text = replaceUnsafe(raw, '?');
  text = clipCodePoints(text, MAX_DISPLAY_PATH);
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

const MAX_PROSE_CHARS = 500;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

function escapeProse(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[`|\\[\]*_~]/g, '\\$&')
    .replace(/#(?=\d)/g, '\\#')
    .replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}\\-`)
    .replace(/@/g, '@\u200b');
}

/**
 * Prose built from our own strings plus anything a PR could influence: no
 * markup, no mentions, no autolinks. Bare URLs are shown as code, `#123`
 * references are backslash-escaped so they do not link to an issue.
 */
export function escapeText(raw: string): string {
  const text = clipCodePoints(replaceUnsafe(raw, ' '), MAX_PROSE_CHARS);
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    out += escapeProse(text.slice(last, match.index));
    out += codeSpan(match[0]);
    last = match.index + match[0].length;
  }
  return out + escapeProse(text.slice(last));
}

const PROOF_TEXT: Record<SkimProof, string> = {
  'exact-rename': 'exact rename, no content change',
  'whitespace-only': 'whitespace-only change',
};

const VERIFY: Record<string, string> = {
  'high-risk-path': 'This repository marks the path high risk; review it line by line.',
  'path-too-long': 'Open the file; its path is too long to evaluate.',
  'policy-file-changed': 'Confirm the policy file is not weakening review rules.',
  'removed-test': 'Confirm the coverage this test provided still exists elsewhere.',
  'sensitive-path': 'Read the change itself; this path is on the sensitive list.',
  'test-skip-added': 'Confirm the test is not being switched off to get green.',
  'unverifiable-test-patch': 'Open the file; the patch was too large to scan for skipped tests.',
};

function whyAndVerify(file: ChangedFile, hits: Reason[]): { why: string; verify: string } {
  if (hits.length > 0) {
    const first = hits[0] as Reason;
    return {
      verify: VERIFY[first.code] ?? 'Review this file closely.',
      why: hits.map((hit) => hit.message).join('; '),
    };
  }
  return {
    verify: 'Read the diff.',
    why: `${file.additions + file.deletions} lines changed (${file.status})`,
  };
}

const TEST_STEM_SUFFIX = /(?:\.test|\.spec|_test|_spec|Tests?)$/;
const TEST_STEM_PREFIX = /^test_/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e']);

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** A file's name without its extension and, for a test, without the marker that says it is one. */
function stemOf(path: string, test: boolean): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (!test) {
    return stem.toLowerCase();
  }
  const bare = stem.replace(TEST_STEM_SUFFIX, '').replace(TEST_STEM_PREFIX, '');
  return (bare === '' ? stem : bare).toLowerCase();
}

/** The directories a test may sit in for the source it covers: its own, and a test directory's parent. */
function sourceDirsFor(testPath: string): string[] {
  const dir = dirname(testPath);
  return TEST_DIRS.has(baseName(dir).toLowerCase()) ? [dir, dirname(dir)] : [dir];
}

/**
 * The source a test covers when the tests live in a tree of their own (`test/foo/bar.test.ts` for
 * `src/foo/bar.ts`): the one changed source of that name whose directory ends with the test's path
 * below its test directory. With nothing below the test directory the name alone must be unique.
 * Two candidates mean no pairing: a wrong pairing is worse than a loose test.
 */
function mirroredOwner(
  test: ChangedFile,
  candidates: readonly ChangedFile[] | undefined
): ChangedFile | undefined {
  const parts = dirname(test.path).split('/');
  const at = parts.findIndex((part) => TEST_DIRS.has(part.toLowerCase()));
  if (at === -1 || !candidates) {
    return undefined;
  }
  const below = parts.slice(at + 1).join('/');
  const matches =
    below === ''
      ? candidates
      : candidates.filter(
          (c) => dirname(c.path) === below || dirname(c.path).endsWith(`/${below}`)
        );
  return matches.length === 1 ? matches[0] : undefined;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const churn = (file: ChangedFile): number => file.additions + file.deletions;

/**
 * The order to read the files in: what the rest depends on first (manifests, schema, contracts),
 * then source grouped by directory with each test straight after the source it covers, then tests
 * with no source in the change, then documentation and other files. A pure function of the paths
 * and line counts, so the same change always reads in the same order. Risk does not move a file:
 * the caller marks it.
 */
export function readingOrder(files: readonly ChangedFile[]): ChangedFile[] {
  const contracts: ChangedFile[] = [];
  const sources: ChangedFile[] = [];
  const tests: ChangedFile[] = [];
  const other: ChangedFile[] = [];
  for (const file of files) {
    if (isTestFile(file.path)) {
      tests.push(file);
    } else if (matchesAny(file.path, CONTRACT_GLOBS)) {
      contracts.push(file);
    } else if (matchesAny(file.path, NON_SOURCE_GLOBS)) {
      other.push(file);
    } else {
      sources.push(file);
    }
  }

  const sourceByKey = new Map<string, ChangedFile>();
  const sourcesByStem = new Map<string, ChangedFile[]>();
  for (const file of [...sources].sort((a, b) => byPath(a.path, b.path))) {
    const stem = stemOf(file.path, false);
    const key = `${dirname(file.path)}\0${stem}`;
    if (!sourceByKey.has(key)) {
      sourceByKey.set(key, file);
    }
    sourcesByStem.set(stem, [...(sourcesByStem.get(stem) ?? []), file]);
  }
  const testsOf = new Map<ChangedFile, ChangedFile[]>();
  const unpaired: ChangedFile[] = [];
  for (const test of [...tests].sort((a, b) => byPath(a.path, b.path))) {
    const stem = stemOf(test.path, true);
    const owner =
      sourceDirsFor(test.path)
        .map((dir) => sourceByKey.get(`${dir}\0${stem}`))
        .find((source) => source !== undefined) ?? mirroredOwner(test, sourcesByStem.get(stem));
    if (owner) {
      testsOf.set(owner, [...(testsOf.get(owner) ?? []), test]);
    } else {
      unpaired.push(test);
    }
  }

  const dirs = new Map<string, ChangedFile[]>();
  for (const file of sources) {
    dirs.set(dirname(file.path), [...(dirs.get(dirname(file.path)) ?? []), file]);
  }
  const dirChurn = (group: ChangedFile[]): number => group.reduce((sum, f) => sum + churn(f), 0);
  const orderedDirs = [...dirs.entries()].sort(
    ([dirA, a], [dirB, b]) => dirChurn(b) - dirChurn(a) || byPath(dirA, dirB)
  );

  const ordered: ChangedFile[] = [...contracts.sort((a, b) => byPath(a.path, b.path))];
  for (const [, group] of orderedDirs) {
    for (const source of group.sort((a, b) => churn(b) - churn(a) || byPath(a.path, b.path))) {
      ordered.push(source, ...(testsOf.get(source) ?? []));
    }
  }
  ordered.push(...unpaired, ...other.sort((a, b) => byPath(a.path, b.path)));
  return ordered;
}

export function buildBrief(
  files: ChangedFile[],
  classification: Classification,
  effective: EffectivePolicy,
  intent?: BriefIntent,
  evidence?: BriefEvidence,
  findings?: BriefFinding[]
): Brief {
  const hitsByPath = new Map<string, Reason[]>();
  for (const reason of classification.reasons) {
    if (reason.severity === 'info') {
      continue;
    }
    for (const path of reason.paths ?? []) {
      hitsByPath.set(path, [...(hitsByPath.get(path) ?? []), reason]);
    }
  }

  const skim: Brief['skim'] = [];
  const rest: ChangedFile[] = [];
  for (const file of files) {
    const proof = hitsByPath.has(file.path) ? null : skimProof(file, effective.ignoredFromSkim);
    if (proof) {
      skim.push({ path: file.path, proof });
    } else {
      rest.push(file);
    }
  }

  const path = readingOrder(rest).map((file) => ({
    flagged: hitsByPath.has(file.path),
    path: file.path,
    ...whyAndVerify(file, hitsByPath.get(file.path) ?? []),
  }));

  const claimsToVerify = classification.reasons
    .filter((reason) => reason.severity !== 'info' && (reason.paths?.length ?? 0) === 0)
    .map((reason) => reason.message);

  const markdown = renderMarkdown(
    classification,
    path,
    skim,
    claimsToVerify,
    intent,
    evidence,
    findings
  );
  return { claimsToVerify, markdown, path, skim };
}

type PathEntry = Brief['path'][number];

/**
 * The first `MAX_READ_VISIBLE` entries, plus every flagged one after them (up to
 * `MAX_READ_FLAGGED`), in reading order. A risky file past the tenth is never folded away.
 */
function splitVisible(path: PathEntry[]): {
  visible: { entry: PathEntry; position: number }[];
  collapsed: PathEntry[];
} {
  const visible: { entry: PathEntry; position: number }[] = [];
  const collapsed: PathEntry[] = [];
  let flaggedLate = 0;
  path.forEach((entry, i) => {
    if (i < MAX_READ_VISIBLE || (entry.flagged && flaggedLate++ < MAX_READ_FLAGGED)) {
      visible.push({ entry, position: i + 1 });
    } else {
      collapsed.push(entry);
    }
  });
  return { collapsed, visible };
}

/**
 * What the ticket asked for, ahead of the code. Both lists are model output derived from ticket
 * text, so every entry goes through `escapeText` (one line, bounded, no markup or mentions). The
 * criteria were never checked against the diff, and the heading says so.
 */
function pushIntent(lines: string[], intent: BriefIntent | undefined): void {
  const sections: [string, string[], number][] = [
    [
      '**What was asked** (extracted from the ticket; not checked against the diff)',
      intent?.criteria ?? [],
      MAX_CRITERIA_SHOWN,
    ],
    [
      '**Open questions in the ticket** (unresolved when the run validated it; check how the change handles each)',
      intent?.openQuestions ?? [],
      MAX_QUESTIONS_SHOWN,
    ],
  ];
  for (const [heading, all, max] of sections) {
    const entries = all.filter((entry) => entry.trim() !== '');
    const shown = entries.slice(0, max);
    if (shown.length === 0) {
      continue;
    }
    lines.push(heading, '');
    for (const entry of shown) {
      lines.push(`- ${escapeText(entry)}`);
    }
    if (entries.length > shown.length) {
      lines.push(`- +${entries.length - shown.length} more`);
    }
    lines.push('');
  }
}

const CI_TEXT: Record<NonNullable<BriefEvidence['ci']>, string> = {
  failed: 'failed',
  none: 'no checks reported',
  passed: 'passed',
  pending: 'still running',
};
/** A dashboard address safe to write as a link: no whitespace, brackets or parentheses. */
const SAFE_LINK = /^https?:\/\/[^\s()<>[\]]+$/;

const count = (n: number): string => String(Math.max(0, Math.trunc(Number(n) || 0)));
const plural = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the run recorded about itself, in fixed sentences built from numbers and verdicts: nothing
 * a model or a page wrote reaches this section. It says plainly what it does not check.
 */
function pushEvidence(lines: string[], evidence: BriefEvidence | undefined): void {
  if (!evidence) {
    return;
  }
  const { tests, ui, ci, runUrl } = evidence;
  const items: string[] = [
    tests === null
      ? 'Tests: no result recorded for this head.'
      : tests.total === 0
        ? 'Tests: none ran at this head.'
        : `Tests: ${count(tests.passing)} passing, ${count(tests.failing)} failing at this head.`,
  ];
  if (ui) {
    const kinds = [
      ui.screenshots > 0 ? plural(ui.screenshots, 'screenshot') : '',
      ui.videos > 0 ? plural(ui.videos, 'video') : '',
      ui.traces > 0 ? plural(ui.traces, 'trace') : '',
    ].filter(Boolean);
    items.push(`Browser checks the run captured: ${kinds.join(', ')}.`);
  }
  items.push(`CI on this head: ${ci === null ? 'could not be read' : CI_TEXT[ci]}.`);
  if (runUrl !== null && SAFE_LINK.test(runUrl)) {
    items.push(`[The run's page](${runUrl}) has its full trace.`);
  }
  items.push('Not checked here: whether the tests cover what was asked.');
  lines.push('**Evidence** (what the run recorded; nothing is re-run here)', '');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push('');
}

/**
 * What the review network still raised on this head, worst first. Every field is model output, so
 * each goes through `escapeText` (one line, bounded, no markup or mentions) and the fix is prose,
 * never a suggestion block a reviewer could apply with one click.
 */
function pushFindings(lines: string[], findings: BriefFinding[] | undefined): void {
  if (!findings || findings.length === 0) {
    return;
  }
  lines.push('**Review findings** (raised by the review network on this head; not verified)', '');
  for (const finding of findings.slice(0, MAX_FINDINGS_SHOWN)) {
    const where = codeSpan(
      finding.line === null ? finding.file : `${finding.file}:${finding.line}`
    );
    const fix =
      finding.suggestedFix === '' ? '' : ` Suggested: ${escapeText(finding.suggestedFix)}`;
    lines.push(
      `- **${finding.severity}** ${escapeText(finding.category)} in ${where} - ${escapeText(finding.description)}${fix}`
    );
  }
  if (findings.length > MAX_FINDINGS_SHOWN) {
    lines.push(`- +${findings.length - MAX_FINDINGS_SHOWN} more not shown`);
  }
  lines.push('');
}

function renderMarkdown(
  classification: Classification,
  path: PathEntry[],
  skim: Brief['skim'],
  claims: string[],
  intent?: BriefIntent,
  evidence?: BriefEvidence,
  findings?: BriefFinding[]
): string {
  const lines: string[] = [
    BRIEF_MARKER,
    `### PR evaluation: ${classification.riskClass} risk`,
    '',
    `Approvals required: ${classification.requiredApprovers}`,
    '',
  ];
  if (classification.reasons.some((r) => BOT_APPROVED_REASON_CODES.includes(r.code))) {
    lines.push(BOT_APPROVED_BRIEF_SENTENCE, '');
  }
  const reasons = classification.reasons.filter((reason) => reason.severity !== 'info');
  if (reasons.length > 0) {
    lines.push('**Why this class**', '');
    for (const reason of reasons.slice(0, 20)) {
      const shown = (reason.paths ?? []).slice(0, MAX_REASON_PATHS_SHOWN).map(codeSpan);
      const extra = (reason.paths?.length ?? 0) - shown.length;
      const more = extra > 0 ? ` (+${extra} more)` : '';
      const suffix = shown.length > 0 ? `: ${shown.join(', ')}${more}` : '';
      lines.push(`- ${escapeText(reason.message)}${suffix}`);
    }
    lines.push('');
  }
  pushIntent(lines, intent);
  pushEvidence(lines, evidence);
  pushFindings(lines, findings);
  if (path.length > 0) {
    const { visible, collapsed } = splitVisible(path);
    lines.push('**Read in this order**', '');
    // Bullets with the position written out: a numbered list would renumber a flagged file that
    // sits past the tenth (its neighbours are folded away) as if it were the eleventh.
    for (const { entry, position } of visible) {
      const check = entry.flagged ? ` **Check:** ${escapeText(entry.verify)}` : '';
      lines.push(`- **${position}.** ${codeSpan(entry.path)} - ${escapeText(entry.why)}.${check}`);
    }
    if (collapsed.length > 0) {
      const shown = collapsed.slice(0, MAX_READ_COLLAPSED);
      lines.push(
        '',
        '<details>',
        `<summary>${collapsed.length} more file${collapsed.length === 1 ? '' : 's'}, still in reading order</summary>`,
        ''
      );
      for (const item of shown) {
        lines.push(`- ${codeSpan(item.path)}`);
      }
      if (collapsed.length > shown.length) {
        lines.push(`- +${collapsed.length - shown.length} more`);
      }
      lines.push('', '</details>');
    }
    lines.push('');
  }
  if (claims.length > 0) {
    lines.push('**Verify**', '');
    for (const claim of claims.slice(0, 20)) {
      lines.push(`- ${escapeText(claim)}`);
    }
    lines.push('');
  }
  if (skim.length > 0) {
    lines.push('**Safe to skim** (proven, not guessed)', '');
    for (const item of skim.slice(0, MAX_SKIM_SHOWN)) {
      lines.push(`- ${codeSpan(item.path)} - ${PROOF_TEXT[item.proof]}`);
    }
    if (skim.length > MAX_SKIM_SHOWN) {
      lines.push(`- +${skim.length - MAX_SKIM_SHOWN} more`);
    }
    lines.push('');
  }
  return truncateBrief(lines.join('\n').trimEnd());
}

/**
 * Cuts at a line boundary, so no surrogate pair, HTML entity or code span (all
 * written within one line) is split, then appends the marker. The first line
 * is always kept.
 */
export function truncateBrief(text: string, max: number = MAX_BRIEF_CHARS): string {
  const marker = '\n\n(truncated)';
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf('\n', Math.max(0, max - marker.length));
  const head = cut > 0 ? text.slice(0, cut) : BRIEF_MARKER;
  return `${head.trimEnd()}${marker}`;
}
