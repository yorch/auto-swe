import { prisma } from '@auto-swe/shared/db';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import type { CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import {
  buildImplementerTurnRunner,
  type ImplementerTurnRunner,
} from '../agents/implementerRuntimeSelect.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import {
  persistActivityTrace,
  startTraceFlushing,
  traceWorkspacePreparation,
} from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { recordGitPush } from '../lib/effectLedger.js';
import { getErrorMessage, getExecErrorStdout } from '../lib/errors.js';
import { knowledgeBasePromptBlock } from '../lib/knowledgeBasePrompt.js';
import { recallLessonsBlock } from '../lib/lessonRecall.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { resolveStandInOptions } from '../lib/nulAllowedPaths.js';
import { rebaseOntoMovedBranch } from '../lib/pauseRebase.js';
import {
  checkSurfaceState,
  cloneCredentialSecrets,
  type NeedsInputResult,
  type PauseOptions,
  pauseForInput,
  readResumeInput,
  restoreForResume,
  resumeCheckoutSha,
  resumeMessage,
} from '../lib/pauseResume.js';
import { resolveRepoGateCommands, workspaceConfigReader } from '../lib/repoConfigResolver.js';
import { resolveRunBaseBranch } from '../lib/runBaseBranch.js';
import { withRunDetection } from '../lib/runDetection.js';
import { loadRunKnowledgeBases } from '../lib/runKnowledgeBases.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { runPostDiffSecurityGate } from '../lib/securityGate.js';
import { resolveTestIntegrityMode, type TestIntegrityGuardMode } from '../lib/testIntegrityGate.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import { diffForResult, pushRefspec, startPathGuard } from './allowedPaths.js';
import { commitWithTestIntegrity, startTestIntegritySession } from './testIntegritySession.js';
import {
  boundTestOutput,
  detectTestCommand,
  type NoTestsKind,
  noTestsFoundCause,
  noTestsFoundEvent,
  noTestsFoundNotes,
  noTestsRunResult,
  packageJsonReadCommand,
  parseDiffToFileChanges,
  parseTestOutput,
  testCommandSource,
  testRunCommand,
  testRunTimeoutMs,
} from './utils.js';
import {
  createWorkspace,
  fetchBranchesSubcommand,
  shellQuote,
  type Workspace,
} from './workspace.js';

export type FixMode = 'CI_FIX' | 'REVIEW_FIX' | 'GATE_FIX' | 'PR_FEEDBACK';

/**
 * The fix sessions whose goal is to make a failing check pass (CI, a quality gate, the checks a
 * pull request's feedback round triggers), and so the ones the test-integrity guard covers. A
 * review fix answers a reviewer's comments, where removing a test can be the request.
 */
const TEST_GUARDED_MODES: ReadonlySet<FixMode> = new Set(['CI_FIX', 'GATE_FIX', 'PR_FEEDBACK']);

/**
 * Connection (git_repo) row shape (the shared index doesn't export Prisma model
 * types). The installation relation is part of the shape because `toRepoRef`
 * requires it — a fix session that resolved its repo without one would clone
 * through the default installation, which for a repo in another GitHub
 * organization 404s as if the repository did not exist — and its `host`, without
 * which the installation-host check at token mint has nothing to compare.
 */
type Connection = Awaited<ReturnType<typeof prisma.connection.findUniqueOrThrow>> & {
  installation: { installationId: string; host: string } | null;
};

export interface FixSessionInput extends PauseOptions {
  mode: FixMode;
  previousCodeResult: CodeResult;
  /** Mode-specific fields merged into the user message JSON alongside `mode` and `previousDiff`. */
  userPayload: Record<string, unknown>;
  /**
   * The persona the session runs as (e.g. 'ciFixer', 'reviewFixer', 'gateFixer'):
   * its Agent row supplies the system prompt, tools, skills, MCP binding and —
   * via `inheritsModelFrom` — the model.
   */
  agentKey: string;
  /** Built-in system prompt for this mode (resolveSystemPrompt handles DB/step overrides). */
  defaultSystemPrompt: string;
  systemPromptOverride?: string;
  knowledgeBases?: boolean;
  /** When set, the change may touch only these paths; anything else fails before the push. */
  allowedPaths?: string[];
  /** Refuse, before the push, a change to a GitHub Actions workflow or action. */
  refuseWorkflowChanges?: boolean;
  /** Conventional commit message for the fix commit. */
  commitMessage: string;
  /** OTel/cost event name, e.g. 'llm.ci_fix'. */
  usageEventName: string;
  /** Compose the CodeResult.implementationNotes from the test result + optional extra note. */
  notes: (testResult: TestRunResult, extraNote: string | null) => string;
  /**
   * Optional mode-specific step after the agent run, with workspace access
   * (e.g. gate-fix re-runs the failed gate). The returned string is passed to
   * `notes` as `extraNote`. Failures here are informational, never fatal.
   */
  afterGenerate?: (workspace: Workspace, repo: Connection) => Promise<string | null>;
  /**
   * What this session is fixing, in words: lessons from past runs on the
   * repository are recalled by it into the system prompt. A CI failure's log or
   * the reviewers' rejection finds the lessons about the same failure, which
   * the ticket text the implementer recalls by would not.
   */
  lessonQuery?: string;
  /**
   * A trace event recorded as soon as the session's tracer exists — once the
   * workspace is created — so it is persisted with the session's trace however
   * the session ends from there. A failure before that (resolving the
   * repository, cloning) records nothing. The CI fixer records the failure it
   * was handed here (`lib/attemptTrace.ts`).
   */
  startEvent?: { name: string; outputJson: Record<string, unknown> };
}

/**
 * Resolve the repository a fix session targets. Prefers the explicit
 * `repoId` stamped on CodeResult by the implementer; falls back to the legacy
 * branch-name lookup for context snapshots persisted before `repoId` existed.
 * The legacy lookup is unreliable by design (branch names repeat across repos
 * and epic-child rows have a null branch) — it exists only for in-flight runs.
 */
async function resolveSessionRepo(previousCodeResult: CodeResult): Promise<Connection> {
  if (previousCodeResult.repoId) {
    return prisma.connection.findUniqueOrThrow({
      include: { installation: { select: { host: true, installationId: true } } },
      where: { id: previousCodeResult.repoId },
    });
  }
  const workflow = await prisma.activeWorkflow.findFirst({
    include: {
      repository: { include: { installation: { select: { host: true, installationId: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
    where: { assignedBranch: previousCodeResult.branch },
  });
  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }
  return workflow.repository;
}

/**
 * Shared implementer fix session used by the CI-fix, review-fix, and gate-fix
 * activities. One code path means tracing, workspace lifecycle, and — most
 * importantly — the security/code scanners behave identically on every push,
 * instead of drifting per copy (the fix paths used to skip the diff scanners
 * entirely).
 */
export async function runImplementerFixSession(
  input: FixSessionInput & { allowPause?: undefined; resumeInput?: undefined }
): Promise<CodeResult>;
export async function runImplementerFixSession(
  input: FixSessionInput
): Promise<CodeResult | NeedsInputResult>;
export async function runImplementerFixSession(
  input: FixSessionInput
): Promise<CodeResult | NeedsInputResult> {
  const { mode, previousCodeResult } = input;
  // The run after a pause: a state that is not this session's is refused before a clone.
  const resume = input.resumeInput ? readResumeInput(input.resumeInput) : undefined;
  if (resume) {
    checkSurfaceState(resume.resume, {
      agentKey: input.agentKey,
      branch: previousCodeResult.branch,
      kind: 'implementerSession',
    });
  }
  // First, before a clone or a container exists (see executeImplementation).
  await assertRolePricedForUsdCap(input.agentKey);
  const activityCtx = await currentRequestContext();
  // Before the paid session: a lookup that throws afterwards would fail retryably and re-run it.
  const guardMode: TestIntegrityGuardMode = TEST_GUARDED_MODES.has(mode)
    ? await resolveTestIntegrityMode(activityCtx)
    : 'off';
  const repo = await withRunDetection(await resolveSessionRepo(previousCodeResult));

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  // The branch the change was cut from (the run's base). A result recorded before it was
  // carried was always cut from the default branch.
  const baseBranch = await resolveRunBaseBranch(previousCodeResult.baseBranch, repo);

  const references = await loadRunKnowledgeBases({
    knowledgeBases: input.knowledgeBases,
    repoId: repo.id,
    teamId: repo.teamId,
  });
  const tracer = new AgentTracer();
  const workspace = await traceWorkspacePreparation(tracer, input.agentKey, () =>
    createWorkspace(
      authedCloneUrl,
      previousCodeResult.branch,
      baseBranch,
      executorImageFor(repo),
      // A resumed session is cut from the commit its saved tree was taken against, not the branch tip.
      resumeCheckoutSha(resume),
      undefined,
      {
        ...(resumeCheckoutSha(resume) ? { trustedBaseBranch: baseBranch } : {}),
        detectedStack: repo.detectedStack,
        knowledgeBaseSnapshotIds: references.snapshotIds,
        knowledgeBases: references.checkouts,
        repoSetup: { connectionId: repo.id, defer: true, field: repo.setup },
        teamId: repo.teamId,
        toolsFor: { connectionId: repo.id },
      }
    )
  );

  const stopTraceFlushing = startTraceFlushing(tracer, input.agentKey);
  if (input.startEvent) {
    tracer.addActivityEvent(input.startEvent);
  }
  // Holds the MCP client open under the Mastra loop — closed in finally.
  let turns: ImplementerTurnRunner | undefined;

  try {
    heartbeat(`${mode} workspace provisioned`);

    // createWorkspace clones the default branch and creates a fresh local
    // branch — it does NOT contain the implementer's pushed commits. Sync to
    // the remote branch HEAD so the agent fixes the actual tree and the final
    // push fast-forwards. (Previously only the gate-fix path did this; the
    // CI/review fix paths operated on a stale tree.)
    // A resumed session skips the sync: its workspace is already at the commit its saved
    // tree was taken against, and moving it would stop the patch applying.
    if (!resumeCheckoutSha(resume)) {
      try {
        await workspace.gitAuthed(fetchBranchesSubcommand([previousCodeResult.branch]));
        await workspace.exec(`git reset --hard origin/${shellQuote(previousCodeResult.branch)}`);
      } catch {
        // Branch may not exist remotely yet; proceed against the local clone.
        heartbeat(`${mode}: remote branch not found, using clone HEAD`);
      }
    }

    // The commit the fixer starts from, so the test-integrity gate reads exactly what the session
    // changed — staged or committed by the agent itself. Fails closed here in block mode.
    const integrity = await startTestIntegritySession(workspace, guardMode, tracer);
    // The commit the checkout is at before the agent runs (after the sync): what a pause saves the tree against.
    const startSha = (await workspace.exec('git rev-parse HEAD')).trim();

    // After the sync to the work branch, before any agent turn: this session's change is
    // checked against the branch tip it started from, so an older branch base never matters.
    // The whole change is reported against the original run's base when the previous result
    // carries it.
    const pathGuard = await startPathGuard(
      workspace,
      baseBranch,
      input.allowedPaths,
      previousCodeResult.baseSha,
      { refuseWorkflowChanges: input.refuseWorkflowChanges }
    );

    // Only now: the repository's setup command runs its own code, which includes whatever an
    // earlier agent pushed to this branch. Every fact above is recorded, so that code cannot pick
    // the base the change is measured from or the tree the integrity gate compares.
    await workspace.runSetup?.();
    await workspace.finishSetup?.();

    const packageJson = await workspace.exec(packageJsonReadCommand(repo.detectedStack));
    const fileCommands = await resolveRepoGateCommands(workspaceConfigReader(workspace, repo.id));
    const testCommand = detectTestCommand(
      packageJson,
      repo.gateCommands,
      repo.detectedStack,
      fileCommands
    );
    const testSource = testCommandSource(
      packageJson,
      repo.gateCommands,
      repo.detectedStack,
      fileCommands
    );

    // The paused session's tree goes back after the guard starts (its changes are this
    // session's own and are guarded like the rest), before any turn.
    if (resume) {
      await restoreForResume({ resume, surface: 'implementerSession', tracer, workspace });
    }

    // The session runs as its own persona (ciFixer / reviewFixer / gateFixer):
    // that Agent row's prompt, tools, skills and MCP binding, with the model
    // inherited from the implementer unless the persona overrides it.
    turns = await buildImplementerTurnRunner({
      ...(input.allowPause ? { allowPause: true } : {}),
      agentKey: input.agentKey,
      ctx: activityCtx,
      repoId: repo.id,
      tracer,
      workspace,
    });

    const systemPrompt = await resolveSystemPrompt(
      input.agentKey,
      input.defaultSystemPrompt,
      input.systemPromptOverride
    );
    const lessonsContext = input.lessonQuery
      ? await recallLessonsBlock({
          query: input.lessonQuery,
          recalledFor: input.agentKey,
          repoId: repo.id,
          tracer,
        })
      : '';
    const fullSystemPrompt =
      turns.systemPrompt(systemPrompt) +
      lessonsContext +
      (await knowledgeBasePromptBlock(workspace));
    const userMessage = JSON.stringify({
      mode,
      previousDiff: previousCodeResult.diff.slice(-20_000),
      ...input.userPayload,
    });

    await assertBudgetAvailable(input.usageEventName);
    const turn = await runImplementerTurn({
      agent: turns.agent,
      boundModelSpec: turns.boundModelSpec,
      context: { mode },
      role: input.agentKey,
      runtime: turns.runtime,
      system: fullSystemPrompt,
      tracer,
      usageEvent: input.usageEventName,
      user: resume ? resumeMessage(resume, userMessage) : userMessage,
    });

    // The agent asked a person: no gate re-run, tests, commit, push or scan. The tree is
    // saved; the workspace is destroyed below as usual.
    if (turn.needsInput) {
      return await pauseForInput({
        lastText: turn.text,
        questions: turn.needsInput,
        secrets: cloneCredentialSecrets(authedCloneUrl),
        startSha,
        state: { agentKey: input.agentKey, branch: previousCodeResult.branch },
        surface: 'implementerSession',
        tracer,
        workspace,
      });
    }

    heartbeat(`${mode} agent completed`);

    let extraNote: string | null = null;
    if (input.afterGenerate) {
      try {
        extraNote = await input.afterGenerate(workspace, repo);
      } catch {
        // Informational hook; failure does not abort the fix.
      }
    }

    let testResult: TestRunResult;
    // Set when a stack-derived command found no tests, with the output that said so.
    let noTests: { cause: { kind: NoTestsKind; reason: string }; output: string } | undefined;
    const testStart = Date.now();
    try {
      const testOutput = await workspace.exec(testRunCommand(testCommand), {
        timeoutMs: testRunTimeoutMs(testCommand),
      });
      // exec resolves only on exit 0.
      testResult = parseTestOutput(testOutput, Date.now() - testStart, 0);
      const cause = noTestsFoundCause(testSource, { result: testResult });
      noTests = cause ? { cause, output: testOutput } : undefined;
    } catch (err: unknown) {
      const cause = noTestsFoundCause(testSource, { error: err });
      noTests = cause ? { cause, output: getExecErrorStdout(err) } : undefined;
      testResult = noTests
        ? noTestsRunResult(getExecErrorStdout(err))
        : {
            duration_ms: 0,
            failing: 1,
            passed: false,
            passing: 0,
            // Bounded per component for a composite, as a single run always was.
            stdout: boundTestOutput(getExecErrorStdout(err, Number.MAX_SAFE_INTEGER)),
            total: 0,
          };
    }
    tracer.addActivityEvent({
      durationMs: Date.now() - testStart,
      name: 'tdd.test_run',
      outputJson: {
        failing: testResult.failing,
        passed: testResult.passed,
        passing: testResult.passing,
        total: testResult.total,
      },
    });
    if (noTests) {
      tracer.addActivityEvent({
        name: noTestsFoundEvent(noTests.cause.kind),
        outputJson: {
          command: testCommand,
          output: noTests.output.trim().slice(-1000),
          reason: noTests.cause.reason,
        },
      });
    }

    // Commit and push the fix (skip the commit if the agent made no changes
    // to avoid empty CI cycles; push is still safe — it's a no-op then).
    await workspace.exec('git add -A');
    // Fixes made from a failure (CI, gate, pull-request feedback): a fix that goes green by
    // deleting, skipping or weakening the tests is not a fix. The commit is made with hooks off and
    // its own diff analysed before anything is pushed (docs/ci-failure-triggers.md).
    let pushSha = await commitWithTestIntegrity(
      workspace,
      input.commitMessage,
      pathGuard,
      integrity,
      tracer
    );
    // A resumed session waited on a person while the branch could move: replay its commits on
    // top of the remote so the push fast-forwards. The path guard ran on the commit above.
    if (resume) {
      const rebased = await rebaseOntoMovedBranch(workspace, previousCodeResult.branch, {
        guard: pathGuard,
        replayBase: resumeCheckoutSha(resume),
      });
      if (rebased && pushSha) {
        pushSha = rebased;
      }
    }
    // Never push on behalf of a run that has already been cancelled.
    throwIfActivityCancelled();
    await recordGitPush(previousCodeResult.branch, pushSha, () =>
      workspace.gitAuthed(`push origin ${pushRefspec(previousCodeResult.branch, pushSha)}`)
    );

    // The pushed commit against the base recorded before the agent ran: no ref is resolved now.
    const diff = await diffForResult(
      workspace,
      pathGuard,
      pushSha,
      await resolveStandInOptions(activityCtx)
    );
    // The step reports the commit it pushed, not whatever HEAD has become.
    const headSha = pushSha;

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch: previousCodeResult.branch, headSha },
    });

    // Static code security scan (advisory findings passed to the review network,
    // same as the initial implementation path), then the security gate —
    // critical findings block the result, and a gate that cannot complete fails
    // non-retryable rather than re-running the paid session after the push.
    heartbeat('running security scan');
    const codeSecurityFindings = await runPostDiffSecurityGate(diff, tracer, {
      scanDiffForCodeIssues,
      scanDiffForSecurityIssues,
    });

    return {
      // Carried forward so the next session reports the whole change against the same base.
      ...(previousCodeResult.baseSha ? { baseSha: previousCodeResult.baseSha } : {}),
      // Carried only when the previous result had it, so a result from before the field
      // existed stays exactly as it was (the default branch).
      ...(previousCodeResult.baseBranch ? { baseBranch } : {}),
      branch: previousCodeResult.branch,
      codeSecurityFindings: codeSecurityFindings.length > 0 ? codeSecurityFindings : undefined,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: noTests
        ? `${input.notes(testResult, extraNote)} ${noTestsFoundNotes(testCommand, noTests.cause.kind)}`
        : input.notes(testResult, extraNote),
      repoId: repo.id,
      testResults: testResult,
    };
  } finally {
    stopTraceFlushing();
    // A runtime that fails to close must not leak the container or drop the trace.
    try {
      await turns?.close();
    } catch (err) {
      logWarn('implementer runtime failed to close', { error: getErrorMessage(err) });
    }
    const done = persistActivityTrace(tracer, input.agentKey);
    await workspace.destroy();
    await done;
  }
}
