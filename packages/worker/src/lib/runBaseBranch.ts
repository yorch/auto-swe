import { baseBranchFromPayload, isSafeGitBranchName } from '@auto-swe/shared/lib/gitRef';
import type { RunRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';

/**
 * The base branch a run's launch asked for: `payload.baseBranch`, or undefined
 * when it named none.
 *
 * The payload is the one place a base is recorded, because it is the one part
 * of a launch every path keeps: a retry, a re-run and an agent-run re-run all
 * copy it, so a fix for `release/1.4` is still a fix for it on its second
 * attempt. A value that is present but not a branch name is refused rather than
 * dropped — dropping it would quietly run against the default branch.
 */
export function requestedBaseBranch(request: Pick<RunRequest, 'payload'>): string | undefined {
  const parsed = baseBranchFromPayload(request.payload);
  if (!parsed.ok) {
    throw ApplicationFailure.nonRetryable(
      `The run's base branch is not a valid branch name: ${parsed.message}`,
      'BASE_BRANCH_REFUSED'
    );
  }
  return parsed.baseBranch;
}

/**
 * The branch a run's change is cut from, diffed against and opened into: the
 * branch the launch asked for, else the repository's default branch.
 *
 * Every activity that clones for a run asks this, and they must agree: the
 * clone is single-branch, so `origin/<base>` exists only for the branch that
 * was cloned, and a diff against any other would fail or report the wrong
 * change.
 *
 * Only the name is checked here (non-retryably: a retry cannot make a bad name
 * good). Whether it is a platform work branch is decided once, at launch, by
 * the gateway: re-deciding it per activity would fail a run part-way through
 * if an admin changed the branch prefix while it ran.
 */
export async function resolveRunBaseBranch(
  requested: string | undefined | null,
  repo: { defaultBranch: string }
): Promise<string> {
  if (requested === undefined || requested === null || requested === '') {
    return repo.defaultBranch;
  }
  if (!isSafeGitBranchName(requested)) {
    throw ApplicationFailure.nonRetryable(
      `The run's base branch '${requested.slice(0, 80)}' is not a valid branch name.`,
      'BASE_BRANCH_REFUSED'
    );
  }
  return requested;
}

/** {@link resolveRunBaseBranch} for the base a request's payload names. */
export function resolveRequestBaseBranch(
  request: Pick<RunRequest, 'payload'>,
  repo: { defaultBranch: string }
): Promise<string> {
  return resolveRunBaseBranch(requestedBaseBranch(request), repo);
}
