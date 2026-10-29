/**
 * The evidence gate for auto mode: how many low-risk pull requests merged recently, and how many
 * of those were later marked bad (reverted). Org-wide by design: auto mode is a deployment-level
 * claim that the classifier can be trusted, not a per-repository one.
 */

export const EVIDENCE_WINDOW_DAYS = 90;

export type PrEvaluationEvidence = {
  lowMerged: number;
  badMerges: number;
  windowDays: typeof EVIDENCE_WINDOW_DAYS;
};

/** The slice of the Prisma client the gate reads, so a test can pass a stand-in. */
export type PrEvaluationEvidenceDb = {
  prEvaluation: {
    count(args: {
      where: { riskClass: string; mergedAt: { gte: Date }; badMerge?: boolean };
    }): Promise<number>;
  };
};

export async function prEvaluationEvidence(
  db: PrEvaluationEvidenceDb,
  now: Date
): Promise<PrEvaluationEvidence> {
  const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = { mergedAt: { gte: since }, riskClass: 'LOW' };
  const [lowMerged, badMerges] = await Promise.all([
    db.prEvaluation.count({ where }),
    db.prEvaluation.count({ where: { ...where, badMerge: true } }),
  ]);
  return { badMerges, lowMerged, windowDays: EVIDENCE_WINDOW_DAYS };
}

/** Enough low-risk merges, and none of them bad. */
export function autoEvidenceSatisfied(
  evidence: Pick<PrEvaluationEvidence, 'lowMerged' | 'badMerges'>,
  minEvidence: number
): boolean {
  return evidence.lowMerged >= minEvidence && evidence.badMerges === 0;
}
