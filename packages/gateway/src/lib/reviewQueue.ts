import type { PrismaClient } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import {
  decideNeedsHuman,
  mergeReviewRouting,
  orderReviewQueue,
  parseReviewRoutingOverride,
  type QueueItem,
  type ReviewRouting,
  type RiskClass,
  type RoutingDecision,
} from '@auto-swe/shared/lib/prEvaluation';

/** Evaluation rows read for one queue; far above any queue the pull-request cap allows. */
const EVALUATION_ROW_CAP = 20_000;

const ROUTING_KEYS = [
  'prEvaluation.humanAboveLines',
  'prEvaluation.humanMinRisk',
  'prEvaluation.humanPaths',
  'prEvaluation.humanSkipsBotApproved',
  'prEvaluation.quickReviewMaxLines',
] as const;

/** The repository fields routing reads; select them wherever a queue is built. */
export const ROUTING_REPOSITORY_SELECT = {
  id: true,
  reviewRouting: true,
  team: { select: { orgId: true } },
  teamId: true,
} as const;

export type RoutingRepository = {
  id: string;
  reviewRouting: unknown;
  team: { orgId: string | null } | null;
  teamId: string;
};

/** The pull-request fields a queue is built from. */
export type QueuePullRequest = {
  headSha: string;
  id: string;
  isDraft: boolean;
  openedAt: Date;
  prNumber: number | null;
  repoId: string | null;
  repository: RoutingRepository | null;
  status: string;
};

export type ReviewQueueRow = {
  changedLines: number | null;
  decision: RoutingDecision;
  id: string;
  openedAt: Date;
  quickReviewMaxLines: number;
  riskClass: RiskClass | null;
};

/** The routing in force for a repository: the settings at its scope, its override over them. */
export async function resolveRepositoryRouting(
  repository: Pick<RoutingRepository, 'reviewRouting' | 'team' | 'teamId'>
): Promise<{ effective: ReviewRouting; inherited: ReviewRouting }> {
  const settings = await resolveSettings(ROUTING_KEYS, {
    ...(repository.team?.orgId ? { orgId: repository.team.orgId } : {}),
    teamId: repository.teamId,
  });
  const inherited: ReviewRouting = {
    humanAboveLines: settings['prEvaluation.humanAboveLines'],
    humanMinRisk: settings['prEvaluation.humanMinRisk'] as RiskClass,
    humanPaths: settings['prEvaluation.humanPaths'],
    quickReviewMaxLines: settings['prEvaluation.quickReviewMaxLines'],
    skipWhenBotApproved: settings['prEvaluation.humanSkipsBotApproved'],
  };
  return {
    effective: mergeReviewRouting(inherited, parseReviewRoutingOverride(repository.reviewRouting)),
    inherited,
  };
}

const keyOf = (connectionId: string, prNumber: number, headSha: string) =>
  `${connectionId}:${prNumber}:${headSha}`;

/**
 * Decide, for each pull request, whether it needs a person. Reads each repository's routing once
 * and the newest evaluation of each pull request's CURRENT head: one with no evaluation at that
 * head reads as unevaluated, which needs a person.
 */
export async function buildReviewQueueRows(
  prisma: PrismaClient,
  pulls: readonly QueuePullRequest[]
): Promise<ReviewQueueRow[]> {
  const repositories = new Map<string, RoutingRepository>();
  for (const pull of pulls) {
    if (pull.repository) {
      repositories.set(pull.repository.id, pull.repository);
    }
  }
  const policies = new Map<string, ReviewRouting>();
  await Promise.all(
    [...repositories.values()].map(async (repository) => {
      policies.set(repository.id, (await resolveRepositoryRouting(repository)).effective);
    })
  );

  const evaluable = pulls.filter(
    (pull) => pull.repository !== null && pull.repoId !== null && pull.prNumber !== null
  );
  // The brief is the only column that can be large, and only an always-human path reads it.
  const needsPaths = [...policies.values()].some((policy) => policy.humanPaths.length > 0);
  const evaluations =
    evaluable.length === 0
      ? []
      : await prisma.prEvaluation.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            autoMergeEnabled: true,
            botApproved: true,
            ...(needsPaths ? { brief: true } : {}),
            changedLines: true,
            connectionId: true,
            headSha: true,
            prNumber: true,
            requiredApprovers: true,
            riskClass: true,
            trustedApprovers: true,
          },
          take: EVALUATION_ROW_CAP,
          where: {
            connectionId: { in: [...new Set(evaluable.map((p) => p.repoId as string))] },
            headSha: { in: [...new Set(evaluable.map((p) => p.headSha))] },
            prNumber: { in: [...new Set(evaluable.map((p) => p.prNumber as number))] },
          },
        });
  // Newest first, so the first row seen for a key is the newest.
  const current = new Map<string, (typeof evaluations)[number]>();
  for (const row of evaluations) {
    const key = keyOf(row.connectionId, row.prNumber, row.headSha);
    if (!current.has(key)) {
      current.set(key, row);
    }
  }

  return pulls.map((pull) => {
    const policy = (pull.repository && policies.get(pull.repository.id)) as ReviewRouting;
    const row =
      pull.repoId !== null && pull.prNumber !== null
        ? current.get(keyOf(pull.repoId, pull.prNumber, pull.headSha))
        : undefined;
    const effective: ReviewRouting = policy ?? {
      humanAboveLines: 0,
      humanMinRisk: 'LOW',
      humanPaths: [],
      quickReviewMaxLines: 0,
      skipWhenBotApproved: false,
    };
    const decision = decideNeedsHuman(
      {
        evaluation: row
          ? {
              autoMergeEnabled: row.autoMergeEnabled,
              botApproved: row.botApproved,
              changedLines: row.changedLines,
              paths: briefPaths('brief' in row ? row.brief : null),
              requiredApprovers: row.requiredApprovers,
              riskClass: row.riskClass as RiskClass,
              trustedApprovers: row.trustedApprovers,
            }
          : null,
        isDraft: pull.isDraft,
        status: pull.status as 'OPEN' | 'MERGED' | 'CLOSED',
      },
      effective
    );
    return {
      changedLines: row?.changedLines ?? null,
      decision,
      id: pull.id,
      openedAt: pull.openedAt,
      quickReviewMaxLines: effective.quickReviewMaxLines,
      riskClass: row ? (row.riskClass as RiskClass) : null,
    };
  });
}

/** The files a stored brief lists to read; a brief of any other shape lists none. */
function briefPaths(brief: unknown): string[] {
  if (!brief || typeof brief !== 'object' || !('path' in brief)) {
    return [];
  }
  const path = (brief as { path: unknown }).path;
  if (!Array.isArray(path)) {
    return [];
  }
  return path.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string'
      ? [(entry as { path: string }).path]
      : []
  );
}

/** The queue order of already-built rows. */
export function orderRows(rows: readonly ReviewQueueRow[]) {
  const items: QueueItem[] = rows.map((row) => ({ ...row }));
  return orderReviewQueue(items);
}
