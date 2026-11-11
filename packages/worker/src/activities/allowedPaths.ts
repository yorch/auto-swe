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
 *    between the check and the commit) and not `HEAD` (the agent can leave `HEAD` on
 *    a scratch branch while the branch that gets pushed carries other commits): after
 *    the commit it pins the committed sha once, checks that commit's TREE against the
 *    tree of
 *    `sessionBase`, a commit sha the worker read before the agent ran and holds in
 *    its own memory. Two trees, not a range: a range is anchored at a merge base, and
 *    the agent chooses HEAD's history, so rebuilding HEAD on an older ancestor would
 *    move the anchor and hide any path restored to its older content;
 *  - `sessionBase` is the HEAD the session started at — the default branch's tip for
 *    a fresh branch, the work branch's tip for a fix session or a retry — so each
 *    session answers only for its own changes, and an older branch base never matters;
 *  - that same sha is what gets pushed (`<sha>:refs/heads/<branch>`) and what the
 *    reported diff, `filesChanged` and `headSha` are read from, so the checked commit,
 *    the pushed commit and the reported commit are one;
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
import {
  GITLINK_MODE,
  isWorkflowPath,
  parseRawDiffZ,
  type RawChange,
  SYMLINK_MODE,
} from '../lib/agentRunPolicy.js';
import {
  DEFAULT_GIT_IDENTITY,
  type GitIdentity,
  gitIdentityFlags,
  withCoAuthorTrailer,
} from '../lib/gitIdentity.js';
import { gitWithAuthHeader, shellQuote, type Workspace } from './workspace.js';

/** `gitIdentity` is optional so a fake workspace need not carry one. */
type Exec = Pick<Workspace, 'exec'> & { gitIdentity?: GitIdentity };

/**
 * Pins the repository to `<cwd>/.git` with `<cwd>` as its work tree, by environment. The agent
 * can write `core.worktree` into `.git/config` (the push scrub only rewrites it afterwards), and
 * a work tree that is an ancestor of the checkout turns a `.`-relative pathspec into a path that
 * matches nothing, so a porcelain `git diff` prints an empty diff for a real change. The
 * environment variable beats the config key, and a plumbing call with no relative pathspec does
 * not look at the work tree at all.
 */
const PIN_REPOSITORY = 'GIT_DIR="$(pwd -P)/.git" GIT_WORK_TREE="$(pwd -P)"';

/** A hardened, replace-proof git call, pinned to this checkout (see {@link PIN_REPOSITORY}). */
const guardedGit = (subcommand: string): string =>
  `GIT_NO_REPLACE_OBJECTS=1 ${PIN_REPOSITORY} ${gitWithAuthHeader(subcommand)}`;

/**
 * Whether `changedPath` (repo-relative, as git lists it) is covered by an `allowedPaths` entry.
 * An entry is one of three literal forms, and none is a pattern language:
 *  - `docs/a.md`: exactly that file;
 *  - `docs/`: anything under that directory (a trailing slash);
 *  - `**\/*.md`: any file whose path ends in that extension (a leading `**\/*.`).
 * Anything else, including an entry with other wildcard characters, matches only itself, so a
 * mistyped pattern narrows the guard instead of widening it.
 */
export function pathAllowed(allowed: readonly string[], changedPath: string): boolean {
  return allowed.some((entry) => {
    if (entry === changedPath) {
      return true;
    }
    if (entry.endsWith('/') && entry.length > 1 && !entry.includes('*')) {
      return changedPath.startsWith(entry);
    }
    const extension = /^\*\*\/\*(\.[A-Za-z0-9]+)$/.exec(entry)?.[1];
    return extension !== undefined && changedPath.endsWith(extension);
  });
}

/** What a step's guard refuses beyond `allowedPaths`. */
export interface PathGuardOptions {
  /** See {@link PathGuard.refuseWorkflowChanges}. */
  refuseWorkflowChanges?: boolean;
}

/** What the guard measures against, and what it allows. Present only for a guarded step. */
export interface PathGuard {
  /** HEAD when the session started, before the agent ran: what this session's change is checked against. */
  sessionBase: string;
  /** The only paths the change may touch. Undefined: any path, subject to the refusal below. */
  allowedPaths: readonly string[] | undefined;
  /**
   * Refuse a change under `.github/workflows/` or `.github/actions/`. A pushed workflow runs
   * with the repository's secrets, so a step whose instructions derive from untrusted text
   * (CI logs) must not be able to write one, whatever it was told.
   */
  refuseWorkflowChanges: boolean;
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
  reportBase?: string,
  options: PathGuardOptions = {}
): Promise<PathGuard | undefined> {
  const refuseWorkflowChanges = options.refuseWorkflowChanges === true;
  if (!allowedPaths && !refuseWorkflowChanges) {
    return undefined;
  }
  const [sessionBase, defaultSha] = [
    await readSha(workspace, 'HEAD'),
    await readSha(workspace, `origin/${defaultBranch}`),
  ];
  if (!sessionBase || !defaultSha) {
    throw ApplicationFailure.nonRetryable(
      'Could not read the commit the workspace started from, so the change cannot be confined to ' +
        `${allowedPaths ? allowedPaths.join(', ') : 'the paths it may touch'}. Nothing was committed or pushed.`,
      'DIFF_BASE_UNREADABLE'
    );
  }
  const report =
    reportBase && SHA.test(reportBase)
      ? { sha: reportBase, twoTree: true }
      : { sha: defaultSha, twoTree: sessionBase === defaultSha };
  return { allowedPaths, refuseWorkflowChanges, report, sessionBase };
}

/**
 * Commit what is staged (a no-op when nothing is). Unguarded: the original command, and
 * undefined is returned. Guarded, or `hardened` (a session whose committed result is analysed
 * afterwards, such as the test-integrity gate): hooks off, then pin the committed sha once and
 * return it; a guard also checks that commit's tree before returning. The caller pushes exactly
 * that commit.
 */
export async function commitStaged(
  workspace: Exec,
  message: string,
  guard: PathGuard | undefined,
  options: { hardened?: boolean } = {}
): Promise<string | undefined> {
  const identity = workspace.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  const text = shellQuote(withCoAuthorTrailer(message, identity));
  if (!guard && !options.hardened) {
    await workspace.exec(`git diff --cached --quiet || git commit -m ${text}`);
    return undefined;
  }
  // Hooks off (the hardening sets `core.hooksPath=/dev/null`; `--no-verify` as well), so a
  // `pre-commit` hook cannot add or remove a file after the staged tree was looked at.
  await workspace.exec(
    `${guardedGit('diff --cached --quiet')} || ` +
      guardedGit(
        // The global config is ignored here, so the identity is passed explicitly.
        `${gitIdentityFlags(identity)} -c commit.gpgsign=false commit --no-verify -m ${text}`
      )
  );
  const sha = await readSha(workspace, 'HEAD');
  if (!sha) {
    throw ApplicationFailure.nonRetryable(
      'Could not read the commit that would be pushed, so it cannot be checked. Nothing was pushed.',
      'DIFF_CHECK_FAILED'
    );
  }
  if (guard) {
    await assertCommittedTreeWithinAllowedPaths(workspace, guard, sha);
  }
  return sha;
}

/** The commit `HEAD` is at, read with the hardened git call; undefined when it cannot be read. */
export async function readHeadSha(workspace: Exec): Promise<string | undefined> {
  return (await readSha(workspace, 'HEAD')) || undefined;
}

export function testIntegrityDiffCommand(
  from: string,
  to: string,
  kind: 'patch' | 'name-status',
  excludes: readonly string[]
): string {
  return pinnedDiffTreeCommand(from, to, { context: 1, excludes, kind });
}

/**
 * The one pinned way to read what changed between two commits, for every consumer that must see
 * the whole change whatever the repository's config, attributes or work tree say: the
 * test-integrity gate, the security scan and the reviewers' diff. `--text` is what defeats a
 * `-diff` / `binary` attribute (in a committed `.gitattributes` or in `.git/info/attributes`),
 * `--no-ext-diff` / `--no-textconv` an external driver or text conversion, `diff-tree` a
 * rewritten work tree, and the pinned environment a moved `GIT_DIR`. `pathspecs` narrows the read
 * to literal repo-relative paths; `excludes` removes top-anchored globs.
 */
export function pinnedDiffTreeCommand(
  from: string,
  to: string,
  opts: {
    kind: 'patch' | 'name-status';
    context?: number;
    excludes?: readonly string[];
    pathspecs?: readonly string[];
  }
): string {
  const config =
    '-c core.attributesFile=/dev/null -c core.quotepath=false -c diff.mnemonicPrefix=false ' +
    '-c diff.noprefix=false -c diff.relative=false -c diff.renames=true ';
  const flags =
    'diff-tree -r --no-commit-id --no-ext-diff --no-textconv --no-color --find-renames ' +
    '--ignore-submodules=none --src-prefix=a/ --dst-prefix=b/ ';
  const include = opts.pathspecs?.length
    ? opts.pathspecs.map((p) => `:(top,literal)${p}`)
    : [':(top)'];
  const specs = [...include, ...(opts.excludes ?? [])].map((p) => shellQuote(p)).join(' ');
  return guardedGit(
    `${config}${flags}${opts.kind === 'patch' ? `-p --text -U${opts.context ?? 3}` : '--name-status'} ${shellQuote(from)} ${shellQuote(to)} -- ${specs}`
  );
}

/**
 * The trees of two commits and the paths that differ between them, unfiltered, read the same
 * pinned plumbing way. For the gate's "empty diff but a changed tree" check
 * (`commitWithTestIntegrity`).
 */
export async function readTreeChange(
  workspace: Exec,
  from: string,
  to: string
): Promise<{ treesDiffer: boolean; paths: string[] }> {
  const trees = (
    await workspace.exec(
      guardedGit(`rev-parse ${shellQuote(`${from}^{tree}`)} ${shellQuote(`${to}^{tree}`)}`)
    )
  )
    .trim()
    .split('\n');
  if (trees.length !== 2 || !trees.every((t) => SHA.test(t))) {
    throw new Error('could not read the trees of the two commits');
  }
  const names = await workspace.exec(
    guardedGit(
      `diff-tree -r --name-only --no-renames --ignore-submodules=none -z ${shellQuote(from)} ${shellQuote(to)}`
    )
  );
  return {
    paths: names.split('\0').filter((p) => p !== ''),
    treesDiffer: trees[0] !== trees[1],
  };
}

/**
 * What follows `push origin`. Guarded: exactly the checked commit, to the work branch's
 * ref, so a branch the agent moved or switched cannot ride along. Unguarded: the
 * original `<branch>`.
 */
export function pushRefspec(branch: string, pushSha: string | undefined): string {
  return pushSha ? `${pushSha}:refs/heads/${shellQuote(branch)}` : shellQuote(branch);
}

/**
 * Fail non-retryably if the tree of commit `sha` differs from the session's starting tree
 * at a path outside `allowedPaths`. A direct tree comparison, so what the history looks
 * like is irrelevant. Plumbing (`diff-tree`) with submodules never ignored, because the
 * repository's own config is still read: `diff.ignoreSubmodules=all` would otherwise hide
 * a gitlink. Renames count both ends.
 */
export async function assertCommittedTreeWithinAllowedPaths(
  workspace: Exec,
  guard: PathGuard,
  sha: string
): Promise<void> {
  if (guard.refuseWorkflowChanges) {
    await assertNoWorkflowChanges(workspace, guard.sessionBase, sha);
  }
  const allowed = guard.allowedPaths;
  if (!allowed) {
    return;
  }
  let out: string;
  try {
    out = await workspace.exec(
      guardedGit(
        `diff-tree -r --name-only --no-renames --ignore-submodules=none -z ${guard.sessionBase} ${sha}`
      )
    );
  } catch {
    throw ApplicationFailure.nonRetryable(
      'The change could not be compared with the commit the workspace started from, so it ' +
        'cannot be checked. Nothing was pushed.',
      'DIFF_CHECK_FAILED'
    );
  }
  const changed = out.split('\0').filter((p) => p !== '');
  const outside = changed.filter((p) => !pathAllowed(allowed, p));
  if (outside.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `The change touches files this step may not change (${outside.slice(0, 10).join(', ')}` +
        `${outside.length > 10 ? ', …' : ''}); allowed: ${allowed.join(', ')}. ` +
        'Nothing was pushed.',
      'DIFF_OUTSIDE_ALLOWED_PATHS'
    );
  }
}

/**
 * Fail non-retryably if the tree of `sha` differs from `sessionBase` in a GitHub Actions workflow
 * or action (the files, or `.github/workflows` / `.github/actions` themselves), or by adding or
 * changing a symlink or submodule anywhere: either can point a path this check reads at content
 * it never saw. Raw entries, so each one's mode is read; renames count both ends.
 */
async function assertNoWorkflowChanges(
  workspace: Exec,
  sessionBase: string,
  sha: string
): Promise<void> {
  let changes: RawChange[];
  try {
    changes = parseRawDiffZ(
      await workspace.exec(
        guardedGit(
          `diff-tree -r --raw -z --no-abbrev --no-renames --ignore-submodules=none ${sessionBase} ${sha}`
        )
      )
    );
  } catch {
    throw ApplicationFailure.nonRetryable(
      'The change could not be compared with the commit the workspace started from, so it ' +
        'cannot be checked for workflow changes. Nothing was pushed.',
      'DIFF_CHECK_FAILED'
    );
  }
  const refused = changes
    .filter(
      (c) => isWorkflowPath(c.path) || c.newMode === SYMLINK_MODE || c.newMode === GITLINK_MODE
    )
    .map((c) => c.path);
  if (refused.length > 0) {
    throw ApplicationFailure.nonRetryable(
      'The change touches GitHub Actions workflow or action files, or adds a symlink or ' +
        `submodule (${refused.slice(0, 10).join(', ')}${refused.length > 10 ? ', …' : ''}), ` +
        'which this step may not do. Nothing was pushed.',
      'DIFF_TOUCHES_WORKFLOWS'
    );
  }
}

/**
 * The diff the step reports (`CodeResult.diff`, and from it `filesChanged`, which the
 * template's `checkScope` reads) and the exact text the security gate and the code scanner read.
 *
 * Both branches compare two COMMITS' trees through {@link pinnedDiffTreeCommand}: the committed
 * head (the pushed sha, or `HEAD` for an unguarded step) against a recorded base (the guard's
 * report sha, or the default branch's tip). Neither the work tree, the index, nor any
 * repository setting the agent controls (external diff driver, textconv, `-diff` attributes,
 * `core.worktree`) takes part, so the agent cannot blind what the scanners see. Nothing is
 * excluded here — not lockfiles, not minified files: a secret can sit in a file named like one.
 *
 * Fails closed, non-retryably (`SECURITY_GATE_UNAVAILABLE`), when the change cannot be read, or
 * when the diff is empty although the two trees differ: an empty answer for a different tree
 * means something hid the change, and "nothing found" must never read as "clean".
 */
export async function diffForResult(
  workspace: Exec,
  defaultBranch: string,
  guard: PathGuard | undefined,
  pushSha?: string
): Promise<string> {
  const unreadable = (why: string) =>
    ApplicationFailure.nonRetryable(
      `The change could not be read for the security scan (${why}). Nothing further was run.`,
      'SECURITY_GATE_UNAVAILABLE'
    );
  /** Any read that throws means the change cannot be shown to the scanners: fail closed. */
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw unreadable(err instanceof Error ? err.message : String(err));
    }
  };
  const head = pushSha ?? (await read(() => readHeadSha(workspace)));
  if (!head) {
    throw unreadable('the committed head could not be read');
  }
  let base: string;
  if (guard && !guard.report.twoTree) {
    const mergeBase = guardedGit(`merge-base ${shellQuote(guard.report.sha)} ${shellQuote(head)}`);
    base = (await read(() => workspace.exec(mergeBase))).trim();
  } else if (guard) {
    base = guard.report.sha;
  } else {
    base = await read(() => readSha(workspace, `origin/${defaultBranch}`));
  }
  if (!SHA.test(base)) {
    throw unreadable('the base commit could not be read');
  }
  const diff = await read(() =>
    workspace.exec(pinnedDiffTreeCommand(base, head, { context: 3, kind: 'patch' }))
  );
  if (diff.trim() === '') {
    const change = await read(() => readTreeChange(workspace, base, head));
    if (change.treesDiffer) {
      throw unreadable('the diff read as empty although the committed tree differs from the base');
    }
  }
  return diff;
}
