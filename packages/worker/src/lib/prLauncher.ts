import type { PrismaClient } from '@auto-swe/shared';
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { parseAccountId } from '@auto-swe/shared/lib/githubIdentityCheck';
import type { ExcludedIdentities } from '@auto-swe/shared/lib/prEvaluation';

/** At most this many runs of one piece of work are followed; more is treated as unresolved. */
export const MAX_LAUNCHER_RUNS = 50;

/**
 * The people whose approval of a pull request never counts, and whether every one of them is
 * pinned down well enough to arm auto-merge.
 *
 * `members` is how many distinct people (or unattributable runs) the set was built from; it is
 * the only thing about the set that may be logged or stored. `ids` and `logins` are used for the
 * comparison alone.
 */
export type LauncherSet = ExcludedIdentities & { members: number; resolved: boolean };

export type LauncherSetArgs = {
  /** The repository's host family (`github.com`, `ghe.example.com`). */
  repoHost: string;
  repoId: string;
  /** `PullRequest.runId`: a mutable pointer a re-run overwrites, so only one of the sources. */
  runId: string | null;
  /** The Temporal workflow id of the run that opened the pull request. */
  temporalWorkflowId: string | null;
  workRequestId: string | null;
};

/**
 * The launchers of EVERY run of the work that produced a pull request, plus that work's
 * requester.
 *
 * `PullRequest.runId` names only the run that wrote it last: a retry, re-run or scheduled fire
 * that adopts the open pull request takes the pointer over, and a re-run gets a fresh workflow
 * id. So the set is every `WorkflowRun` that is the stamped run, the opening workflow's run, or
 * a run of the same work request on this repository, and the work request's `requestedById`
 * (the mapped GitHub sender for webhook-created work).
 *
 * Each person is excluded by every identity that is known: their linked login, always, and their
 * numeric account id when it belongs to the repository's host. A person counts as RESOLVED only
 * with a numeric id on that host, because a login can be renamed and an id from another host
 * names a different person. `resolved` is true only when the set is non-empty, under the cap, and
 * every member (a run with no launcher, a service principal, or a missing user is a member that
 * cannot) is resolved; otherwise approvals still count against what is known, but auto-merge is
 * never armed.
 */
export async function resolveLauncherSet(
  db: PrismaClient,
  args: LauncherSetArgs
): Promise<LauncherSet> {
  const sources: Record<string, unknown>[] = [];
  if (args.runId) {
    sources.push({ id: args.runId });
  }
  if (args.temporalWorkflowId) {
    sources.push({ workflowId: args.temporalWorkflowId });
  }
  if (args.workRequestId) {
    sources.push({
      OR: [{ connectionId: null }, { connectionId: args.repoId }],
      workRequestId: args.workRequestId,
    });
  }
  const runs =
    sources.length === 0
      ? []
      : await db.workflowRun.findMany({
          // One more than the cap tells an overflow apart from exactly the cap.
          select: { launchedById: true },
          take: MAX_LAUNCHER_RUNS + 1,
          where: { OR: sources },
        });
  const overCap = runs.length > MAX_LAUNCHER_RUNS;

  const userIds = new Set<string>();
  let unattributable = 0;
  for (const run of runs.slice(0, MAX_LAUNCHER_RUNS)) {
    if (run.launchedById) {
      userIds.add(run.launchedById);
    } else {
      unattributable += 1;
    }
  }
  if (args.workRequestId) {
    const request = await db.runInput.findUnique({
      select: { requestedById: true, requestedByServiceId: true },
      where: { id: args.workRequestId },
    });
    if (request?.requestedById) {
      userIds.add(request.requestedById);
    } else if (request) {
      // A service principal, or nobody: a requester who cannot be matched to a person.
      unattributable += 1;
    }
  }

  const ids = new Set<string>();
  const logins = new Set<string>();
  let unresolved = unattributable;
  if (userIds.size > 0) {
    const users = await db.user.findMany({
      select: { githubLogin: true, githubLoginAccountId: true, id: true },
      where: { id: { in: [...userIds] } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const userId of userIds) {
      const user = byId.get(userId);
      if (!user?.githubLogin) {
        unresolved += 1;
        continue;
      }
      logins.add(user.githubLogin.toLowerCase());
      const parsed = user.githubLoginAccountId ? parseAccountId(user.githubLoginAccountId) : null;
      if (
        parsed &&
        /^\d+$/.test(parsed.id) &&
        hostFamily(`https://${parsed.host}`) === args.repoHost
      ) {
        ids.add(parsed.id);
      } else {
        unresolved += 1;
      }
    }
  }

  const members = userIds.size + unattributable;
  return { ids, logins, members, resolved: members > 0 && unresolved === 0 && !overCap };
}
