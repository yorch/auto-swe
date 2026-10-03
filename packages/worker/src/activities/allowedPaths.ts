/**
 * The `allowedPaths` guard of the implementer steps: a step may be told which files
 * its change may touch, and a change that touches any other fails the activity
 * BEFORE its push. Prompt text alone cannot enforce that — an agent that reads
 * untrusted content can be talked into editing anything — and a push can start work
 * on the host (a new workflow file runs on `push`), so the check has to sit ahead
 * of it. Unset, nothing changes for any template: the helpers below run the exact
 * commands the steps always ran.
 *
 * The repository is writable by the agent, so the check cannot trust anything in it:
 *  - it measures what is actually pushed — the committed range from the commit the
 *    workspace started at (`baseSha`, read by the worker before the agent ran, and
 *    held in worker memory) to HEAD — not the index, which a hook can change between
 *    the check and the commit;
 *  - the commit runs with hooks off, and every git call here runs with the same
 *    hardening `gitAuthed` uses (`gitWithAuthHeader`: no hooks, no system or global
 *    config) plus `GIT_NO_REPLACE_OBJECTS`, so `git replace` cannot hide a file;
 *  - `refs/remotes/origin/<default>` is never read after the agent starts, so
 *    `update-ref` on it moves nothing the check looks at.
 * What remains is outside the agent's reach in this model: replacing the `git`
 * binary itself, which needs root in the container and is the limit the workspace
 * hardening already documents.
 */
import { ApplicationFailure } from '@temporalio/activity';
import { gitWithAuthHeader, shellQuote, type Workspace } from './workspace.js';

type Exec = Pick<Workspace, 'exec'>;

/** Commit identity, passed explicitly because the global config is ignored here. */
const IDENTITY = "-c user.name='auto-swe' -c user.email='auto-swe@localhost'";

/** A hardened, replace-proof git call. */
const guardedGit = (subcommand: string): string =>
  `GIT_NO_REPLACE_OBJECTS=1 ${gitWithAuthHeader(subcommand)}`;

/** What the guard measures against, and what it allows. Present only for a guarded step. */
export interface PathGuard {
  baseSha: string;
  allowedPaths: readonly string[];
}

/**
 * Read the commit the workspace started from, before the agent runs. Returns
 * undefined, running nothing, when the step sets no `allowedPaths`. Fails closed
 * (non-retryably) when it cannot be read: a guarded step with no base would be an
 * unguarded one.
 */
export async function startPathGuard(
  workspace: Exec,
  defaultBranch: string,
  allowedPaths: readonly string[] | undefined
): Promise<PathGuard | undefined> {
  if (!allowedPaths) {
    return undefined;
  }
  let baseSha = '';
  try {
    baseSha = (
      await workspace.exec(
        guardedGit(`rev-parse --verify ${shellQuote(`origin/${defaultBranch}^{commit}`)}`)
      )
    ).trim();
  } catch {
    // fall through to the failure below
  }
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) {
    throw ApplicationFailure.nonRetryable(
      'Could not read the commit the workspace started from, so the change cannot be confined to ' +
        `${allowedPaths.join(', ')}. Nothing was committed or pushed.`,
      'DIFF_BASE_UNREADABLE'
    );
  }
  return { allowedPaths, baseSha };
}

/**
 * Commit what is staged (a no-op when nothing is) and, for a guarded step, check the
 * committed range before returning, so the caller's push never carries a path outside
 * `allowedPaths`. Without a guard it runs the original command unchanged.
 */
export async function commitStaged(
  workspace: Exec,
  message: string,
  guard: PathGuard | undefined
): Promise<void> {
  if (!guard) {
    await workspace.exec(`git diff --cached --quiet || git commit -m ${shellQuote(message)}`);
    return;
  }
  // Hooks off (the hardening sets `core.hooksPath=/dev/null`; `--no-verify` as well), so a
  // `pre-commit` hook cannot add a file after the staged tree was looked at.
  await workspace.exec(
    `${guardedGit('diff --cached --quiet')} || ` +
      guardedGit(`${IDENTITY} -c commit.gpgsign=false commit --no-verify -m ${shellQuote(message)}`)
  );
  await assertCommittedRangeWithinAllowedPaths(workspace, guard);
}

/**
 * Fail non-retryably if the commits between the starting commit and HEAD touch a path
 * outside `allowedPaths`. The range is `base...HEAD`, the changes since the merge base,
 * so a fix session on a branch cut when the default branch was older still measures only
 * its own history. A HEAD that shares no history with the base fails: a rewritten branch
 * is not a change to measure. Renames count both ends.
 */
export async function assertCommittedRangeWithinAllowedPaths(
  workspace: Exec,
  guard: PathGuard
): Promise<void> {
  try {
    await workspace.exec(guardedGit(`merge-base ${guard.baseSha} HEAD`));
  } catch {
    throw ApplicationFailure.nonRetryable(
      'The branch no longer shares history with the commit the workspace started from, so its ' +
        'change cannot be checked. Nothing was pushed.',
      'DIFF_BASE_UNRELATED'
    );
  }
  const out = await workspace.exec(
    guardedGit(`diff --name-only --no-renames --no-ext-diff -z ${guard.baseSha}...HEAD`)
  );
  const outside = out.split('\0').filter((p) => p !== '' && !guard.allowedPaths.includes(p));
  if (outside.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The change touches files this step may not change (${outside.slice(0, 10).join(', ')}` +
        `${outside.length > 10 ? ', …' : ''}); allowed: ${guard.allowedPaths.join(', ')}. ` +
        'Nothing was pushed.',
      'DIFF_OUTSIDE_ALLOWED_PATHS'
    );
  }
}

/**
 * The diff the step reports (`CodeResult.diff`, and from it `filesChanged`, which the
 * template's `checkScope` reads). Unguarded: the original `git diff origin/<default>`.
 * Guarded: measured from the starting commit with the same hardening, no external diff
 * driver and no text conversion, so neither a rewritten `origin/<default>` nor a config
 * key can change what is reported or what the security scan sees.
 */
export async function diffForResult(
  workspace: Exec,
  defaultBranch: string,
  guard: PathGuard | undefined
): Promise<string> {
  return guard
    ? workspace.exec(guardedGit(`diff --no-ext-diff --no-textconv ${guard.baseSha}...HEAD`))
    : workspace.exec(`git diff origin/${shellQuote(defaultBranch)}`);
}
