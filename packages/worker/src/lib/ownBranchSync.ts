import { ApplicationFailure } from '@temporalio/activity';
import { fetchBranchesSubcommand, shellQuote } from '../activities/workspace.js';

/** The commit trailer that names the run a commit was made for. */
const RUN_TRAILER = 'Auto-SWE-Run';

/** The trailer line an implementation commit carries. */
export function runTrailer(workRequestId: string): string {
  return `${RUN_TRAILER}: ${workRequestId}`;
}

/** What a retry needs of its workspace: an authenticated git call and a plain command. */
export interface BranchWorkspace {
  gitAuthed(subcommand: string): Promise<unknown>;
  exec(command: string): Promise<string>;
}

/**
 * On a retry, move the workspace onto what an earlier attempt of THIS run pushed to `branch`.
 *
 * A retry may reset to the remote branch only if the commit at its tip was made by this run
 * (its message carries the run's trailer). A branch that exists with a tip from anywhere else (an
 * earlier run's pull request on the same ticket, a person's commits) is never adopted: building
 * on it and pushing would add this run's work to someone else's branch and pull request. That is
 * refused, non-retryably, with nothing pushed.
 *
 * Returns whether the workspace was moved. A branch that is not on the remote means no earlier
 * attempt got as far as its push, and the workspace stays at the clone's head.
 */
export async function syncToOwnPush(
  workspace: BranchWorkspace,
  branch: string,
  workRequestId: string
): Promise<boolean> {
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
  } catch {
    return false;
  }
  let tipMessage: string;
  try {
    tipMessage = await workspace.exec(`git log -1 --format=%B origin/${shellQuote(branch)}`);
  } catch {
    return false;
  }
  const trailer = runTrailer(workRequestId);
  if (!tipMessage.split('\n').some((line) => line.trim() === trailer)) {
    throw ApplicationFailure.nonRetryable(
      `The branch ${branch} already exists with commits this run did not make. It is not built on or ` +
        'pushed to, so no other run’s work is changed. Nothing was pushed.',
      'BRANCH_NOT_OWNED'
    );
  }
  await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
  return true;
}
