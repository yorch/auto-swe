import { prisma } from '@auto-swe/shared/db';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import type { FigmaDesignSummary } from '@auto-swe/shared/lib/integrations/figmaDesign';
import { PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import {
  resolveIssueTrackerConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import { workBranchOf } from '@auto-swe/shared/lib/workflowId';
import type {
  CodeResult,
  RepoWorkRequest,
  Subtask,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { resolveImplementerConfig } from '../agents/implementer.js';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import {
  buildImplementerTurnRunner,
  type ImplementerTurnRunner,
} from '../agents/implementerRuntimeSelect.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import {
  currentAttempt,
  currentWorkflowId,
  persistActivityTrace,
  startTraceFlushing,
} from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { formatCriteriaContext } from '../lib/criteriaContext.js';
import { getErrorMessage, getExecErrorStdout } from '../lib/errors.js';
import { recallLessonsBlock } from '../lib/lessonRecall.js';
import { resolveSystemPrompt } from '../lib/models.js';
import {
  type CrossRepoStepOptions,
  checkoutUpstreamRepos,
  loadRepoDependencyContext,
  wantsCrossRepoCheckout,
  wantsCrossRepoContext,
} from '../lib/repoDependencyContext.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { withRunDetection } from '../lib/runDetection.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { runPostDiffSecurityGate } from '../lib/securityGate.js';
import { resolveTicketContext } from '../lib/ticketFallback.js';
import { requestHasTrackerTicket } from '../lib/trackerTicket.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import {
  commitStaged,
  diffForResult,
  type PathGuardOptions,
  pushRefspec,
  startPathGuard,
} from './allowedPaths.js';
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
  testStatusWord,
  unrunnableTestCause,
} from './utils.js';
import { createWorkspace, fetchBranchesSubcommand, shellQuote } from './workspace.js';

/**
 * Render the stored Figma design summary (a `FigmaDesignSummary[]` written by
 * the gateway's design enrichment) into a compact prompt block. Returns '' when
 * there is no usable design context. Bounded so it can never blow the
 * implementer's context budget regardless of design size.
 */
function formatDesignContext(rawDesign: unknown): string {
  if (!Array.isArray(rawDesign) || rawDesign.length === 0) {
    return '';
  }
  const summaries = rawDesign as FigmaDesignSummary[];
  const lines: string[] = [];
  for (const s of summaries.slice(0, 3)) {
    lines.push(`### ${s.fileName ?? 'Figma design'}${s.url ? ` (${s.url})` : ''}`);
    for (const node of (s.nodes ?? []).slice(0, 8)) {
      const children =
        node.childNames && node.childNames.length > 0
          ? ` — children: ${node.childNames.slice(0, 12).join(', ')}`
          : '';
      lines.push(`- **${node.name ?? 'node'}** (${node.type ?? 'NODE'})${children}`);
      const texts = (node.texts ?? []).slice(0, 8);
      if (texts.length > 0) {
        lines.push(`  text: ${texts.map((t) => JSON.stringify(t)).join(', ')}`);
      }
    }
    const tokens = (s.tokens ?? []).slice(0, 24);
    if (tokens.length > 0) {
      lines.push(`tokens: ${tokens.map((t) => `${t.name}=${t.value}`).join('; ')}`);
    }
    if (s.truncated) {
      lines.push('(design summary truncated)');
    }
  }
  if (lines.length === 0) {
    return '';
  }
  return `\n\n## Referenced Figma Design\nMatch the implementation to this design — see the *design-fidelity* skill.\n${lines.join('\n')}`;
}

/**
 * Run the implementer agent for a work request.
 *
 * When `subtask` is supplied (phase-3 fan-out), the activity:
 *   - uses a sub-branch `<BRANCH_PREFIX>/<ticket>/<subtask.id>`
 *   - injects the subtask description into the implementer's user message
 *     in place of the full work-request description
 *
 * Subtask branches are merged back into the parent feature branch by the
 * `mergeBranches` activity before the final PR is opened.
 */
// Note: toolsOverride parameter was removed — tool selection is superseded by
// DB-driven AgentSkillAssignment rows (WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade).
export async function executeImplementation(
  request: RepoWorkRequest,
  subtask?: Subtask,
  systemPromptOverride?: string,
  crossRepoOptions?: CrossRepoStepOptions,
  /** When set, the change may touch only these paths; anything else fails before the push. */
  allowedPaths?: string[],
  /** Further pre-push refusals (`config.refuseWorkflowChanges`). */
  guardOptions?: PathGuardOptions,
  /**
   * The tracker ticket as an earlier step rendered it (`gatherTicketContext`'s `text`). An empty
   * string means the run has none; unset, the ticket is fetched here only when
   * `workflow.ticketContextFallback` is on.
   */
  ticketFromStep?: string,
  /**
   * The success criteria `validateContext` extracted, ambiguity entries included. The prompt gets
   * the concrete ones as what to satisfy and the rest as open questions; unset adds nothing.
   */
  successCriteria?: readonly string[]
): Promise<CodeResult> {
  // First, before a clone or a container exists: an unpriced model under a USD
  // cap is refused here, not after the workspace has been built.
  await assertRolePricedForUsdCap('implementer');

  const repo = await withRunDetection(
    await prisma.connection.findUniqueOrThrow({
      include: { installation: { select: { host: true, installationId: true } } },
      where: { id: requireRepoId(request, 'executeImplementation') },
    })
  );

  const workflowDefaults = await resolveWorkflowDefaults();
  const featureBranch = workBranchOf(request, workflowDefaults.branchPrefix);
  const branch = subtask ? `${featureBranch}/${subtask.id}` : featureBranch;

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  // The branch the change is cut from and diffed against: the launch's base, else the
  // repository's default. Clone, path guard and diff must all use the same one.
  const baseBranch = await resolveRequestBaseBranch(request, repo);
  const activityCtx = await currentRequestContext();
  let services: ReturnType<typeof PreviewConfigSchema.parse>['services'];
  if (repo.previewConfig) {
    const implementerConfig = await resolveImplementerConfig(activityCtx, 'implementer');
    if (implementerConfig.toolKeys?.includes('browser')) {
      services = PreviewConfigSchema.parse(repo.previewConfig).services;
    }
  }

  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    baseBranch,
    executorImageFor(repo),
    undefined,
    undefined,
    { detectedStack: repo.detectedStack, services, teamId: repo.teamId }
  );

  const tracer = new AgentTracer();
  // The run viewer tails traces while this runs; the final persist in finally writes the rest.
  const stopTraceFlushing = startTraceFlushing(tracer, 'implementer');
  // Holds the MCP client open under the Mastra loop — closed in finally.
  let turns: ImplementerTurnRunner | undefined;

  // Before anything the agent can touch: the commit the guarded change is measured from.
  // Inside the try so a failure still destroys the workspace.
  let pathGuard: Awaited<ReturnType<typeof startPathGuard>>;

  // Capture the base commit SHA (defaultBranch HEAD at workspace creation time)
  // for the optional historical-replay tier — stored best-effort on WorkflowRun.
  let baseSha: string | undefined;
  try {
    baseSha = (await workspace.exec('git rev-parse HEAD')).trim();
  } catch {
    // non-fatal — omit if workspace exec fails
  }

  try {
    heartbeat('workspace provisioned');

    // Retry safety. This activity can fail AFTER its push (the diff read, the
    // scanners, the security gate), and createWorkspace always cuts a fresh
    // `branch` from defaultBranch HEAD — so a retry would rebuild the change
    // from scratch and then have its push rejected as non-fast-forward. Sync to
    // whatever a previous attempt pushed, exactly as the fix sessions do.
    if (currentAttempt() > 1) {
      try {
        await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
        await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
      } catch {
        // Nothing pushed yet — the previous attempt failed before its push.
        heartbeat('retry: remote branch not found, starting from clone HEAD');
      }
    }

    // After any sync to a previous attempt's pushed branch, and before any agent turn:
    // this session answers for its own changes from here. `baseSha` (the base branch's
    // tip, read before the agent) is what the whole change is reported against.
    pathGuard = await startPathGuard(workspace, baseBranch, allowedPaths, baseSha, guardOptions);

    // Detect test framework
    const packageJson = await workspace.exec(packageJsonReadCommand(repo.detectedStack));
    const testCommand = detectTestCommand(packageJson, repo.gateCommands, repo.detectedStack);
    const testSource = testCommandSource(packageJson, repo.gateCommands, repo.detectedStack);

    // The runtime — the Mastra loop or the Claude Code harness — is chosen first,
    // and only what it needs is built: tool config + skills (WORKFLOW_TEMPLATE →
    // TEAM → GLOBAL cascade), and under Mastra the agent and any MCP server, bound
    // to the workspace so the tracer captures every call. The runtime decides how
    // skills reach the prompt, so the suffix comes back from it.
    turns = await buildImplementerTurnRunner({
      ctx: activityCtx,
      repoId: requireRepoId(request, 'executeImplementation'),
      tracer,
      workspace,
    });
    const { agent: turnAgent, boundModelSpec, runtime, skills } = turns;

    tracer.addActivityEvent({
      name: 'skills.loaded',
      outputJson: { count: skills.length, skills: skills.map((s) => s.name) },
    });

    // Lessons from past runs on this repository, recalled by the ticket text.
    // Best-effort: recall failing must not block implementation.
    const lessonsContext = await recallLessonsBlock({
      query: request.description,
      recalledFor: 'implementer',
      repoId: requireRepoId(request, 'executeImplementation'),
      tracer,
    });

    heartbeat('lessons retrieved');

    // Design context (P1): when the work request's snapshot carries a Figma
    // design summary, surface a compact description so the implementer can match
    // it. Best-effort — a read failure must not block implementation.
    let designContext = '';
    try {
      const snapshot = await prisma.contextSnapshot.findUnique({
        select: { rawDesign: true },
        where: { workRequestId: request.workRequestId },
      });
      designContext = formatDesignContext(snapshot?.rawDesign);
      if (designContext) {
        tracer.addActivityEvent({
          name: 'design.context_loaded',
          outputJson: { chars: designContext.length },
        });
      }
    } catch {
      // Design context is optional — never block implementation on it.
    }

    // The tracker ticket behind this run: the submitter's description is often a line or two, and the
    // ticket holds the actual requirements. It arrives from the workflow's gatherer step, or, when
    // the workflow has none and the fallback setting is on, is fetched here. Best-effort either way.
    const ticketContext = await resolveTicketContext(ticketFromStep, {
      ctx: activityCtx,
      tracer,
      workRequestId: request.workRequestId,
    });

    // Cross-repo dependency context (repo dependency graph, P2): the active
    // 1-hop graph around this repo — upstream contracts to honour, downstream
    // consumers to avoid breaking. Best-effort exactly like design context; the
    // loader swallows its own failures. The optional `full_checkout` tier
    // additionally clones the upstream repos into /workspace/deps (opt-in, off
    // by default) and appends the paths to the same block.
    let crossRepoContext = '';
    if (wantsCrossRepoContext(crossRepoOptions)) {
      try {
        crossRepoContext = await loadRepoDependencyContext(repo.id, activityCtx.orgId);
        if (crossRepoContext && wantsCrossRepoCheckout(crossRepoOptions)) {
          crossRepoContext += await checkoutUpstreamRepos(workspace, repo.id, activityCtx.orgId);
        }
        if (crossRepoContext) {
          tracer.addActivityEvent({
            name: 'crossRepo.context_loaded',
            outputJson: { chars: crossRepoContext.length },
          });
        }
      } catch {
        // Both helpers already swallow their own failures; this is the outer
        // belt — cross-repo context must never block implementation.
        crossRepoContext = '';
      }
    }

    // Fire-and-forget tracker sync — never blocks implementation
    requestHasTrackerTicket(request.workRequestId, request.externalTicketId)
      .then(async (isTicket) =>
        isTicket
          ? syncTrackerOnEvent(
              { issueId: request.externalTicketId, type: 'workflow_started' },
              await resolveIssueTrackerConfig(),
              { runInputId: request.workRequestId, warn: logWarn }
            )
          : undefined
      )
      .catch(() => null);

    let testResult: TestRunResult = {
      duration_ms: 0,
      failing: 0,
      passed: false,
      passing: 0,
      stdout: '',
      total: 0,
    };

    const systemPrompt = await resolveSystemPrompt(
      'implementer',
      IMPLEMENTER_SYSTEM_PROMPT,
      systemPromptOverride
    );

    const llmSystemPrompt =
      turns.systemPrompt(systemPrompt) +
      lessonsContext +
      designContext +
      ticketContext +
      formatCriteriaContext(successCriteria) +
      crossRepoContext;

    // TDD loop — bound by the DB-backed workflow default (falls back to 5).
    const maxTddIterations = workflowDefaults.maxTddIterations;
    // Set when the test command cannot run here: a later iteration cannot fix that.
    let unrunnable: { command: string; cause: string } | undefined;
    // Set when a stack-derived test command showed no tests: nothing a later pass would verify.
    let noTestsFound: { kind: NoTestsKind; run: number } | undefined;
    const recordNoTestsFound = (
      iteration: number,
      cause: { kind: NoTestsKind; reason: string },
      output: string
    ) => {
      noTestsFound = { kind: cause.kind, run: iteration + 1 };
      tracer.addActivityEvent({
        inputJson: { iteration },
        name: noTestsFoundEvent(cause.kind),
        outputJson: {
          command: testCommand,
          output: output.trim().slice(-1000),
          reason: cause.reason,
        },
      });
    };
    for (let iteration = 0; iteration < maxTddIterations; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${maxTddIterations}`);
      // A cancelled run stops here rather than spending another iteration.
      throwIfActivityCancelled();

      const llmUserMessage = JSON.stringify({
        description: subtask?.description ?? request.description,
        externalTicketId: request.externalTicketId,
        iteration,
        previousTestResult: iteration > 0 ? testResult : undefined,
        ...(subtask
          ? {
              fileScope: subtask.files,
              subtaskId: subtask.id,
              subtaskTitle: subtask.title,
            }
          : {}),
      });
      await assertBudgetAvailable(`implementer.iteration_${iteration}`);
      await runImplementerTurn({
        agent: turnAgent,
        boundModelSpec,
        context: { iteration },
        role: 'implementer',
        runtime,
        system: llmSystemPrompt,
        tracer,
        usageEvent: `llm.implementer.iteration_${iteration}`,
        user: llmUserMessage,
      });

      // Run tests
      const testStart = Date.now();
      try {
        const testOutput = await workspace.exec(testRunCommand(testCommand), {
          timeoutMs: testRunTimeoutMs(testCommand),
        });
        // exec resolves only on exit 0.
        testResult = parseTestOutput(testOutput, Date.now() - testStart, 0);
        tracer.addActivityEvent({
          durationMs: Date.now() - testStart,
          inputJson: { iteration },
          name: 'tdd.test_run',
          outputJson: {
            failing: testResult.failing,
            passed: testResult.passed,
            passing: testResult.passing,
            total: testResult.total,
          },
        });
        if (testResult.passed) {
          break;
        }
        const noTests = noTestsFoundCause(testSource, { result: testResult });
        if (noTests) {
          recordNoTestsFound(iteration, noTests, testOutput);
          break;
        }
      } catch (err: unknown) {
        const noTests = noTestsFoundCause(testSource, { error: err });
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
        tracer.addActivityEvent({
          error: getExecErrorStdout(err).slice(0, 1000),
          inputJson: { iteration },
          name: 'tdd.test_run',
          outputJson: { passed: false },
        });
        if (noTests) {
          recordNoTestsFound(iteration, noTests, getExecErrorStdout(err));
          break;
        }
        const cause = unrunnableTestCause(err);
        if (cause) {
          const output = getExecErrorStdout(err).trim();
          unrunnable = { cause, command: testCommand };
          tracer.addActivityEvent({
            inputJson: { iteration },
            name: 'tdd.test_unrunnable',
            outputJson: {
              command: testCommand,
              output: output.slice(-1000),
              reason: cause,
            },
          });
          break;
        }
      }
    }

    // Commit and push
    const commitSummary = subtask
      ? `auto: ${subtask.id} — ${subtask.title} (${request.externalTicketId})`
      : `auto: implement ${request.externalTicketId}`;
    await workspace.exec('git add -A');
    // Skip the commit when there is nothing staged: on a retry that resumed from
    // the pushed branch the agent may have had nothing left to change, and an
    // empty `git commit` exits non-zero. A guarded step also checks the committed
    // range here, before the push.
    const pushSha = await commitStaged(workspace, commitSummary, pathGuard);
    // Never push on behalf of a run that has already been cancelled.
    throwIfActivityCancelled();
    await workspace.gitAuthed(`push origin ${pushRefspec(branch, pushSha)}`);

    // Collect results
    // `baseBranch` is an operator-editable column or a launch input — `diffForResult`
    // quotes it like every other interpolated ref so it cannot smuggle shell syntax
    // into the container.
    const diff = await diffForResult(workspace, baseBranch, pathGuard, pushSha);
    // A guarded step reports the commit it pushed, not whatever HEAD has become.
    const headSha = pushSha ?? (await workspace.exec('git rev-parse HEAD')).trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, commitMessage: commitSummary, headSha },
    });

    // Static code security scan (advisory findings passed to the review network,
    // degrading if the scanner cannot run), then the security gate before
    // returning the code result. A gate that cannot complete fails non-retryable:
    // a retry would re-run the whole paid session after the push.
    heartbeat('running security scan');
    const codeSecurityFindings = await runPostDiffSecurityGate(diff, tracer, {
      scanDiffForCodeIssues,
      scanDiffForSecurityIssues,
    });

    return {
      baseBranch,
      baseSha,
      branch,
      codeSecurityFindings: codeSecurityFindings.length > 0 ? codeSecurityFindings : undefined,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: noTestsFound
        ? noTestsFoundNotes(testCommand, noTestsFound.kind, noTestsFound.run)
        : unrunnable
          ? `The test command \`${unrunnable.command}\` could not run in the workspace (${unrunnable.cause}), so the TDD loop stopped after the first test run.`
          : `Completed in ${testResult.passed ? `≤${maxTddIterations}` : `${maxTddIterations} (max)`} TDD iterations. Tests ${testStatusWord(testResult)}.`,
      repoId: requireRepoId(request, 'executeImplementation'),
      testResults: testResult,
    };
  } finally {
    // A runtime that fails to close must not leak the container or drop the trace.
    try {
      await turns?.close();
    } catch (err) {
      logWarn('implementer runtime failed to close', { error: getErrorMessage(err) });
    }
    stopTraceFlushing();
    await persistActivityTrace(tracer, 'implementer');
    if (baseSha) {
      // Best-effort — the baseline SHA is an optional historical-replay aid. One
      // try/catch guards both the synchronous currentWorkflowId() read and the
      // async update.
      try {
        await prisma.workflowRun.update({
          data: { baselineSha: baseSha },
          where: { workflowId: currentWorkflowId() },
        });
      } catch {
        // non-fatal
      }
    }
    await workspace.destroy();
  }
}
