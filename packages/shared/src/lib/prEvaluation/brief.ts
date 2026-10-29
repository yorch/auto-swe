import { matchesAny } from './paths.js';
import type {
  Brief,
  ChangedFile,
  Classification,
  EffectivePolicy,
  Reason,
  SkimProof,
} from './types.js';

/** First line of the comment, so the writer can find and update its own comment. */
export const BRIEF_MARKER = '<!-- auto-swe:pr-evaluation -->';
export const MAX_FOCUS = 10;
export const MAX_BRIEF_CHARS = 60_000;
const MAX_SKIM_SHOWN = 50;
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
function escapeText(raw: string): string {
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

export function buildBrief(
  files: ChangedFile[],
  classification: Classification,
  effective: EffectivePolicy
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

  const ranked = [...rest].sort((a, b) => {
    const hitDelta = Number(hitsByPath.has(b.path)) - Number(hitsByPath.has(a.path));
    if (hitDelta !== 0) {
      return hitDelta;
    }
    const churnDelta = b.additions + b.deletions - (a.additions + a.deletions);
    if (churnDelta !== 0) {
      return churnDelta;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const focus = ranked.slice(0, MAX_FOCUS).map((file) => ({
    path: file.path,
    ...whyAndVerify(file, hitsByPath.get(file.path) ?? []),
  }));

  const claimsToVerify = classification.reasons
    .filter((reason) => reason.severity !== 'info' && (reason.paths?.length ?? 0) === 0)
    .map((reason) => reason.message);

  const markdown = renderMarkdown(
    classification,
    focus,
    ranked.length - focus.length,
    skim,
    claimsToVerify
  );
  return { claimsToVerify, focus, markdown, skim };
}

function renderMarkdown(
  classification: Classification,
  focus: Brief['focus'],
  moreFocus: number,
  skim: Brief['skim'],
  claims: string[]
): string {
  const lines: string[] = [
    BRIEF_MARKER,
    `### PR evaluation: ${classification.riskClass} risk`,
    '',
    `Approvals required: ${classification.requiredApprovers}`,
    '',
  ];
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
  if (focus.length > 0) {
    lines.push('**Focus your review here**', '');
    focus.forEach((item, i) => {
      lines.push(
        `${i + 1}. ${codeSpan(item.path)} - ${escapeText(item.why)}. ${escapeText(item.verify)}`
      );
    });
    if (moreFocus > 0) {
      lines.push(`- +${moreFocus} more file${moreFocus === 1 ? '' : 's'} not listed`);
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
