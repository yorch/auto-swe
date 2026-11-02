import { readingOrder } from './brief.js';
import type { BriefEvidence, BriefFinding, ChangedFile } from './types.js';

/**
 * Picks, from the review network's verdicts for one head, the findings worth a human's time. A
 * pure function of the verdicts (model output, so every field is checked), the changed files and
 * the head's CI verdict; the brief and the inline comments both read its answer, so they agree.
 */

/**
 * What every inline finding comment carries, so the platform's own comments can be recognised: the
 * feedback automation must not read them as a person's feedback, and the engagement counts must not
 * count them as a reviewer's.
 */
export const FINDING_MARKER_PREFIX = '<!-- auto-swe:finding ';
export const FINDING_REVIEW_MARKER = '<!-- auto-swe:review-findings -->';

export function isFindingComment(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(FINDING_MARKER_PREFIX);
}

/** A finding with no usable file, or one the network invented for a reviewer that crashed. */
const CRASH_CATEGORY = 'REVIEWER_CRASH';

/**
 * Categories a failing CI run already says: style, formatting and type errors. A coarse rule on the
 * category's words only, so a finding that merely mentions one of them in its description stays.
 */
const CI_COVERED_CATEGORY =
  /\b(lint(?:er|ing)?|style|format(?:ting)?|prettier|eslint|type[- ]?(?:check|error)s?)\b/i;

const NEW_SIDE_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Whether `line` of the file's new side appears in its patch: an added line or a context line, the
 * ones a review comment can be anchored to. Model-supplied line numbers are guesses, so a line
 * outside every hunk (or a patch GitHub withheld) is not anchorable.
 */
export function lineInDiff(patch: string | undefined, line: number): boolean {
  if (!patch || !Number.isSafeInteger(line) || line < 1) {
    return false;
  }
  const rows = patch.split('\n');
  if (rows.at(-1) === '') {
    rows.pop();
  }
  let next = 0;
  let inHunk = false;
  for (const row of rows) {
    const header = NEW_SIDE_HUNK.exec(row);
    if (header) {
      next = Number(header[1]);
      inHunk = true;
    } else if (inHunk && !row.startsWith('\\') && !row.startsWith('-')) {
      if (next === line) {
        return true;
      }
      next++;
    }
  }
  return false;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

type RawFinding = { category?: unknown; description?: unknown; file?: unknown; line?: unknown };
type RawVerdict = { findings?: unknown; reviewer?: unknown; severity?: unknown };

export const MAX_SELECTED_FINDINGS = 50;

export function selectReviewFindings(
  verdicts: unknown,
  files: readonly ChangedFile[],
  ci: BriefEvidence['ci']
): BriefFinding[] {
  if (!Array.isArray(verdicts)) {
    return [];
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const position = new Map(readingOrder(files).map((file, i) => [file.path, i]));
  const seen = new Set<string>();
  const selected: BriefFinding[] = [];
  for (const verdict of verdicts as RawVerdict[]) {
    const severity = verdict?.severity;
    if ((severity !== 'WARNING' && severity !== 'CRITICAL') || !Array.isArray(verdict.findings)) {
      continue;
    }
    for (const raw of verdict.findings as RawFinding[]) {
      const file = text(raw?.file);
      const category = text(raw?.category);
      const description = text(raw?.description);
      const changed = byPath.get(file);
      if (!changed || category === CRASH_CATEGORY || description === '') {
        continue;
      }
      if (ci === 'failed' && CI_COVERED_CATEGORY.test(category)) {
        continue;
      }
      const line =
        typeof raw.line === 'number' && lineInDiff(changed.patch, raw.line) ? raw.line : null;
      const reviewer = text(verdict.reviewer) || 'REVIEWER';
      const key = `${reviewer}\0${file}\0${line}\0${category}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      selected.push({
        category,
        description,
        file,
        line,
        reviewer,
        severity,
        suggestedFix: text((raw as { suggestedFix?: unknown }).suggestedFix),
      });
    }
  }
  const rank = (finding: BriefFinding): number => (finding.severity === 'CRITICAL' ? 0 : 1);
  return selected
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (position.get(a.file) ?? 0) - (position.get(b.file) ?? 0) ||
        (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
        (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
    )
    .slice(0, MAX_SELECTED_FINDINGS);
}
