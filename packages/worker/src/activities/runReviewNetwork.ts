import { heartbeat } from '@temporalio/activity';
import type { CodeResult, AggregatedReviewResult } from '@auto-swe/shared/types/workflow';
import { runReviewNetwork as runReview } from '../agents/reviewNetwork.js';

/**
 * Runs the review network (Security Auditor, Domain Logic, Performance Reviewer)
 * in parallel and aggregates their verdicts.
 */
export async function runReviewNetwork(
  codeResult: CodeResult,
): Promise<AggregatedReviewResult> {
  heartbeat('starting review network');

  const result = await runReview(codeResult);

  heartbeat(`review complete: ${result.approved ? 'approved' : 'rejected'}`);

  return result;
}
