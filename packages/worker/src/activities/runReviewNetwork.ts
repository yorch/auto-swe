import type { AggregatedReviewResult, CodeResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';

/**
 * Runs the review network (Security Auditor, Domain Logic, Performance Reviewer)
 * in parallel and aggregates their verdicts.
 */
export async function runReviewNetwork(
  codeResult: CodeResult,
  successCriteria?: string[]
): Promise<AggregatedReviewResult> {
  heartbeat('starting review network');

  const result = await runReview(codeResult, successCriteria);

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  return result;
}
