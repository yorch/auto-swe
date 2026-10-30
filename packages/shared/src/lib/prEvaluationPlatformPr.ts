/**
 * Whether a pull request is one the platform opened: its `PullRequest` row links the run that
 * opened it, exactly as the PR-feedback automation decides it. The host's branch name is not
 * evidence, anyone can name a branch `auto/...`. One definition, so the gateway's webhook
 * pre-filter can never be stricter or looser than the worker's evaluation.
 */

/** The slice of the Prisma client the lookup reads, so a test can pass a stand-in. */
export type PlatformPullRequestDb = {
  pullRequest: {
    findFirst(args: {
      orderBy: Array<{ openedAt: 'desc' } | { id: 'desc' }>;
      select: {
        runId: true;
        workflow: { select: { temporalWorkflowId: true; workRequestId: true } };
      };
      where: { prNumber: number; repoId: string; workflowId: { not: null } };
    }): Promise<{
      runId: string | null;
      workflow: { temporalWorkflowId: string; workRequestId: string | null } | null;
    } | null>;
  };
};

/**
 * The newest linked pull-request row for `prNumber` in the repository, or null. `runId` is a
 * mutable pointer (a re-run that adopts the pull request overwrites it), so it names one run of
 * the work, not the whole of it; the work request is what finds the rest.
 */
export function findPlatformPullRequest(
  db: PlatformPullRequestDb,
  connectionId: string,
  prNumber: number
) {
  return db.pullRequest.findFirst({
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    select: {
      runId: true,
      workflow: { select: { temporalWorkflowId: true, workRequestId: true } },
    },
    where: { prNumber, repoId: connectionId, workflowId: { not: null } },
  });
}
