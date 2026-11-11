/**
 * The git side of `resolveMergeConflict`, hardened against the agent that resolves the conflict.
 *
 * The resolver edits files in a workspace it can also run commands in, so what it leaves behind
 * is untrusted: a staged extra file, a hook, a moved ref, a `.git/info/grafts` line. The scan of
 * a resolved merge reads exactly one thing it can trust: commit shas the WORKER recorded, the
 * target-side parent (HEAD before `git merge`) and the commit this module made, compared as trees
 * with no pathspec. To make that the whole story:
 *  - every commit the merges start from or take in is read ONCE, by {@link recordMergeInputs},
 *    right after the checkout is reset and before any repository code runs (the setup command, an
 *    agent turn), and each merge takes in that sha, never the ref name: a ref is a file the
 *    resolver for an earlier branch can repoint;
 *  - every merge and commit runs through {@link guardedGit} (hooks off, pinned repository, no
 *    system or global config, no grafts, no commit-graph) with `--no-verify`, and each merge runs
 *    after the repository config was rewritten from an allow-list and `.git/info/attributes`
 *    removed, so a merge driver, filter or attribute the agent planted cannot run in it;
 *  - the committed tree, not only the index, is compared with the snapshot outside the conflicted
 *    paths, so a merge the agent committed itself and then unstaged from is refused too;
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
import { sanitizeGitRepoConfigScript, shellQuote, type Workspace } from './workspace.js';

type Exec = Pick<Workspace, 'exec'> & { gitIdentity?: Workspace['gitIdentity'] };

const SHA = /^[0-9a-f]{40,64}$/;

/** What a merge is measured from: the two tips the worker recorded before `git merge` ran. */
export interface MergeStep {
  /** The source branch's name, for messages only; the merge takes in {@link sourceSha}. */
  source: string;
  /** The target-side parent: HEAD before the merge. */
  parent: string;
  /** The source branch's tip, recorded before any repository code or agent ran. */
  sourceSha: string;
}

/** What a resolver activity records before any repository code or agent runs. */
export interface MergeInputs {
  /** The commit HEAD is at (the reset target): the first merge's parent. */
  start: string;
  /** `origin/<source>` for each source; `''` when it cannot be read. */
  sourceTips: Record<string, string>;
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
 * Read every commit the merges depend on, ONCE: HEAD and each `origin/<source>`. Call it right
 * after the checkout is reset to the target and before anything runs repository code (the setup
 * command) or an agent: a ref read later is a ref the resolver for an earlier branch, or setup
 * code from earlier agent work, could have repointed at a commit of its own. The merges then take
 * in these shas, not the ref names.
 */
export async function recordMergeInputs(
  workspace: Exec,
  sources: readonly string[]
): Promise<MergeInputs> {
  const start = await readCommit(workspace, 'HEAD');
  const sourceTips: Record<string, string> = {};
  for (const source of sources) {
    sourceTips[source] = await readCommit(workspace, `origin/${source}`);
  }
  return { sourceTips, start };
}

/**
 * Begin a merge of the recorded `sourceSha`. `expectedHead` is the commit this activity itself
 * left HEAD at (the recorded start, then each earlier result): a HEAD that is anywhere else was
 * moved by something other than the activity.
 */
export async function startMerge(
  workspace: Exec,
  source: string,
  sourceSha: string,
  expectedHead: string
): Promise<MergeStep | { error: string }> {
  const parent = await readCommit(workspace, 'HEAD');
  if (parent !== expectedHead) {
    throw refused(
      'The checkout was moved away from the commit the merges build on, so the merge cannot be checked.'
    );
  }
  if (!sourceSha || (await readCommit(workspace, sourceSha)) !== sourceSha) {
    return { error: `could not read the tip of origin/${source}` };
  }
  return { parent, source, sourceSha };
}

/**
 * The script that rewrites the repository config from an allow-list and removes
 * `.git/info/attributes`, for the same shell as the merge that follows. Setup code and the
 * resolver run as the same user in the repository, so `merge.<name>.driver`, `filter.<name>.*`
 * and an attribute line pointing at them are theirs to plant, and a driver runs inside the next
 * merge, whose result is committed without a second look.
 */
async function scrubForMergeScript(workspace: Exec): Promise<string> {
  let url = '';
  try {
    url = (
      await workspace.exec(
        `${guardedGit('config --file .git/config --get remote.origin.url')} || true`
      )
    ).trim();
  } catch {
    url = '';
  }
  try {
    return `${sanitizeGitRepoConfigScript(url)}\nrm -f .git/info/attributes\n`;
  } catch {
    throw refused('The repository config could not be checked before the merge.');
  }
}

/** `git merge --no-ff` of the recorded source sha, hooks and drivers off. Throws on a conflict. */
export async function runMerge(workspace: Exec, message: string, step: MergeStep): Promise<void> {
  const identity = workspace.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  const scrub = await scrubForMergeScript(workspace);
  await workspace.exec(
    `set -e\n${scrub}${guardedGit(
      `${gitIdentityFlags(identity)} -c commit.gpgsign=false -c core.attributesFile=/dev/null ` +
        '-c rerere.enabled=false -c rerere.autoUpdate=false -c merge.renormalize=false ' +
        `merge --no-ff --no-edit --no-verify -m ${shellQuote(message)} ${shellQuote(step.sourceSha)}`
    )}`
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
  step: MergeStep,
  snapshot: IndexSnapshot,
  files: readonly string[]
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
  await assertCommittedTreeMatchesSnapshot(workspace, sha, snapshot, files);
  return sha;
}

/**
 * The committed tree must hold, outside the conflicted paths, exactly the entries the merge
 * left staged at stage 0 before the agent ran. {@link stageResolved} compares the index, which is
 * not what gets pushed: an agent that commits the merge itself and then unstages a file leaves an
 * index that looks right under a commit that carries it.
 */
async function assertCommittedTreeMatchesSnapshot(
  workspace: Exec,
  sha: string,
  snapshot: IndexSnapshot,
  files: readonly string[]
): Promise<void> {
  const conflicted = new Set(files);
  const raw = await execPinned(
    workspace,
    guardedGit(`ls-tree -r -z --full-tree ${shellQuote(sha)}`)
  );
  const committed = raw
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', , object = ''] = record.slice(0, tab).split(' ');
      return { key: `${mode} ${object}\t${record.slice(tab + 1)}`, path: record.slice(tab + 1) };
    })
    .filter((e) => !conflicted.has(e.path))
    .map((e) => e.key)
    .sort();
  const expected = snapshot.entries
    .filter((e) => e.stage === '0' && !conflicted.has(e.path))
    .map((e) => `${e.mode} ${e.sha}\t${e.path}`)
    .sort();
  if (committed.length !== expected.length || committed.some((k, i) => k !== expected[i])) {
    const was = new Set(expected);
    const now = new Set(committed);
    const changed = [
      ...committed.filter((k) => !was.has(k)),
      ...expected.filter((k) => !now.has(k)),
    ].map((k) => k.slice(k.indexOf('\t') + 1));
    throw refused(
      'The merge commit differs from the merge outside the conflicted files ' +
        `(${[...new Set(changed)].slice(0, 10).join(', ')}), which the resolution may not do.`
    );
  }
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
