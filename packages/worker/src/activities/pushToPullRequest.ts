/**
 * The shared fast-forward delivery of a run's fix commit onto a pull request's branch —
 * the checks `pushCiFixToPullRequest` and `pushPrFeedbackToPullRequest` both take, moved
 * here verbatim so the two cannot drift. Source-specific authorization (which fire row,
 * which template, which setting) stays with each caller.
 */

import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { matchesPatterns } from '@auto-swe/shared/lib/ciTrigger';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

/** Paths a pushed fix may never touch: what a workflow run executes with the repo's secrets. */
export const WORKFLOW_PATH_RE = /^\.github\/(workflows|actions)(\/|$)/i;

export type PushToPullRequestResult =
  | { pushed: true; branch: string; commitSha: string }
  | { pushed: false; reason: string };

/**
 * Fast-forward `branch` — the pull request's head branch — to `codeResult.headSha`, the commit
 * on this run's own work branch `<branchPrefix>/<ticket>`, when every host-side check holds:
 * the pull request is open from that branch of this repository, the branch is not the default,
 * protected or listed in `github.ciFixNeverPushBranches`, the commit is a fast-forward of its
 * tip and touches no workflow file. The commit is recorded on `fire` BEFORE the push (its own
 * CI failure must be recognised as the platform's own) and cleared again when it is refused.
 */
export async function fastForwardPullRequestBranch(args: {
  prisma: PrismaClient;
  fire: {
    automationId: string | null;
    connectionId: string | null;
    dedupeKey: string;
    facts: unknown;
    id: string;
    ownerKey: string;
    producedKey: string | null;
    scopeKey: string;
    source: string;
  };
  repo: {
    githubApiUrl: string | null;
    githubUrl: string | null;
    id: string;
    installation: { installationId: string; host: string } | null;
    organizationName: string | null;
    repoName: string | null;
    team: { orgId: string | null } | null;
    teamId: string;
  };
  /** The pull request the push lands on. */
  prNumber: number;
  /** The branch to fast-forward: the pull request's head. */
  branch: string;
  codeResult: CodeResult;
  workBranch: string;
  /** Keep the work branch after the push for a follow-up. */
  keepWorkBranch: boolean;
  /** Called with the refusal reason, for the caller's trace. */
  onRefused?: (reason: string) => void;
  /** Called after the push lands (or is replayed), for the caller's trace. */
  onPushed?: (args: { branch: string; commitSha: string; prNumber: number }) => void;
}): Promise<PushToPullRequestResult> {
  const { prisma, fire, repo, branch, codeResult, workBranch } = args;
  const refuse = (reason: string): PushToPullRequestResult => {
    args.onRefused?.(reason);
    return { pushed: false, reason };
  };
  const ctx = {
    ...(repo.team?.orgId ? { orgId: repo.team.orgId } : {}),
    teamId: repo.teamId,
  };
  // Compared without case: `Release/2.0` is a release branch too.
  const neverPush = await resolveSetting('github.ciFixNeverPushBranches', ctx);
  if (
    matchesPatterns(
      neverPush.map((p) => p.toLowerCase()),
      branch.toLowerCase()
    )
  ) {
    return refuse(`'${branch}' is listed as a branch fixes are never pushed to`);
  }

  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const pr = await scm.pullRequestInfo(repoRef, args.prNumber);
  if (
    pr?.state !== 'open' ||
    pr.headRef !== branch ||
    pr.headRepositoryFullName?.toLowerCase() !==
      `${repo.organizationName}/${repo.repoName}`.toLowerCase()
  ) {
    return refuse('the pull request is no longer open from this branch');
  }
  if ((await scm.defaultBranch(repoRef)) === branch) {
    return refuse("the pull request's branch is the repository's default branch");
  }
  const info = await scm.branchInfo(repoRef, branch);
  if (!info) {
    return refuse('the branch no longer exists');
  }
  if (info.protected) {
    return refuse('the branch is protected');
  }
  const fixSha = codeResult.headSha;
  if (!fixSha || !/^[0-9a-f]{40}$/i.test(fixSha)) {
    return refuse('the fix has no commit to push');
  }
  if (codeResult.branch !== workBranch || workBranch === branch) {
    return refuse("the fix is not on this run's work branch");
  }
  const done = () => {
    args.onPushed?.({ branch, commitSha: fixSha, prNumber: pr.number });
    return { branch, commitSha: fixSha, pushed: true } as const;
  };
  // A retry after a push whose reply was lost: the branch is already at the recorded commit.
  if (fire.producedKey === fixSha && info.sha === fixSha) {
    if (!args.keepWorkBranch) {
      await scm.deleteBranch(repoRef, workBranch);
    }
    return done();
  }
  if ((await scm.branchHeadSha(repoRef, workBranch)) !== fixSha) {
    return refuse("the fix is not on this run's work branch");
  }
  const range = await scm.compareCommits(repoRef, info.sha, fixSha);
  if (range.status !== 'ahead' || range.behindBy !== 0 || range.aheadBy < 1) {
    return refuse('the branch has moved since the fix was made');
  }
  if (range.paths === null) {
    return refuse('the fix is too large to check');
  }
  if (range.paths.some((p) => WORKFLOW_PATH_RE.test(p))) {
    return refuse('the fix touches a workflow file');
  }

  // A follow-up replaces the run's produced commit, but the earlier one is still the
  // platform's own: a slow workflow can fail on it after the run ended. It keeps a row of
  // its own, which only the own-output guard reads (and retention keeps).
  if (fire.producedKey && fire.producedKey !== fixSha) {
    await prisma.automationFire
      .create({
        data: {
          automationId: fire.automationId,
          connectionId: fire.connectionId,
          dedupeKey: `${fire.dedupeKey}~produced~${fire.producedKey}`,
          facts: (fire.facts ?? {}) as never,
          outcome: 'SUPPRESSED_OWN_OUTPUT',
          ownerKey: fire.ownerKey,
          producedKey: fire.producedKey,
          reason: 'an earlier fix this run pushed, followed up by another',
          scopeKey: fire.scopeKey,
          source: fire.source,
          subjectKey: fire.producedKey,
        },
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code !== 'P2002') {
          throw err;
        }
      });
  }
  // Recorded first: if the push lands and nothing after it does, the commit's failure is
  // still recognised as the platform's own.
  await prisma.automationFire.update({
    data: { producedKey: fixSha },
    where: { id: fire.id },
  });
  throwIfActivityCancelled();
  if (!(await scm.fastForwardBranch(repoRef, branch, fixSha))) {
    // Not pushed after all: the commit becomes the draft's head, and an author who later
    // takes it onto their branch must still have its failures triaged.
    await prisma.automationFire.update({
      data: { producedKey: null },
      where: { id: fire.id },
    });
    return refuse('GitHub refused the push (the branch moved, or a rule protects it)');
  }
  // The work branch only carried the commit there; it is now on the pull request's branch.
  if (!args.keepWorkBranch) {
    await scm.deleteBranch(repoRef, workBranch);
  }
  return done();
}

/**
 * Remove this run's work branch once a pushed fix is done with: it only carried the fix
 * commits, which are now on the pull request's branch. Kept when its head is anything else —
 * a follow-up that could not be pushed is its only copy. Best-effort; a branch that is gone
 * is fine.
 */
export async function deleteWorkedBranch(args: {
  prisma: PrismaClient;
  repo: Parameters<typeof toRepoRef>[0];
  workBranch: string;
  /** The commit last pushed onto the pull request's branch. */
  pushedCommitSha?: string | null;
}): Promise<{ deleted: boolean }> {
  const repoRef = toRepoRef(args.repo);
  const scm = getScmProvider(repoRef);
  const head = await scm.branchHeadSha(repoRef, args.workBranch);
  if (head === null) {
    return { deleted: false };
  }
  if (!args.pushedCommitSha || head !== args.pushedCommitSha) {
    return { deleted: false };
  }
  return { deleted: await scm.deleteBranch(repoRef, args.workBranch) };
}
