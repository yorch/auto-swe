/**
 * The `allowedPaths` guard of the implementer steps: a step may be told which files
 * its change may touch, and a change that touches any other fails the activity
 * BEFORE its commit and push. Prompt text alone cannot enforce that — an agent that
 * reads untrusted content can be talked into editing anything — and a push can start
 * work on the host (a new workflow file runs on `push`), so the check has to sit
 * ahead of it. Unset, nothing changes for any template.
 */
import { ApplicationFailure } from '@temporalio/activity';
import { shellQuote, type Workspace } from './workspace.js';

/**
 * Stage everything, then fail non-retryably if the change as a whole (the branch's
 * commits so far plus what is staged now, against `origin/<defaultBranch>`) names a
 * path outside `allowedPaths`. Renames count both ends. Call it right after
 * `git add -A` and before `git commit`.
 */
export async function assertDiffWithinAllowedPaths(
  workspace: Pick<Workspace, 'exec'>,
  defaultBranch: string,
  allowedPaths: readonly string[] | undefined
): Promise<void> {
  if (!allowedPaths) {
    return;
  }
  const out = await workspace.exec(
    `git diff --cached --name-only --no-renames -z origin/${shellQuote(defaultBranch)}`
  );
  const outside = out.split('\0').filter((p) => p !== '' && !allowedPaths.includes(p));
  if (outside.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The change touches files this step may not change (${outside.slice(0, 10).join(', ')}` +
        `${outside.length > 10 ? ', …' : ''}); allowed: ${allowedPaths.join(', ')}. Nothing was committed or pushed.`,
      'DIFF_OUTSIDE_ALLOWED_PATHS'
    );
  }
}
