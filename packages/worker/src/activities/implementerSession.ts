import { prisma } from '@auto-swe/shared/db';
import type {
  CodeResult,
  CodeSecurityFinding,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { buildImplementerForActivity } from '../agents/implementer.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable, recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { recordSuspiciousLlmOutput } from '../lib/llmOutputScan.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import {
  detectTestCommand,
  parseDiffToFileChanges,
  parseTestOutput,
  TEST_RUN_TIMEOUT_MS,
} from './utils.js';
import { createWorkspace, shellQuote, type Workspace } from './workspace.js';

export type FixMode = 'CI_FIX' | 'REVIEW_FIX' | 'GATE_FIX';

/**
 * Connection (git_repo) row shape (the shared index doesn't export Prisma model
 * types). The installation relation is part of the shape because `toRepoRef`
 * requires it — a fix session that resolved its repo without one would clone
 * through the default installation, which for a repo in another GitHub
 * organization 404s as if the repository did not exist.
 */
type Connection = Awaited<ReturnType<typeof prisma.connection.findUniqueOrThrow>> & {
  installation: { installationId: string } | null;
};

export interface FixSessionInput {
  mode: FixMode;
  previousCodeResult: CodeResult;
  /** Mode-specific fields merged into the user message JSON alongside `mode` and `previousDiff`. */
  userPayload: Record<string, unknown>;
  /** Agent key to resolve the system prompt from (e.g. 'ciFixer', 'reviewFixer', 'gateFixer'). */
  agentKey: string;
  /** Built-in system prompt for this mode (resolveSystemPrompt handles DB/step overrides). */
  defaultSystemPrompt: string;
  systemPromptOverride?: string;
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
      include: { installation: { select: { installationId: true } } },
      where: { id: previousCodeResult.repoId },
    });
  }
  const workflow = await prisma.activeWorkflow.findFirst({
    include: {
      repository: { include: { installation: { select: { installationId: true } } } },
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
export async function runImplementerFixSession(input: FixSessionInput): Promise<CodeResult> {
  const { mode, previousCodeResult } = input;
  const repo = await resolveSessionRepo(previousCodeResult);

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  const workspace = await createWorkspace(
    authedCloneUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    repo.executorImage ?? undefined
  );

  const tracer = new AgentTracer();
  // P2/WS3: present when the implementer Agent enabled MCP — closed in finally.
  let closeMcp: (() => Promise<void>) | undefined;

  try {
    heartbeat(`${mode} workspace provisioned`);

    // createWorkspace clones the default branch and creates a fresh local
    // branch — it does NOT contain the implementer's pushed commits. Sync to
    // the remote branch HEAD so the agent fixes the actual tree and the final
    // push fast-forwards. (Previously only the gate-fix path did this; the
    // CI/review fix paths operated on a stale tree.)
    try {
      await workspace.gitAuthed(`fetch origin ${shellQuote(previousCodeResult.branch)}`);
      await workspace.exec(`git reset --hard origin/${shellQuote(previousCodeResult.branch)}`);
    } catch {
      // Branch may not exist remotely yet; proceed against the local clone.
      heartbeat(`${mode}: remote branch not found, using clone HEAD`);
    }

    const packageJson = await workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const activityCtx = await currentRequestContext();
    const {
      agent,
      promptSuffix,
      closeMcp: cm,
    } = await buildImplementerForActivity(workspace, tracer, activityCtx);
    closeMcp = cm;

    const systemPrompt = await resolveSystemPrompt(
      'implementer',
      input.defaultSystemPrompt,
      input.systemPromptOverride
    );
    const fullSystemPrompt = systemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : '');
    const userMessage = JSON.stringify({
      mode,
      previousDiff: previousCodeResult.diff.slice(-20_000),
      ...input.userPayload,
    });

    const agentStart = Date.now();
    await assertBudgetAvailable(input.usageEventName);
    const genResult = await agent.generate(
      [
        { content: fullSystemPrompt, role: 'system' },
        { content: userMessage, role: 'user' },
      ],
      { toolChoice: 'auto' }
    );

    heartbeat(`${mode} agent completed`);

    let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
    if (genResult.usage) {
      attribution = await recordLlmUsage(
        currentWorkflowId(),
        'implementer',
        genResult.usage,
        input.usageEventName
      );
    }

    // LLM output scanner — advisory, non-blocking (the helper never throws).
    await recordSuspiciousLlmOutput(tracer, genResult.text ?? '', { inputJson: { mode } });

    // Always record the LLM call, even when the model only makes tool calls
    // and produces no text output.
    tracer.addLlmResponse({
      costUsd: attribution.costUsd,
      durationMs: Date.now() - agentStart,
      inputJson: { systemPrompt: fullSystemPrompt, userMessage },
      inputTokens: attribution.inputTokens,
      model: attribution.modelSpec || undefined,
      outputJson: genResult.text
        ? { text: genResult.text }
        : { toolCallCount: genResult.steps?.length ?? 0 },
      outputTokens: attribution.outputTokens,
      role: 'implementer',
    });

    let extraNote: string | null = null;
    if (input.afterGenerate) {
      try {
        extraNote = await input.afterGenerate(workspace, repo);
      } catch {
        // Informational hook; failure does not abort the fix.
      }
    }

    let testResult: TestRunResult;
    const testStart = Date.now();
    try {
      const testOutput = await workspace.exec(testCommand, { timeoutMs: TEST_RUN_TIMEOUT_MS });
      testResult = parseTestOutput(testOutput, Date.now() - testStart);
    } catch (err: unknown) {
      testResult = {
        duration_ms: 0,
        failing: 1,
        passed: false,
        passing: 0,
        stdout: getExecErrorStdout(err),
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

    // Commit and push the fix (skip the commit if the agent made no changes
    // to avoid empty CI cycles; push is still safe — it's a no-op then).
    await workspace.exec('git add -A');
    await workspace.exec(
      `git diff --cached --quiet || git commit -m ${shellQuote(input.commitMessage)}`
    );
    await workspace.gitAuthed(`push origin ${shellQuote(previousCodeResult.branch)}`);

    // `defaultBranch` is an operator-editable column — quote it like every other
    // interpolated ref so it cannot smuggle shell syntax into the container.
    const diff = await workspace.exec(`git diff origin/${shellQuote(repo.defaultBranch)}`);
    const headSha = (await workspace.exec('git rev-parse HEAD')).trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch: previousCodeResult.branch, headSha },
    });

    // Static code security scan — advisory findings passed to the review
    // network, same as the initial implementation path; a scanner that cannot
    // run degrades to no findings rather than aborting a pushed fix.
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

    // Security gate — critical findings block the result. The fix paths used
    // to skip this entirely, letting unscanned commits reach the PR.
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
      branch: previousCodeResult.branch,
      codeSecurityFindings: codeSecurityFindings.length > 0 ? codeSecurityFindings : undefined,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: input.notes(testResult, extraNote),
      repoId: repo.id,
      testResults: testResult,
    };
  } finally {
    await closeMcp?.();
    const done = persistActivityTrace(tracer, 'implementer');
    await workspace.destroy();
    await done;
  }
}
