import { createHash } from 'node:crypto';
import {
  type BriefFinding,
  escapeText,
  FINDING_MARKER_PREFIX,
  FINDING_REVIEW_MARKER,
} from '@auto-swe/shared/lib/prEvaluation';
import { logWarn } from './activityLog.js';
import type { RepoRef, ScmProvider } from './scm/types.js';

/**
 * Posts the review network's findings that fall inside the diff as inline comments, in one review
 * on the evaluated head. It is advisory and never throws: a failure is logged by class and the
 * brief, which always carries the findings, stands on its own.
 *
 * Three rules keep it from doing harm. The review is created through `createReview`, which has no
 * way to approve or request changes. Every comment carries a marker made from its finding, so a
 * retry or a later evaluation of the same head posts nothing twice. And every word of a comment is
 * model text, so it is escaped onto one line, `/auto-swe` is broken so a comment can never read as
 * the feedback command, and a suggested fix is prose, never a suggestion block.
 */

export const MAX_INLINE_FINDINGS = 10;
const MARKER_KEY = new RegExp(
  `${FINDING_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]+) -->`,
  'g'
);

export function findingKey(finding: BriefFinding): string {
  return createHash('sha1')
    .update(`${finding.reviewer}\0${finding.file}\0${finding.line}\0${finding.category}`)
    .digest('hex')
    .slice(0, 16);
}

const neutral = (text: string): string => escapeText(text).replace(/\/auto-swe\b/gi, '/ auto-swe');

export function findingCommentBody(finding: BriefFinding): string {
  const fix = finding.suggestedFix === '' ? '' : `\n\nSuggested: ${neutral(finding.suggestedFix)}`;
  return [
    `**${finding.severity}** ${neutral(finding.category)} (${neutral(finding.reviewer)})`,
    `\n\n${neutral(finding.description)}${fix}`,
    `\n\n${FINDING_MARKER_PREFIX}${findingKey(finding)} -->`,
  ].join('');
}

export async function postFindingComments(input: {
  connectionId: string;
  findings: readonly BriefFinding[];
  headSha: string;
  prNumber: number;
  repo: RepoRef;
  scm: Pick<ScmProvider, 'createReview' | 'getPullRequest' | 'listReviewThreads'>;
}): Promise<{ posted: number; reason?: string }> {
  const meta = { connectionId: input.connectionId, prNumber: input.prNumber };
  try {
    const anchored = input.findings
      .filter((f): f is BriefFinding & { line: number } => f.line !== null)
      .slice(0, MAX_INLINE_FINDINGS);
    if (anchored.length === 0) {
      return { posted: 0, reason: 'no anchored finding' };
    }
    const threads = await input.scm.listReviewThreads(input.repo, input.prNumber);
    const already = new Set<string>();
    for (const thread of threads) {
      for (const comment of thread.comments) {
        for (const match of comment.body.matchAll(MARKER_KEY)) {
          already.add(match[1] as string);
        }
      }
    }
    const fresh = anchored.filter((f) => !already.has(findingKey(f)));
    if (fresh.length === 0) {
      return { posted: 0, reason: 'already posted' };
    }
    // The comments name this commit: a head that moved since the evaluation read it would have the
    // host refuse them, or anchor them to lines that are no longer there.
    const pr = await input.scm.getPullRequest(input.repo, input.prNumber);
    if (!pr || pr.headSha.toLowerCase() !== input.headSha.toLowerCase()) {
      return { posted: 0, reason: 'head moved' };
    }
    const result = await input.scm.createReview(input.repo, input.prNumber, {
      body: `${FINDING_REVIEW_MARKER}\nThe review network raised these on this head. They are advisory and were not checked.`,
      comments: fresh.map((f) => ({ body: findingCommentBody(f), line: f.line, path: f.file })),
      commitId: input.headSha,
    });
    if (!result.ok) {
      logWarn('pr evaluation: the host refused the findings review', meta);
      return { posted: 0, reason: 'refused' };
    }
    return { posted: fresh.length };
  } catch (err) {
    logWarn('pr evaluation: the findings could not be posted', {
      ...meta,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return { posted: 0, reason: 'error' };
  }
}
