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
 *  - it measures what is actually pushed, not the index (which a hook can change
 *    between the check and the commit): the TREE at HEAD against the tree of
 *    `sessionBase`, a commit sha the worker read before the agent ran and holds in
 *    its own memory. Two trees, not a range: a range is anchored at a merge base, and
 *    the agent chooses HEAD's history, so rebuilding HEAD on an older ancestor would
 *    move the anchor and hide any path restored to its older content;
 *  - `sessionBase` is the HEAD the session started at — the default branch's tip for
 *    a fresh branch, the work branch's tip for a fix session or a retry — so each
 *    session answers only for its own changes, and an older branch base never matters;
 *  - the commit runs with hooks off, and every git call here runs with the same
 *    hardening `gitAuthed` uses (`gitWithAuthHeader`: no hooks, no system or global
 *    config) plus `GIT_NO_REPLACE_OBJECTS`, so `git replace` cannot hide a file;
 *  - no ref is read after the agent starts, so `update-ref` moves nothing the check
 *    looks at.
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
  /** HEAD when the session started, before the agent ran: what this session's change is checked against. */
  sessionBase: string;
  allowedPaths: readonly string[];
  /**
   * What `CodeResult.diff` and `filesChanged` (read by the template's `checkScope`) are
   * measured against, as a sha read before the agent ran, never a ref. `twoTree` diffs the
   * trees directly; otherwise it is the change since the merge base, for a session that
   * started on an existing branch with nothing better recorded. That one is informational:
   * the per-session check above is what confines the change.
   */
  report: { sha: string; twoTree: boolean };
}

const SHA = /^[0-9a-f]{40,64}$/;

async function readSha(workspace: Exec, rev: string): Promise<string> {
  try {
    const sha = (
      await workspace.exec(guardedGit(`rev-parse --verify ${shellQuote(`${rev}^{commit}`)}`))
    ).trim();
    return SHA.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

/**
 * Read, before the agent runs, the shas the guard measures from. Call it once the
 * workspace is on the tree the session starts from (after any sync to a pushed branch)
 * and before any agent turn. Returns undefined, running nothing, when the step sets no
 * `allowedPaths`. Fails closed (non-retryably) when a sha cannot be read: a guarded
 * step with no base would be an unguarded one.
 *
 * `reportBase` is the sha the whole change should be reported against when it is known
 * (the commit a fix session's branch was originally cut from, carried on the previous
 * result). Otherwise the default branch's tip is used.
 */
export async function startPathGuard(
  workspace: Exec,
  defaultBranch: string,
  allowedPaths: readonly string[] | undefined,
  reportBase?: string
): Promise<PathGuard | undefined> {
  if (!allowedPaths) {
    return undefined;
  }
  const [sessionBase, defaultSha] = [
    await readSha(workspace, 'HEAD'),
    await readSha(workspace, `origin/${defaultBranch}`),
  ];
  if (!sessionBase || !defaultSha) {
    throw ApplicationFailure.nonRetryable(
      'Could not read the commit the workspace started from, so the change cannot be confined to ' +
        `${allowedPaths.join(', ')}. Nothing was committed or pushed.`,
      'DIFF_BASE_UNREADABLE'
    );
  }
  const report =
    reportBase && SHA.test(reportBase)
      ? { sha: reportBase, twoTree: true }
      : { sha: defaultSha, twoTree: sessionBase === defaultSha };
  return { allowedPaths, report, sessionBase };
}

/**
 * Commit what is staged (a no-op when nothing is) and, for a guarded step, check the
 * committed tree before returning, so the caller's push never carries a path outside
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
  await assertCommittedTreeWithinAllowedPaths(workspace, guard);
}

/**
 * Fail non-retryably if the tree at HEAD differs from the session's starting tree at a
 * path outside `allowedPaths`. A direct tree comparison, so what HEAD's history looks
 * like is irrelevant. Renames count both ends.
 */
export async function assertCommittedTreeWithinAllowedPaths(
  workspace: Exec,
  guard: PathGuard
): Promise<void> {
  let out: string;
  try {
    out = await workspace.exec(
      guardedGit(`diff --name-only --no-renames --no-ext-diff -z ${guard.sessionBase} HEAD`)
    );
  } catch {
    throw ApplicationFailure.nonRetryable(
      'The change could not be compared with the commit the workspace started from, so it ' +
        'cannot be checked. Nothing was pushed.',
      'DIFF_CHECK_FAILED'
    );
  }
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
 * Guarded: measured from a recorded sha with the same hardening, no external diff driver
 * and no text conversion, so neither a rewritten ref nor a config key changes what is
 * reported or what the security scan sees.
 */
export async function diffForResult(
  workspace: Exec,
  defaultBranch: string,
  guard: PathGuard | undefined
): Promise<string> {
  if (!guard) {
    return workspace.exec(`git diff origin/${shellQuote(defaultBranch)}`);
  }
  const range = guard.report.twoTree ? `${guard.report.sha} HEAD` : `${guard.report.sha}...HEAD`;
  return workspace.exec(guardedGit(`diff --no-ext-diff --no-textconv ${range}`));
}
