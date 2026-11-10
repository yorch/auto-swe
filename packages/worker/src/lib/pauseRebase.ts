import { ApplicationFailure } from '@temporalio/activity';
import {
  assertCommittedTreeWithinAllowedPaths,
  guardedGit,
  type PathGuard,
} from '../activities/allowedPaths.js';
import { fetchBranchesSubcommand, type Workspace } from '../activities/workspace.js';
import { DEFAULT_GIT_IDENTITY, type GitIdentity, gitIdentityFlags } from './gitIdentity.js';
import { shellQuote } from './shellQuote.js';

const SHA = /^[0-9a-f]{40,64}$/;
/** What `rev-parse --verify` printed: git's own output, so only its shape is checked. */
const REV = /^[0-9a-f]{6,64}$/;

const rebaseFailed = (message: string, retryable = false) =>
  retryable
    ? ApplicationFailure.retryable(message, 'NEEDS_INPUT_REBASE_FAILED')
    : ApplicationFailure.nonRetryable(message, 'NEEDS_INPUT_REBASE_FAILED');

export interface RebaseOptions {
  /**
   * The commit the resumed run was cut from. Only the commits made after it are replayed
   * (`git rebase --onto origin/<branch> <replayBase>`): a branch that was force-moved
   * while the run waited must not get its old commits back. Undefined: every commit not
   * on the remote branch is replayed.
   */
  replayBase?: string;
  /** The step's path guard. When set, the rebased result is checked again before it is returned. */
  guard?: PathGuard;
}

/**
 * A resumed run is cut from the commit its saved tree was taken against, so the
 * branch it pushes to can have moved while a person decided. Pushing the result as
 * it stands would be rejected as non-fast-forward after all the work is done.
 * Before the push, bring the remote branch in and replay the run's commits on top
 * of it. Nothing is ever force-pushed: the push that follows stays a fast-forward.
 *
 * The rebase runs in the agent's workspace, so it is hardened like every guarded git
 * call (no system or global config, no hooks, no replace refs) and additionally with
 * no attributes file, no fsmonitor and no commit signing. The replayed result is
 * then checked against the step's path guard, measured from the remote branch, so a
 * teammate's files do not count but everything the agent replayed does. A failed
 * re-check throws the guard's own non-retryable error.
 *
 * Returns the new `HEAD` when commits were replayed and undefined when there was
 * nothing to do (the branch is not on the remote, or has not moved). A conflict
 * aborts the rebase and fails non-retryably with `NEEDS_INPUT_PUSH_CONFLICT`, a fixed
 * message: the person who pushed meanwhile has to be reconciled with by a human. Every
 * other failure is `NEEDS_INPUT_REBASE_FAILED`: retryable when the remote could not be
 * reached, non-retryable otherwise.
 */
export async function rebaseOntoMovedBranch(
  workspace: Pick<Workspace, 'exec' | 'gitAuthed'> & { gitIdentity?: GitIdentity },
  branch: string,
  options: RebaseOptions = {}
): Promise<string | undefined> {
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
  } catch {
    // Absent on the remote is the one case with nothing to do: the first push creates it.
    // A network or credential failure must not be read as "absent".
    let listing: string;
    try {
      listing = await workspace.gitAuthed(`ls-remote --heads origin ${shellQuote(branch)}`);
    } catch {
      throw rebaseFailed(
        `Could not reach the remote to check whether ${branch} changed while the run waited. Nothing was pushed.`,
        true
      );
    }
    if (listing.trim() === '') {
      return undefined;
    }
    throw rebaseFailed(
      `Could not fetch ${branch} to check whether it changed while the run waited. Nothing was pushed.`,
      true
    );
  }
  // Fully qualified, and only the resulting sha is used afterwards. A short `origin/<branch>`
  // resolves `$GIT_DIR/<name>`, `refs/<name>`, `refs/tags/<name>` and `refs/heads/<name>`
  // before `refs/remotes/<name>`, any of which the agent can plant to point the base (and so
  // the guard's diff) at a commit of its choosing. The forced fetch above is what sets this ref.
  const remoteSha = (
    await workspace.exec(
      guardedGit(`rev-parse --verify ${shellQuote(`refs/remotes/origin/${branch}^{commit}`)}`)
    )
  ).trim();
  if (!SHA.test(remoteSha)) {
    throw rebaseFailed(`Could not read the remote ${branch} to rebase onto. Nothing was pushed.`);
  }
  const ancestor = (
    await workspace.exec(
      `${guardedGit(`merge-base --is-ancestor ${remoteSha} HEAD`)}; echo "rc=$?"`
    )
  ).trim();
  if (ancestor.endsWith('rc=0')) {
    return undefined;
  }
  if (!ancestor.endsWith('rc=1')) {
    throw rebaseFailed(`Could not compare ${branch} with the run's commits. Nothing was pushed.`);
  }
  const { replayBase } = options;
  if (replayBase !== undefined && !SHA.test(replayBase)) {
    throw rebaseFailed('The commit the run resumed from is not readable. Nothing was pushed.');
  }
  const identity = workspace.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  const hardened = [
    gitIdentityFlags(identity),
    '-c commit.gpgsign=false',
    '-c core.attributesFile=/dev/null',
    '-c core.fsmonitor=false',
    '-c rebase.autoStash=false',
  ].join(' ');
  const upstream = replayBase ? `--onto ${remoteSha} ${replayBase}` : remoteSha;
  try {
    await workspace.exec(
      `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true ${guardedGit(`${hardened} rebase --no-verify ${upstream}`)}`
    );
  } catch {
    const unmerged = await workspace
      .exec(guardedGit('ls-files -u'))
      .then((out) => out.trim() !== '')
      .catch(() => false);
    await workspace.exec(guardedGit('rebase --abort')).catch(() => undefined);
    if (unmerged) {
      throw ApplicationFailure.nonRetryable(
        `The branch ${branch} changed while the run waited for an answer, and the run's changes no longer apply on top of it. Nothing was pushed.`,
        'NEEDS_INPUT_PUSH_CONFLICT'
      );
    }
    throw rebaseFailed(
      `The run's commits could not be replayed on top of ${branch}, which changed while the run waited. Nothing was pushed.`
    );
  }
  const head = (await workspace.exec(guardedGit('rev-parse --verify HEAD^{commit}'))).trim();
  if (!REV.test(head)) {
    throw rebaseFailed(
      'Could not read the rebased commit, so it cannot be checked. Nothing was pushed.'
    );
  }
  if (options.guard) {
    // Measured from the remote branch: what the agent replayed, not what teammates pushed.
    await assertCommittedTreeWithinAllowedPaths(
      workspace,
      { ...options.guard, sessionBase: remoteSha },
      head
    );
  }
  return head;
}
