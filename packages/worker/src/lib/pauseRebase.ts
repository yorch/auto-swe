import { ApplicationFailure } from '@temporalio/activity';
import { fetchBranchesSubcommand, type Workspace } from '../activities/workspace.js';
import { shellQuote } from './shellQuote.js';

/**
 * A resumed run is cut from the commit its saved tree was taken against, so the
 * branch it pushes to can have moved while a person decided. Pushing the result as
 * it stands would be rejected as non-fast-forward after all the work is done.
 * Before the push, bring the remote branch in and replay the run's commits on top
 * of it. Nothing is ever force-pushed: the push that follows stays a fast-forward.
 *
 * Returns the new `HEAD` when commits were replayed and undefined when there was
 * nothing to do (the branch is not on the remote, or has not moved). A conflict
 * aborts the rebase and fails non-retryably with `NEEDS_INPUT_PUSH_CONFLICT`, a fixed
 * message: the person who pushed meanwhile has to be reconciled with by a human.
 */
export async function rebaseOntoMovedBranch(
  workspace: Pick<Workspace, 'exec' | 'gitAuthed'>,
  branch: string
): Promise<string | undefined> {
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
  } catch {
    // Not on the remote yet: the first push creates it.
    return undefined;
  }
  const remote = shellQuote(`origin/${branch}`);
  const upToDate = (
    await workspace.exec(`git merge-base --is-ancestor ${remote} HEAD && echo yes || echo no`)
  ).trim();
  if (upToDate === 'yes') {
    return undefined;
  }
  try {
    await workspace.exec(`git -c core.hooksPath=/dev/null rebase ${remote}`);
  } catch {
    await workspace.exec('git rebase --abort').catch(() => undefined);
    throw ApplicationFailure.nonRetryable(
      `The branch ${branch} changed while the run waited for an answer, and the run's changes no longer apply on top of it. Nothing was pushed.`,
      'NEEDS_INPUT_PUSH_CONFLICT'
    );
  }
  return (await workspace.exec('git rev-parse HEAD')).trim();
}
