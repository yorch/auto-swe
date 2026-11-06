import { REVIEW_HARD_MAX_DIFF_CHARS, REVIEW_MAX_DIFF_CHARS } from '@auto-swe/shared/lib/codeReview';
import type { ReviewVerdict } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';

export function reviewChunks(diff: string, bound = REVIEW_MAX_DIFF_CHARS): string[] {
  if (diff.length > REVIEW_HARD_MAX_DIFF_CHARS) {
    throw ApplicationFailure.nonRetryable(
      'Review diff exceeds the hard cap',
      'REVIEW_DIFF_TOO_LARGE'
    );
  }
  if (diff.length <= bound) {
    return [diff];
  }
  const pieces: string[] = [];
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    if (file.length <= bound) {
      pieces.push(file);
      continue;
    }
    const offset = file.search(/^@@ /m);
    const header = offset >= 0 ? file.slice(0, offset) : '';
    const prefix = header.length < bound / 2 ? header : '';
    const body = prefix ? file.slice(offset) : file;
    const capacity = bound - prefix.length;
    for (const hunk of body.split(/(?=^@@ )/m).filter(Boolean)) {
      for (let start = 0; start < hunk.length; ) {
        const end = Math.min(start + capacity, hunk.length);
        const newline = hunk.lastIndexOf('\n', end - 1) + 1;
        const stop = end < hunk.length && newline > start ? newline : end;
        pieces.push(prefix + hunk.slice(start, stop));
        start = stop;
      }
    }
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && (chunks[last]?.length ?? 0) + piece.length <= bound) {
      chunks[last] += piece;
    } else {
      chunks.push(piece);
    }
  }
  return chunks;
}

export function mergeChunkVerdicts(verdicts: ReviewVerdict[]): ReviewVerdict[] {
  const order = ['PASS', 'INFO', 'WARNING', 'CRITICAL'];
  const merged = new Map<ReviewVerdict['reviewer'], ReviewVerdict>();
  for (const verdict of verdicts) {
    const current = merged.get(verdict.reviewer);
    const findings = [...(current?.findings ?? []), ...verdict.findings];
    const unique = new Map(
      findings.map((finding) => [
        JSON.stringify([
          finding.file,
          finding.line,
          finding.category,
          finding.description,
          finding.suggestedFix,
        ]),
        finding,
      ])
    );
    merged.set(verdict.reviewer, {
      ...verdict,
      approved: verdict.approved && (current?.approved ?? true),
      findings: [...unique.values()],
      severity:
        current && order.indexOf(current.severity) > order.indexOf(verdict.severity)
          ? current.severity
          : verdict.severity,
    });
  }
  return [...merged.values()];
}
