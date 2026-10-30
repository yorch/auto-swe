/**
 * The evidence gate for auto mode. An evaluation row counts as evidence only when it was `LOW`,
 * merged inside the window, was not marked a bad merge, and recorded the three facts the
 * evaluation writes (a requester, a minimum amount of change, and at least one trusted
 * approval). Rows written before those facts existed carry NULL and so do not count.
 *
 * The gate has two scopes and both must pass: the whole deployment (volume, no bad merge, and
 * several distinct requesters) and the one repository (its own volume, no bad merge of its own).
 * "Deployment" is literal: every organization and team on the instance shares one history.
 */

export const EVIDENCE_WINDOW_DAYS = 90;

export type PrEvaluationEvidence = {
  deployment: { lowMerged: number; badMerges: number; distinctRequesters: number };
  repository: { lowMerged: number; badMerges: number };
  windowDays: typeof EVIDENCE_WINDOW_DAYS;
};

export type EvidenceThresholds = {
  minEvidence: number;
  minRepoEvidence: number;
  minDistinctRequesters: number;
};

type CountWhere = {
  riskClass: string;
  mergedAt: { gte: Date };
  badMerge?: boolean;
  connectionId?: string;
  requesterId?: { not: null };
  changedLines?: { gte: number };
  trustedApprovers?: { gte: number };
};

/** The slice of the Prisma client the gate reads, so a test can pass a stand-in. */
export type PrEvaluationEvidenceDb = {
  prEvaluation: {
    count(args: { where: CountWhere }): Promise<number>;
    groupBy(args: {
      by: ['requesterId'];
      where: CountWhere;
    }): Promise<{ requesterId: string | null }[]>;
  };
};

export async function prEvaluationEvidence(
  db: PrEvaluationEvidenceDb,
  connectionId: string,
  now: Date,
  minChangedLines: number
): Promise<PrEvaluationEvidence> {
  const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const base = { mergedAt: { gte: since }, riskClass: 'LOW' };
  const counted = {
    ...base,
    badMerge: false,
    changedLines: { gte: minChangedLines },
    requesterId: { not: null },
    trustedApprovers: { gte: 1 },
  } satisfies CountWhere;
  const bad = { ...base, badMerge: true } satisfies CountWhere;
  const here = { connectionId };
  const [deploymentLow, deploymentBad, repoLow, repoBad, requesters] = await Promise.all([
    db.prEvaluation.count({ where: counted }),
    db.prEvaluation.count({ where: bad }),
    db.prEvaluation.count({ where: { ...counted, ...here } }),
    db.prEvaluation.count({ where: { ...bad, ...here } }),
    // One group per distinct requester, counted by the database over the same filter.
    db.prEvaluation.groupBy({ by: ['requesterId'], where: counted }),
  ]);
  return {
    deployment: {
      badMerges: deploymentBad,
      distinctRequesters: requesters.filter((r) => r.requesterId !== null).length,
      lowMerged: deploymentLow,
    },
    repository: { badMerges: repoBad, lowMerged: repoLow },
    windowDays: EVIDENCE_WINDOW_DAYS,
  };
}

/** Whether both scopes pass, and a sentence for each condition that does not. No identifiers. */
export function autoEvidenceAssessment(
  evidence: PrEvaluationEvidence,
  thresholds: EvidenceThresholds
): { satisfied: boolean; unmet: string[] } {
  const days = evidence.windowDays;
  const unmet: string[] = [];
  if (evidence.deployment.lowMerged < thresholds.minEvidence) {
    unmet.push(
      `deployment-wide: ${evidence.deployment.lowMerged} qualifying low-risk merges in ${days} days (need ${thresholds.minEvidence})`
    );
  }
  if (evidence.deployment.badMerges > 0) {
    unmet.push(
      `deployment-wide: ${evidence.deployment.badMerges} low-risk merge(s) marked bad in ${days} days (need 0)`
    );
  }
  if (evidence.deployment.distinctRequesters < thresholds.minDistinctRequesters) {
    unmet.push(
      `deployment-wide: qualifying merges came from ${evidence.deployment.distinctRequesters} distinct requester(s) (need ${thresholds.minDistinctRequesters})`
    );
  }
  if (evidence.repository.lowMerged < thresholds.minRepoEvidence) {
    unmet.push(
      `this repository: ${evidence.repository.lowMerged} qualifying low-risk merges in ${days} days (need ${thresholds.minRepoEvidence})`
    );
  }
  if (evidence.repository.badMerges > 0) {
    unmet.push(
      `this repository: ${evidence.repository.badMerges} low-risk merge(s) marked bad in ${days} days (need 0)`
    );
  }
  return { satisfied: unmet.length === 0, unmet };
}
