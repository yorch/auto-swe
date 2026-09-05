import { prisma } from '@auto-swe/shared/db';
import type { FigmaDesignSummary } from '@auto-swe/shared/lib/integrations/figmaDesign';
import {
  resolveIssueTrackerConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type {
  CodeResult,
  CodeSecurityFinding,
  RepoWorkRequest,
  Subtask,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { buildImplementerForActivity } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { currentAttempt, currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable, recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { retrieveSimilarLessons } from '../lib/lessonRetrieval.js';
import { recordSuspiciousLlmOutput } from '../lib/llmOutputScan.js';
import { resolveSystemPrompt } from '../lib/models.js';
import {
  type CrossRepoStepOptions,
  checkoutUpstreamRepos,
  loadRepoDependencyContext,
  wantsCrossRepoCheckout,
  wantsCrossRepoContext,
} from '../lib/repoDependencyContext.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import {
  detectTestCommand,
  parseDiffToFileChanges,
  parseTestOutput,
  TEST_RUN_TIMEOUT_MS,
} from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

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
  crossRepoOptions?: CrossRepoStepOptions
): Promise<CodeResult> {
  const repo = await prisma.connection.findUniqueOrThrow({
    where: { id: requireRepoId(request, 'executeImplementation') },
  });

  const workflowDefaults = await resolveWorkflowDefaults();
  const featureBranch = `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;
  const branch = subtask ? `${featureBranch}/${subtask.id}` : featureBranch;

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    repo.defaultBranch,
    repo.executorImage ?? 'node:24-alpine'
  );

  const tracer = new AgentTracer();
  // P2/WS3: present when the implementer Agent enabled MCP — closed in finally.
  let closeMcp: (() => Promise<void>) | undefined;

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
        await workspace.gitAuthed(`fetch origin ${shellQuote(branch)}`);
        await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
      } catch {
        // Nothing pushed yet — the previous attempt failed before its push.
        heartbeat('retry: remote branch not found, starting from clone HEAD');
      }
    }

    // Detect test framework
    const packageJson = await workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Load tool config + skills (WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade),
    // resolve any MCP server, and build the agent — bound to the workspace so
    // the tracer captures every call. promptSuffix carries prompt-fragment
    // skills to append to the system prompt.
    const activityCtx = await currentRequestContext();
    const {
      agent,
      promptSuffix,
      closeMcp: cm,
      skills,
    } = await buildImplementerForActivity(workspace, tracer, activityCtx);
    closeMcp = cm;

    tracer.addActivityEvent({
      name: 'skills.loaded',
      outputJson: { count: skills.length, skills: skills.map((s) => s.name) },
    });

    // Retrieve relevant lessons from past workflows for context enrichment
    let lessonsContext = '';
    try {
      const lessons = await retrieveSimilarLessons(
        request.description,
        requireRepoId(request, 'executeImplementation'),
        workflowDefaults.lessonRetrievalLimit,
        workflowDefaults.lessonRetrievalThreshold
      );
      if (lessons.length > 0) {
        lessonsContext =
          '\n\n## Lessons from Previous Workflows\n' +
          lessons.map((l) => `- [${l.failureType ?? 'GENERAL'}] ${l.summary}`).join('\n');
        tracer.addActivityEvent({
          name: 'lessons.retrieved',
          outputJson: {
            count: lessons.length,
            lessons: lessons.map((l) => ({ failureType: l.failureType, summary: l.summary })),
          },
        });
      }
    } catch {
      // Lesson retrieval failure should not block implementation
    }

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
    resolveIssueTrackerConfig()
      .then((trackerConfig) =>
        syncTrackerOnEvent(
          { issueId: request.externalTicketId, type: 'workflow_started' },
          trackerConfig
        )
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
      systemPrompt +
      (promptSuffix ? `\n\n${promptSuffix}` : '') +
      lessonsContext +
      designContext +
      crossRepoContext;

    // TDD loop — bound by the DB-backed workflow default (falls back to 5).
    const maxTddIterations = workflowDefaults.maxTddIterations;
    for (let iteration = 0; iteration < maxTddIterations; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${maxTddIterations}`);

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
      const genResult = await agent.generate(
        [
          { content: llmSystemPrompt, role: 'system' },
          { content: llmUserMessage, role: 'user' },
        ],
        { toolChoice: 'auto' }
      );

      let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
      if (genResult.usage) {
        attribution = await recordLlmUsage(
          currentWorkflowId(),
          'implementer',
          genResult.usage,
          `llm.implementer.iteration_${iteration}`
        );
      }

      // LLM output scanner — advisory, non-blocking (the helper never throws).
      await recordSuspiciousLlmOutput(tracer, genResult.text ?? '', { inputJson: { iteration } });

      // Always record the LLM call per TDD iteration, even when the model only
      // makes tool calls and produces no text output.
      tracer.addLlmResponse({
        costUsd: attribution.costUsd,
        durationMs: 0,
        inputJson: { iteration, systemPrompt: llmSystemPrompt, userMessage: llmUserMessage },
        inputTokens: attribution.inputTokens,
        model: attribution.modelSpec || undefined,
        outputJson: genResult.text
          ? { text: genResult.text }
          : { toolCallCount: genResult.steps?.length ?? 0 },
        outputTokens: attribution.outputTokens,
        role: 'implementer',
      });

      // Run tests
      const testStart = Date.now();
      try {
        const testOutput = await workspace.exec(testCommand, { timeoutMs: TEST_RUN_TIMEOUT_MS });
        testResult = parseTestOutput(testOutput, Date.now() - testStart);
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
      } catch (err: unknown) {
        testResult = {
          duration_ms: 0,
          failing: 1,
          passed: false,
          passing: 0,
          stdout: getExecErrorStdout(err),
          total: 0,
        };
        tracer.addActivityEvent({
          error: getExecErrorStdout(err).slice(0, 1000),
          inputJson: { iteration },
          name: 'tdd.test_run',
          outputJson: { passed: false },
        });
      }
    }

    // Commit and push
    const commitSummary = subtask
      ? `auto: ${subtask.id} — ${subtask.title} (${request.externalTicketId})`
      : `auto: implement ${request.externalTicketId}`;
    await workspace.exec('git add -A');
    // Skip the commit when there is nothing staged: on a retry that resumed from
    // the pushed branch the agent may have had nothing left to change, and an
    // empty `git commit` exits non-zero.
    await workspace.exec(`git diff --cached --quiet || git commit -m ${shellQuote(commitSummary)}`);
    await workspace.gitAuthed(`push origin ${shellQuote(branch)}`);

    // Collect results
    // `defaultBranch` is an operator-editable column — quote it like every other
    // interpolated ref so it cannot smuggle shell syntax into the container.
    const diff = await workspace.exec(`git diff origin/${shellQuote(repo.defaultBranch)}`);
    const headSha = (await workspace.exec('git rev-parse HEAD')).trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, commitMessage: commitSummary, headSha },
    });

    // Static code security scan — advisory findings passed to the review network.
    // Not blocking here; the security reviewer agent decides severity — and an
    // advisory scanner that cannot run must degrade, never abort a pushed run.
    let codeSecurityFindings: CodeSecurityFinding[] = [];
    try {
      codeSecurityFindings = await scanDiffForCodeIssues(diff);
    } catch (err) {
      tracer.addActivityEvent({
        error: err instanceof Error ? err.message : String(err),
        name: 'code_security.scan',
        outputJson: { degraded: true },
      });
    }
    if (codeSecurityFindings.length > 0) {
      tracer.addActivityEvent({
        name: 'code_security.scan',
        outputJson: { count: codeSecurityFindings.length, findings: codeSecurityFindings },
      });
    }

    // Security scan — gate before returning code result
    heartbeat('running security scan');
    const securityResult = await scanDiffForSecurityIssues(diff);
    if (!securityResult.passed) {
      const findingsSummary = securityResult.findings
        .map(
          (f) =>
            `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.category}: ${f.description}`
        )
        .join('\n');
      throw ApplicationFailure.nonRetryable(
        `Security scan failed with critical findings:\n${findingsSummary}`,
        'SECURITY_GATE_FAILURE',
        { findings: securityResult.findings }
      );
    }

    return {
      baseSha,
      branch,
      codeSecurityFindings: codeSecurityFindings.length > 0 ? codeSecurityFindings : undefined,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `Completed in ${testResult.passed ? `≤${maxTddIterations}` : `${maxTddIterations} (max)`} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      repoId: requireRepoId(request, 'executeImplementation'),
      testResults: testResult,
    };
  } finally {
    await closeMcp?.();
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
