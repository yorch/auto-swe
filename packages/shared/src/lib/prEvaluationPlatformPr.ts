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
      select: { workflow: { select: { temporalWorkflowId: true } } };
      where: { prNumber: number; repoId: string; workflowId: { not: null } };
    }): Promise<{ workflow: { temporalWorkflowId: string } | null } | null>;
  };
};

/** The newest linked pull-request row for `prNumber` in the repository, or null. */
export function findPlatformPullRequest(
  db: PlatformPullRequestDb,
  connectionId: string,
  prNumber: number
) {
  return db.pullRequest.findFirst({
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    select: { workflow: { select: { temporalWorkflowId: true } } },
    where: { prNumber, repoId: connectionId, workflowId: { not: null } },
  });
}
