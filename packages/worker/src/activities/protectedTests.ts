/**
 * Protected verification: put the repository's own tests back before a gate judges a change.
 *
 * A change an agent made is verified by running the repository's tests. If the agent could edit
 * those tests, "the tests pass" would only mean it edited them until they did. So a gate that
 * opts in (`protectTests` on `runTests`) restores, in ITS OWN workspace, every test file, test
 * support file and pure test-runner config the change touched to the content it has at the base
 * the change's code result recorded before any agent or recipe ran (`CodeResult.baseSha`). The
 * restore is never committed or pushed: the gate workspace is
 * discarded, so the branch keeps the agent's tests (a person sees them in the pull request) and
 * only the verdict ignores them.
 *
 * What it does not touch, on purpose: `package.json`, `go.mod`, `pom.xml`, `pyproject.toml` and
 * the like. They carry the upgrade itself, and they are only partly about tests; the test-integrity
 * guard's heuristics (`testIntegrity: 'block'` on the agent steps) are what read those.
 *
 * The base is that recorded sha, never a merge base computed here: the agent chooses its commit's
 * history (it can rebuild `HEAD` on an older ancestor), and a merge base it moved would restore
 * tests to an older version and drop every test added since. The comparison is two trees, the
 * recorded base's and the branch tip's, so the history between them does not matter. When the
 * caller knows the commit the change reported (`headSha`), a branch tip that is any other commit
 * is refused rather than verified.
 *
 * Everything here runs right after the gate's clone and fetch, before the repository's setup or
 * any other repository-controlled code, so the checkout's `.git` holds only what git wrote. The
 * reads are still the hardened, pinned plumbing the security scan uses (`guardedGit`: no replace
 * objects, no grafts or commit graph, no system or global config, pinned `GIT_DIR` and work
 * tree), and the changed-path list ends in a per-call marker (`execPinned`), so a capture cut
 * short fails closed instead of restoring fewer files. The writes do not
 * use the repository's `.git` at all: they run against a pristine git directory that shares only
 * the object database (see {@link isolatedScript}), so no filter driver, hook, `info/attributes`
 * or fsmonitor the repository names can run while a file is written. System and global config are
 * ignored, replace refs are not followed, and every path is a literal, never a pathspec.
 *
 * Fails closed. Without a base to restore from, or when a restore does not leave the protected
 * paths equal to the base, the gate does not run: `PROTECTED_TESTS_UNAVAILABLE` is non-retryable,
 * because a verdict that cannot say the tests are the originals must not be a pass.
 */
import {
  isPureTestConfig,
  isTestFilePath,
  isTestSupportPath,
} from '@auto-swe/shared/lib/testIntegrity';
import { ApplicationFailure } from '@temporalio/activity';
import { execPinned, guardedGit } from './allowedPaths.js';
import {
  fetchBranchesSubcommand,
  gitWithAuthHeader,
  shellQuote,
  type Workspace,
} from './workspace.js';

type ProtectWorkspace = Pick<Workspace, 'exec' | 'gitAuthed'>;

export const PROTECTED_TESTS_UNAVAILABLE = 'PROTECTED_TESTS_UNAVAILABLE';

/** The recorded activity event. */
export const PROTECTED_TESTS_EVENT = 'campaign.protected_tests';

/** Longest path list stored on the event. */
export const PROTECTED_TESTS_EVENT_LIST_CAP = 50;

/** Characters of path arguments per git command, well below the kernel's single-argument cap. */
const MAX_COMMAND_PATH_CHARS = 30_000;

/** How far the history is deepened, per attempt, to bring a recorded base into a shallow clone. */
const DEEPEN_STEPS = [200, 1000] as const;

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The security scan's hardened, pinned git call ({@link guardedGit}) with attributes off and, by
 * default, `GIT_LITERAL_PATHSPECS`, which makes every path argument a literal, so a file named
 * `:(top)x` or `*.ts` is that file and nothing wider.
 */
export function pinnedGit(subcommand: string, opts: { literalPathspecs?: boolean } = {}): string {
  return (
    `${opts.literalPathspecs === false ? '' : 'GIT_LITERAL_PATHSPECS=1 '}GIT_ATTR_NOSYSTEM=1 ` +
    guardedGit(
      `-c core.attributesFile=/dev/null -c core.quotepath=false -c core.autocrlf=false ${subcommand}`
    )
  );
}

export interface TreeChange {
  /** `A`dded, `M`odified, `D`eleted or `T` (type changed) between the base and the branch. */
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
}

/** Whether a path belongs to the tests a change must not be able to edit its way past. */
export function isProtectedTestPath(path: string): boolean {
  return isTestFilePath(path) || isTestSupportPath(path) || isPureTestConfig(path);
}

/**
 * Parse `git diff-tree -r -z --name-status --no-renames` output: `STATUS NUL path NUL` pairs.
 * Throws on anything else, rather than guessing which of two paths a status meant.
 */
export function parseNameStatusZ(out: string): TreeChange[] {
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  if (parts.length % 2 !== 0) {
    throw new Error('unexpected name-status output');
  }
  const changes: TreeChange[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i] as string;
    const path = parts[i + 1] as string;
    if ((status !== 'A' && status !== 'M' && status !== 'D' && status !== 'T') || path === '') {
      throw new Error('unexpected name-status entry');
    }
    changes.push({ path, status });
  }
  return changes;
}

/** Split the changes into the paths to put back (`M`, `D`, `T`) and the ones to remove (`A`). */
export function selectProtectedChanges(changes: readonly TreeChange[]): {
  restore: string[];
  remove: string[];
} {
  const restore: string[] = [];
  const remove: string[] = [];
  for (const change of changes) {
    if (!isProtectedTestPath(change.path)) {
      continue;
    }
    (change.status === 'A' ? remove : restore).push(change.path);
  }
  return { remove: remove.sort(), restore: restore.sort() };
}

/** Group quoted paths into command-sized chunks. */
export function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const path of paths) {
    const cost = path.length * 2 + 4; // quoting can double a path
    if (current.length > 0 && size + cost > MAX_COMMAND_PATH_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export interface ProtectedTestsReport {
  /** The recorded base the protected files were restored to. */
  base: string;
  restored: string[];
  removed: string[];
  /** One line for the gate summary. */
  summary: string;
  /** The activity event body: the lists capped, the full counts kept. */
  event: {
    base: string;
    restored: string[];
    removed: string[];
    restoredCount: number;
    removedCount: number;
  };
}

function unavailable(reason: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Protected verification could not restore the repository's original tests, so the gate did ` +
      `not run: ${reason}`,
    PROTECTED_TESTS_UNAVAILABLE
  );
}

async function hasCommit(workspace: ProtectWorkspace, sha: string): Promise<boolean> {
  try {
    await workspace.exec(pinnedGit(`cat-file -e ${shellQuote(`${sha}^{commit}`)}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure commit `sha` is in the checkout, deepening a shallow history a step at a time when it
 * is not there yet. Returns whether it is. The sha is the caller's, recorded before any agent or
 * recipe ran; nothing here resolves a ref to choose it.
 */
export async function ensureCommit(
  workspace: ProtectWorkspace,
  sha: string,
  branches: { baseBranch: string; branch: string }
): Promise<boolean> {
  if (!SHA.test(sha)) {
    return false;
  }
  if (await hasCommit(workspace, sha)) {
    return true;
  }
  for (const depth of DEEPEN_STEPS) {
    try {
      // `fetchBranchesSubcommand` names both branches by explicit refspec.
      await workspace.gitAuthed(
        fetchBranchesSubcommand([branches.baseBranch, branches.branch]).replace(
          /^fetch /,
          `fetch --deepen=${depth} --no-tags `
        )
      );
    } catch {
      return false;
    }
    if (await hasCommit(workspace, sha)) {
      return true;
    }
  }
  return false;
}

const paths = (chunk: readonly string[]): string => chunk.map(shellQuote).join(' ');

/**
 * A script that runs git against a pristine git directory that shares only the repository's
 * object database.
 *
 * Writing files into the work tree is where a repository's own configuration would matter: a
 * `filter` driver named in `.gitattributes`, `.git/info/attributes` or `.git/config` runs a
 * command on checkout, `core.worktree` moves the tree, and a hook or `core.fsmonitor` runs on
 * nearly any porcelain call. So the writes do not use the repository's `.git` at all. A fresh bare
 * directory (empty config, no attributes, no hooks) is created, pointed at the real objects with
 * `GIT_OBJECT_DIRECTORY`, given a throwaway index per tree, and told the work tree explicitly.
 * Nothing the repository's configuration says reaches it, and a filter named in a tracked
 * `.gitattributes` has no driver to run.
 *
 * `body` runs with `$T` (a scratch directory, removed on exit) set and the hardened `G` shell
 * function standing for `git`; it picks a throwaway index with `GIT_INDEX_FILE`.
 */
function isolatedScript(body: string[]): string {
  const hardened = gitWithAuthHeader(
    '-c core.attributesFile=/dev/null -c core.quotepath=false -c core.autocrlf=false "$@"'
  );
  return [
    'set -eu',
    'REPO="$(pwd -P)"',
    'T="$(mktemp -d)"',
    'trap \'rm -rf "$T"\' EXIT',
    '(cd "$T" && GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init -q --bare g)',
    'export GIT_DIR="$T/g" GIT_OBJECT_DIRECTORY="$REPO/.git/objects" GIT_WORK_TREE="$REPO"',
    'export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_LITERAL_PATHSPECS=1 GIT_ATTR_NOSYSTEM=1',
    `G() { ${hardened}; }`,
    ...body,
  ].join('\n');
}

/** What a protected gate verifies against: the shas the change's code result recorded. */
export interface ProtectedTestsTarget {
  /** The base the change was measured from, recorded before any agent or recipe ran. */
  baseSha?: string;
  /** The commit the change reported as pushed; the branch tip must be this commit when given. */
  headSha?: string;
}

/**
 * Restore the protected test paths the change touched to their content at the recorded base. See
 * the module comment. `baseBranch` is the run's base branch; the checkout must be at the branch
 * tip, and nothing repository-controlled may have run in it yet.
 */
export async function restoreProtectedTests(
  workspace: ProtectWorkspace,
  opts: ProtectedTestsTarget & { baseBranch: string; branch: string }
): Promise<ProtectedTestsReport> {
  const base = opts.baseSha ?? '';
  if (!SHA.test(base)) {
    throw unavailable('the change carries no recorded base commit to restore the tests from.');
  }
  if (!(await ensureCommit(workspace, base, opts))) {
    throw unavailable(`the recorded base ${base.slice(0, 8)} is not in the branch's history.`);
  }

  let head: string;
  try {
    head = (
      await workspace.exec(pinnedGit(`rev-parse --verify ${shellQuote('HEAD^{commit}')}`))
    ).trim();
  } catch {
    head = '';
  }
  if (!SHA.test(head)) {
    throw unavailable('the branch tip could not be read.');
  }
  if (opts.headSha !== undefined && opts.headSha !== head) {
    throw unavailable(
      `the branch tip ${head.slice(0, 8)} is not the commit the change reported ` +
        `(${opts.headSha.slice(0, 8)}).`
    );
  }

  let changes: TreeChange[];
  try {
    changes = parseNameStatusZ(
      await execPinned(
        workspace,
        pinnedGit(
          `diff-tree -r -z --name-status --no-renames --ignore-submodules=none ${base} ${head}`
        )
      )
    );
  } catch {
    throw unavailable('the branch could not be compared with its base.');
  }
  const { restore, remove } = selectProtectedChanges(changes);

  try {
    for (const chunk of chunkPaths(restore)) {
      await workspace.exec(
        isolatedScript([
          `export GIT_INDEX_FILE="$T/base-index"`,
          `G read-tree ${base}`,
          `G checkout-index -f -u -q -- ${paths(chunk)}`,
          // Checked, not assumed: with the stat data checkout-index just recorded, the work tree
          // must equal the base tree at exactly these paths.
          `if [ -n "$(G diff-files --name-only -z -- ${paths(chunk)} | tr -d '\\000')" ]; then echo 'restored files differ from the base' >&2; exit 8; fi`,
        ])
      );
    }
    for (const chunk of chunkPaths(remove)) {
      await workspace.exec(
        isolatedScript([
          `export GIT_INDEX_FILE="$T/head-index"`,
          `G read-tree ${head}`,
          `G rm -f -q --ignore-unmatch -- ${paths(chunk)}`,
          `for p in ${paths(chunk)}; do if [ -e "$p" ] || [ -L "$p" ]; then echo "still present: $p" >&2; exit 7; fi; done`,
        ])
      );
    }
  } catch {
    throw unavailable('a protected file could not be restored.');
  }

  const summary =
    restore.length + remove.length === 0
      ? `protected verification: no test files differed from ${base.slice(0, 8)}`
      : `restored ${restore.length} test files from ${base.slice(0, 8)}` +
        (remove.length > 0 ? ` and removed ${remove.length} added by the change` : '');
  return {
    base,
    event: {
      base,
      removed: remove.slice(0, PROTECTED_TESTS_EVENT_LIST_CAP),
      removedCount: remove.length,
      restored: restore.slice(0, PROTECTED_TESTS_EVENT_LIST_CAP),
      restoredCount: restore.length,
    },
    removed: remove,
    restored: restore,
    summary,
  };
}
