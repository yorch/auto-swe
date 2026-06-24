/**
 * Eval signal capture — P0 of the evals feature (docs/evals-p0.md).
 *
 * Records the quality signals the system already computes as normalized
 * `EvalResult` rows: quality-gate pass/fail (GATE), review-network verdicts
 * (REVIEW), and the human PR merge/reject (MERGE). One row per scorer so axes
 * stay decomposable for trend/regression queries.
 *
 * Every write is **best-effort**: a capture failure (DB hiccup, missing run
 * link) is swallowed so it can never break the activity, workflow, or webhook
 * that produced the signal. This mirrors the artifact-store + AgentTracer
 * best-effort persistence pattern. P0 changes no agent behavior and gates
 * nothing — it only records.
 */

import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import type { ReviewVerdict } from '@auto-swe/shared/types/workflow';
import type { GateResult } from '../activities/qualityGates.js';

/**
 * Review-network severity → normalized score. Exported so P2 judge calibration
 * reuses the same scale rather than re-deriving it.
 */
export const REVIEW_SEVERITY_SCORE: Record<ReviewVerdict['severity'], number> = {
  CRITICAL: 0.0,
  INFO: 0.9,
  PASS: 1.0,
  WARNING: 0.5,
};

export interface EvalResultInput {
  runId?: string;
  nodeId?: string;
  agentKey?: string;
  /** Offline harness linkage (P1): the EvalCase scored + the EvalRun it belongs to. */
  caseId?: string;
  evalRunId?: string;
  source: 'GATE' | 'REVIEW' | 'MERGE' | 'JUDGE' | 'TRAJECTORY';
  scorer: string;
  scoreType: 'BOOLEAN' | 'NUMERIC' | 'CATEGORICAL';
  value: number;
  passed?: boolean;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persist one normalized eval signal. Best-effort: never throws.
 */
export async function recordEvalResult(input: EvalResultInput): Promise<void> {
  try {
    const { metadata, ...rest } = input;
    await prisma.evalResult.create({
      data: {
        ...rest,
        ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
    });
  } catch {
    // Capture must never break the caller. Swallow (mirrors artifact-store /
    // AgentTracer best-effort persistence).
  }
}

/**
 * Capture a quality-gate result as a BOOLEAN eval signal.
 */
export async function recordGateEval(
  gate: string,
  result: GateResult,
  runId?: string
): Promise<void> {
  await recordEvalResult({
    metadata: {
      artifactId: result.artifactId,
      exitCode: result.exitCode,
      signal: result.signal,
    },
    nodeId: gate,
    passed: result.passed,
    runId,
    scorer: `gate:${gate}`,
    scoreType: 'BOOLEAN',
    source: 'GATE',
    value: result.passed ? 1 : 0,
  });
}

/**
 * Capture each review-network verdict as a NUMERIC eval signal (severity →
 * score). One row per reviewer — no aggregate row, so the axes stay
 * decomposable (RFC §2).
 */
export async function recordReviewEval(verdicts: ReviewVerdict[], runId?: string): Promise<void> {
  await Promise.all(
    verdicts.map((v) =>
      recordEvalResult({
        agentKey: 'reviewer',
        metadata: { findingsCount: v.findings.length, severity: v.severity },
        passed: v.approved,
        runId,
        scorer: `review:${v.reviewer}`,
        scoreType: 'NUMERIC',
        source: 'REVIEW',
        value: REVIEW_SEVERITY_SCORE[v.severity],
      })
    )
  );
}
