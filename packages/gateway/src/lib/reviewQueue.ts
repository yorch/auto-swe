import type { PrismaClient } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import {
  createRoutingMatchBudget,
  decideNeedsHuman,
  mergeReviewRouting,
  orderReviewQueue,
  parseReviewRoutingOverride,
  parseRoutingFacts,
  type QueueItem,
  type ReviewRouting,
  type RiskClass,
  ROUTING_REPOSITORY_MATCH_BUDGET,
  type RoutingDecision,
  type RoutingFacts,
  toRiskClass,
} from '@auto-swe/shared/lib/prEvaluation';

/** Evaluation rows read for one queue; far above any queue the pull-request cap allows. */
export const EVALUATION_ROW_CAP = 20_000;
/** Pull requests whose stored path lists are held in memory at once. */
const ROUTING_PATHS_CHUNK = 100;

const ROUTING_KEYS = [
  'prEvaluation.defaultMode',
  'prEvaluation.enabled',
  'prEvaluation.humanAboveLines',
  'prEvaluation.humanMinRisk',
  'prEvaluation.humanPaths',
  'prEvaluation.humanSkipsBotApproved',
  'prEvaluation.quickReviewMaxLines',
] as const;

/** The repository fields routing reads; select them wherever a queue is built. */
export const ROUTING_REPOSITORY_SELECT = {
  id: true,
  isActive: true,
  prEvaluationMode: true,
  reviewRouting: true,
  team: { select: { orgId: true } },
  teamId: true,
} as const;

export type RoutingRepository = {
  id: string;
  isActive: boolean;
  prEvaluationMode: string | null;
  reviewRouting: unknown;
  team: { orgId: string | null } | null;
  teamId: string;
};

/** The pull-request fields a queue is built from. */
export type QueuePullRequest = {
  headSha: string;
  /** The head the host last reported (a push, a synchronize webhook); null until one arrived. */
  hostHeadSha: string | null;
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

/** What one queue build returns. */
export type ReviewQueueResult = {
  /** The evaluation read hit its row cap, so a pull request's evaluation may be missing from it. */
  evaluationsTruncated: boolean;
  rows: ReviewQueueRow[];
};

/** Routing for a pull request whose repository is unknown: the strictest reading. */
const STRICTEST_ROUTING: ReviewRouting = {
  humanAboveLines: 0,
  humanMinRisk: 'LOW',
  humanPaths: [],
  quickReviewMaxLines: 0,
  skipWhenBotApproved: false,
};

/**
 * The routing in force for a repository: the settings at its scope, its override over them (which
 * can only add strictness). `evaluating` says whether evaluations are being kept current for the
 * repository; when they are not, a stored evaluation is a snapshot nothing refreshes and must not
 * decide anything.
 */
export async function resolveRepositoryRouting(
  repository: Pick<RoutingRepository, 'reviewRouting' | 'team' | 'teamId'> &
    Partial<Pick<RoutingRepository, 'isActive' | 'prEvaluationMode'>>
): Promise<{ effective: ReviewRouting; evaluating: boolean; inherited: ReviewRouting }> {
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
  const mode = repository.prEvaluationMode ?? settings['prEvaluation.defaultMode'];
  return {
    effective: mergeReviewRouting(inherited, parseReviewRoutingOverride(repository.reviewRouting)),
    evaluating:
      settings['prEvaluation.enabled'] === true && repository.isActive !== false && mode !== 'off',
    inherited,
  };
}

const pairKey = (connectionId: string, prNumber: number) => `${connectionId}:${prNumber}`;

/**
 * The newest evaluation of each (repository, pull request) pair, from small columns only: the
 * stored brief and path list are never read here. Rows are read newest first up to the cap, so a
 * cut drops the oldest rows overall and a pair that keeps any row keeps its newest one.
 */
async function newestEvaluations(prisma: PrismaClient, pulls: readonly QueuePullRequest[]) {
  const numbersByRepository = new Map<string, Set<number>>();
  for (const pull of pulls) {
    if (pull.repoId !== null && pull.prNumber !== null) {
      const numbers = numbersByRepository.get(pull.repoId) ?? new Set<number>();
      numbers.add(pull.prNumber);
      numbersByRepository.set(pull.repoId, numbers);
    }
  }
  if (numbersByRepository.size === 0) {
    return { newest: new Map<string, never>(), truncated: false };
  }
  const rows = await prisma.prEvaluation.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      autoMergeEnabled: true,
      botApproved: true,
      changedLines: true,
      changesRequestedCount: true,
      connectionId: true,
      headSha: true,
      humanObjection: true,
      id: true,
      prNumber: true,
      requiredApprovers: true,
      riskClass: true,
      trustedApprovers: true,
    },
    take: EVALUATION_ROW_CAP + 1,
    // Exact pairs: each repository asks only for its own pull requests' numbers.
    where: {
      OR: [...numbersByRepository].map(([connectionId, numbers]) => ({
        connectionId,
        prNumber: { in: [...numbers] },
      })),
    },
  });
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows.slice(0, EVALUATION_ROW_CAP)) {
    const key = pairKey(row.connectionId, row.prNumber);
    if (!newest.has(key)) {
      newest.set(key, row);
    }
  }
  return { newest, truncated: rows.length > EVALUATION_ROW_CAP };
}

/**
 * Decide, for each pull request, whether it needs a person.
 *
 * Reads each repository's routing once and the NEWEST evaluation of each pull request. That
 * evaluation counts only when its head is the head the pull request row holds; otherwise the row
 * has not caught up with a push (or the push has no evaluation yet) and nothing says the current
 * head is safe, so the pull request reads as unevaluated and needs a person. Approvals are the
 * ones counted at that head, never an older one's.
 */
export async function buildReviewQueueRows(
  prisma: PrismaClient,
  pulls: readonly QueuePullRequest[]
): Promise<ReviewQueueResult> {
  const repositories = new Map<string, RoutingRepository>();
  for (const pull of pulls) {
    if (pull.repository) {
      repositories.set(pull.repository.id, pull.repository);
    }
  }
  const policies = new Map<string, ReviewRouting>();
  const evaluating = new Map<string, boolean>();
  await Promise.all(
    [...repositories.values()].map(async (repository) => {
      const resolved = await resolveRepositoryRouting(repository);
      policies.set(repository.id, resolved.effective);
      evaluating.set(repository.id, resolved.evaluating);
    })
  );

  const { newest, truncated } = await newestEvaluations(prisma, pulls);
  type Newest = typeof newest extends Map<string, infer Row> ? Row : never;

  const items = pulls.map((pull) => {
    const policy = (pull.repository && policies.get(pull.repository.id)) || STRICTEST_ROUTING;
    const found: Newest | undefined =
      pull.repoId !== null && pull.prNumber !== null
        ? newest.get(pairKey(pull.repoId, pull.prNumber))
        : undefined;
    // The evaluation counts only at the head the host last reported (a push the platform has
    // not evaluated leaves the newest row at an older head), and only while evaluations are
    // being kept current for the repository: switched off, a stored row is a stale snapshot.
    const currentHead = pull.hostHeadSha ?? pull.headSha;
    const kept = pull.repository !== null && evaluating.get(pull.repository.id) === true;
    const row = kept && found && found.headSha === currentHead ? found : undefined;
    return { policy, pull, row };
  });
  type Item = (typeof items)[number];

  // One budget for the request and one per repository: a repository with costly globs cannot use
  // up the work another repository's pull requests need, and the request stays bounded overall.
  const requestBudget = createRoutingMatchBudget();
  const repositoryBudgets = new Map<string, ReturnType<typeof createRoutingMatchBudget>>();
  const budgetsFor = (item: { pull: QueuePullRequest }) => {
    const key = item.pull.repository?.id ?? '';
    let own = repositoryBudgets.get(key);
    if (!own) {
      own = createRoutingMatchBudget(ROUTING_REPOSITORY_MATCH_BUDGET);
      repositoryBudgets.set(key, own);
    }
    return [requestBudget, own];
  };
  const decide = (item: Item, routing: RoutingFacts | null): RoutingDecision =>
    decideNeedsHuman(
      {
        evaluation: item.row
          ? {
              autoMergeEnabled: item.row.autoMergeEnabled,
              botApproved: item.row.botApproved,
              changedLines: item.row.changedLines,
              // The flag is written when the row is created; a request for changes after that
              // only bumps the count on the same row. Either one stands the objection.
              humanObjection:
                item.row.humanObjection === true || item.row.changesRequestedCount > 0,
              requiredApprovers: item.row.requiredApprovers,
              riskClass: toRiskClass(item.row.riskClass),
              routing,
              trustedApprovers: item.row.trustedApprovers,
            }
          : null,
        isDraft: item.pull.isDraft,
        status: item.pull.status as 'OPEN' | 'MERGED' | 'CLOSED',
      },
      item.policy,
      budgetsFor(item)
    );

  // The path list is large, so it is read only for pull requests whose rules look at it, and a
  // chunk at a time: decisions are made and the lists dropped before the next chunk is read.
  const wantsPaths = (item: Item) =>
    item.row !== undefined &&
    item.pull.status === 'OPEN' &&
    !item.pull.isDraft &&
    item.policy.humanPaths.length > 0;
  const decisions = new Map<string, RoutingDecision>();
  for (const item of items) {
    if (!wantsPaths(item)) {
      decisions.set(item.pull.id, decide(item, null));
    }
  }
  const withPaths = items.filter(wantsPaths);
  for (let at = 0; at < withPaths.length; at += ROUTING_PATHS_CHUNK) {
    const chunk = withPaths.slice(at, at + ROUTING_PATHS_CHUNK);
    const idOf = (item: Item) => (item.row as NonNullable<Item['row']>).id;
    const stored = await prisma.prEvaluation.findMany({
      select: { id: true, routingPaths: true },
      where: { id: { in: chunk.map(idOf) } },
    });
    const byId = new Map(stored.map((row) => [row.id, row.routingPaths]));
    for (const item of chunk) {
      decisions.set(item.pull.id, decide(item, parseRoutingFacts(byId.get(idOf(item)))));
    }
  }

  return {
    evaluationsTruncated: truncated,
    rows: items.map(({ policy, pull, row }) => ({
      changedLines: row?.changedLines ?? null,
      decision: decisions.get(pull.id) as RoutingDecision,
      id: pull.id,
      openedAt: pull.openedAt,
      quickReviewMaxLines: policy.quickReviewMaxLines,
      riskClass: row ? toRiskClass(row.riskClass) : null,
    })),
  };
}

/** The queue order of already-built rows. */
export function orderRows(rows: readonly ReviewQueueRow[]) {
  const items: QueueItem[] = rows.map((row) => ({ ...row }));
  return orderReviewQueue(items);
}
