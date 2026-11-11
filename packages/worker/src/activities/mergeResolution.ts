/**
 * The git side of `resolveMergeConflict`, hardened against the agent that resolves the conflict.
 *
 * The resolver edits files in a workspace it can also run commands in, so what it leaves behind
 * is untrusted: a staged extra file, a hook, a moved ref, a `.git/info/grafts` line. The scan of
 * a resolved merge reads exactly one thing it can trust: two commit shas the WORKER recorded, the
 * target-side parent (HEAD before `git merge`) and the commit this module made, compared as trees
 * with no pathspec. To make that the whole story:
 *  - every merge and commit runs through {@link guardedGit} (hooks off, pinned repository, no
 *    system or global config, no grafts, no commit-graph) with `--no-verify`;
 *  - the index is snapshotted before the agent runs and compared after, so only the conflicted
 *    paths may differ (an `evil.py` the agent staged, or a file it changed outside the set, is
 *    refused rather than committed);
 *  - the result is accepted only if its parents are exactly the recorded target tip and the
 *    recorded source tip, read from the commit object itself, not through `^1`;
 *  - the activity pushes `<sha>:refs/heads/<target>` for the sha it tracked, so a branch or ref
 *    the agent moved cannot ride along.
 */
import { ApplicationFailure } from '@temporalio/activity';
import { DEFAULT_GIT_IDENTITY, gitIdentityFlags } from '../lib/gitIdentity.js';
import { execPinned, guardedGit, pinnedDiffTreeCommand, readTreeChange } from './allowedPaths.js';
import { standInBinarySections } from './scanDiffText.js';
import { shellQuote, type Workspace } from './workspace.js';

type Exec = Pick<Workspace, 'exec'> & { gitIdentity?: Workspace['gitIdentity'] };

const SHA = /^[0-9a-f]{40,64}$/;

/** What a merge is measured from: the two tips read by the worker before `git merge` ran. */
export interface MergeStep {
  /** The target-side parent: HEAD before the merge. */
  parent: string;
  /** The source branch's tip, read before the merge. */
  sourceSha: string;
}

const refused = (message: string) =>
  ApplicationFailure.nonRetryable(`${message} Nothing was pushed.`, 'MERGE_RESOLUTION_REFUSED');

/** The commit `rev` names, read with the hardened git call; '' when it cannot be read. */
async function readCommit(workspace: Exec, rev: string): Promise<string> {
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
 * Record the two tips a merge starts from, before it runs. `expectedHead` is the commit this
 * activity itself left HEAD at (the reset target, then each earlier result): a HEAD that is
 * anywhere else was moved by something other than the activity.
 */
export async function startMerge(
  workspace: Exec,
  source: string,
  expectedHead: string
): Promise<MergeStep | { error: string }> {
  const parent = await readCommit(workspace, 'HEAD');
  if (parent !== expectedHead) {
    throw refused(
      'The checkout was moved away from the commit the merges build on, so the merge cannot be checked.'
    );
  }
  const sourceSha = await readCommit(workspace, `origin/${source}`);
  if (!sourceSha) {
    return { error: `could not read the tip of origin/${source}` };
  }
  return { parent, sourceSha };
}

/** `git merge --no-ff` with hooks off. Throws on a conflict, with git's output on the error. */
export async function runMerge(workspace: Exec, message: string, source: string): Promise<void> {
  const identity = workspace.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  await workspace.exec(
    guardedGit(
      `${gitIdentityFlags(identity)} -c commit.gpgsign=false merge --no-ff --no-edit --no-verify ` +
        `-m ${shellQuote(message)} ${shellQuote(`origin/${source}`)}`
    )
  );
}

/** The parent shas written in a commit object, read from the object (grafts cannot change it). */
async function parentsOf(workspace: Exec, sha: string): Promise<string[]> {
  const raw = await execPinned(workspace, guardedGit(`cat-file commit ${shellQuote(sha)}`));
  const headerEnd = raw.indexOf('\n\n');
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  return header
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim());
}

/**
 * Pin the commit HEAD is at after a merge and require it to be exactly that merge: HEAD still at
 * the recorded parent (nothing to merge), or a commit whose parents are the recorded target tip
 * and source tip. Anything else (an extra commit the agent made, a rewritten history) is refused.
 * Returns the sha to track and push.
 */
export async function settleMerge(workspace: Exec, step: MergeStep): Promise<string> {
  const head = await readCommit(workspace, 'HEAD');
  if (!head) {
    throw refused('The merge commit could not be read, so it cannot be checked.');
  }
  if (head === step.parent) {
    return head;
  }
  const parents = await parentsOf(workspace, head);
  if (parents.length !== 2 || parents[0] !== step.parent || parents[1] !== step.sourceSha) {
    throw refused(
      'The merge commit is not a merge of the recorded target and source tips, so it cannot be checked.'
    );
  }
  return head;
}

/** One index entry of `git ls-files -s -z`. */
interface IndexEntry {
  mode: string;
  path: string;
  sha: string;
  stage: string;
}

/** The index as git holds it: the merge's clean paths at stage 0 and the conflicted ones above. */
export interface IndexSnapshot {
  entries: IndexEntry[];
}

async function readIndex(workspace: Exec): Promise<IndexEntry[]> {
  const raw = await execPinned(workspace, guardedGit('ls-files -s -z'));
  return raw
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', sha = '', stage = ''] = record.slice(0, tab).split(' ');
      return { mode, path: record.slice(tab + 1), sha, stage };
    });
}

/** Read the index right after the conflicting merge, before the agent runs. */
export async function snapshotIndex(workspace: Exec): Promise<IndexSnapshot> {
  return { entries: await readIndex(workspace) };
}

const entryKey = (e: IndexEntry) => `${e.mode} ${e.sha} ${e.stage}\t${e.path}`;

/**
 * Stage exactly the conflicted paths (a path the resolver deleted is staged as a removal); `unmerged`
 * when git still holds an unmerged path. Otherwise refuse unless the index differs from the pre-agent snapshot ONLY at those paths and holds no
 * unmerged entry. That is the "staged names equal the conflicted list" rule: the merge's cleanly
 * merged paths are staged too, so the comparison is against the snapshot, not an empty index.
 */
export async function stageResolved(
  workspace: Exec,
  snapshot: IndexSnapshot,
  files: readonly string[]
): Promise<'staged' | 'unmerged'> {
  await workspace.exec(guardedGit(`add -- ${files.map((f) => shellQuote(f)).join(' ')}`));
  const conflicted = new Set(files);
  const after = await readIndex(workspace);
  if (after.some((e) => e.stage !== '0')) {
    return 'unmerged';
  }
  const expected = snapshot.entries
    .filter((e) => !conflicted.has(e.path))
    .map(entryKey)
    .sort();
  const actual = after
    .filter((e) => !conflicted.has(e.path))
    .map(entryKey)
    .sort();
  if (expected.length !== actual.length || expected.some((k, i) => k !== actual[i])) {
    const was = new Set(expected);
    const now = new Set(actual);
    const changed = [
      ...actual.filter((k) => !was.has(k)),
      ...expected.filter((k) => !now.has(k)),
    ].map((k) => k.slice(k.indexOf('\t') + 1));
    throw refused(
      'The resolver changed the index outside the conflicted files ' +
        `(${[...new Set(changed)].slice(0, 10).join(', ')}), which the resolution may not do.`
    );
  }
  return 'staged';
}

/**
 * Commit the resolution with hooks off and return its sha, after checking it is the merge of the
 * recorded tips. If the agent already committed the merge itself, that commit is the one checked.
 */
export async function commitResolvedMerge(
  workspace: Exec,
  message: string,
  step: MergeStep
): Promise<string> {
  const identity = workspace.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  if ((await readCommit(workspace, 'HEAD')) === step.parent) {
    await workspace.exec(
      guardedGit(
        `${gitIdentityFlags(identity)} -c commit.gpgsign=false commit --no-verify -m ${shellQuote(message)}`
      )
    );
  }
  const sha = await settleMerge(workspace, step);
  if (sha === step.parent) {
    throw refused('The resolution produced no merge commit.');
  }
  return sha;
}

/**
 * Everything the resolution changed relative to the recorded target-side parent, as the text the
 * scanners read: no pathspec, so a file the resolver added outside the conflict set is in it, and
 * binaries reduced to their printable strings. Fails closed (`SECURITY_GATE_UNAVAILABLE`) when
 * the diff reads as empty although the trees differ.
 */
export async function diffResolution(
  workspace: Exec,
  parent: string,
  sha: string
): Promise<string> {
  const patch = await execPinned(
    workspace,
    pinnedDiffTreeCommand(parent, sha, { context: 3, kind: 'patch' })
  );
  if (patch.trim() === '' && (await readTreeChange(workspace, parent, sha)).treesDiffer) {
    throw ApplicationFailure.nonRetryable(
      'The resolved merge changed files but its diff read as empty, so it cannot be scanned.',
      'SECURITY_GATE_UNAVAILABLE'
    );
  }
  return standInBinarySections(patch);
}

/** Refuse unless HEAD is still the commit the activity tracked: that is what gets pushed. */
export async function assertHeadIs(workspace: Exec, sha: string): Promise<void> {
  if ((await readCommit(workspace, 'HEAD')) !== sha) {
    throw refused('The checkout was moved after the merges were checked.');
  }
}
