/**
 * The test-integrity guard as a fix session uses it: read the commit the session starts from
 * before the agent runs, and after the agent commit what it left with hooks off, analyse THAT
 * commit's diff, and only then let the caller push it. See `lib/testIntegrityGate.ts` for what a
 * mode does and `docs/ci-failure-triggers.md` §2.4 for what is and is not covered.
 *
 * Why the committed result and not the staged tree: the commit is what gets pushed, and anything
 * between an analysis of the index and the commit (a `pre-commit` hook, a moved HEAD) could change
 * it. The commit runs with hooks off, the diff is read from the starting commit to the commit's
 * own sha, and that same sha is the one pushed (`pushRefspec`), so analysed and pushed are one.
 */
import { generatedPathspecs, isGeneratedPath } from '@auto-swe/shared/lib/testIntegrity';
import { ApplicationFailure } from '@temporalio/activity';
import type { AgentTracer } from '../lib/agentTracer.js';
import { runTestIntegrityGate, type TestIntegrityGuardMode } from '../lib/testIntegrityGate.js';
import {
  commitStaged,
  type PathGuard,
  readHeadSha,
  readTreeChange,
  testIntegrityDiffCommand,
} from './allowedPaths.js';
import type { Workspace } from './workspace.js';

type Exec = Pick<Workspace, 'exec'>;

export interface TestIntegritySession {
  mode: Exclude<TestIntegrityGuardMode, 'off'>;
  /** The commit the session started from, read before any agent turn. */
  startSha: string;
}

/**
 * Read the starting commit. `off` returns undefined. In `block` mode an unreadable start fails
 * closed here, before the paid agent session; in `warn` mode the gate is skipped and a degraded
 * event says so.
 */
export async function startTestIntegritySession(
  workspace: Exec,
  mode: TestIntegrityGuardMode,
  tracer: AgentTracer
): Promise<TestIntegritySession | undefined> {
  if (mode === 'off') {
    return undefined;
  }
  const startSha = await readHeadSha(workspace);
  if (!startSha) {
    tracer.addActivityEvent({
      error: 'could not read the commit the session started from',
      name: 'ci_fix.test_integrity_guard',
      outputJson: { blocked: mode === 'block', degraded: true, mode },
    });
    if (mode === 'block') {
      throw ApplicationFailure.nonRetryable(
        'The test-integrity guard could not read the commit the session started from, so no ' +
          'change can be checked. Nothing was committed or pushed.',
        'TEST_INTEGRITY_GUARD_UNAVAILABLE'
      );
    }
    return undefined;
  }
  return { mode, startSha };
}

/**
 * Commit what is staged and, when a session is given, run the gate on the committed result before
 * returning its sha. Without a session this is exactly `commitStaged`. With one the commit has
 * hooks off, whether or not a path guard is set; the returned sha must be what is pushed. A block
 * throws before anything is pushed.
 */
export async function commitWithTestIntegrity(
  workspace: Exec & Parameters<typeof commitStaged>[0],
  message: string,
  pathGuard: PathGuard | undefined,
  session: TestIntegritySession | undefined,
  tracer: AgentTracer
): Promise<string | undefined> {
  if (!session) {
    return commitStaged(workspace, message, pathGuard);
  }
  const sha = await commitStaged(workspace, message, pathGuard, { hardened: true });
  if (!sha) {
    return sha;
  }
  const excludes = generatedPathspecs();
  await runTestIntegrityGate({
    mode: session.mode,
    readDiff: async () => {
      const diff = await workspace.exec(
        testIntegrityDiffCommand(session.startSha, sha, 'patch', excludes)
      );
      if (diff.trim() === '') {
        await assertEmptyDiffIsReal(workspace, session.startSha, sha);
      }
      return diff;
    },
    readNameStatus: () =>
      workspace.exec(testIntegrityDiffCommand(session.startSha, sha, 'name-status', excludes)),
    tracer,
  });
  return sha;
}

/**
 * An empty diff is only believable when the two commits really hold the same files. The diff is
 * read by plumbing pinned to the checkout, so an empty answer for a different commit means
 * something below the analyser hid the change, and "nothing found" must not be read as "intact".
 * Throws (which the gate turns into `TEST_INTEGRITY_GUARD_UNAVAILABLE` in `block` mode and a
 * `degraded` event in `warn` mode) when the trees differ at a path that is not a generated file,
 * or differ at no readable path at all. A change that touched only lockfiles is empty by design.
 */
async function assertEmptyDiffIsReal(workspace: Exec, startSha: string, sha: string) {
  const change = await readTreeChange(workspace, startSha, sha);
  if (!change.treesDiffer) {
    return;
  }
  if (change.paths.length === 0 || change.paths.some((p) => !isGeneratedPath(p))) {
    throw new Error(
      'the diff of the committed change read as empty although its tree differs from the one the ' +
        'session started from, so the change could not be read'
    );
  }
}
