import { prisma } from '@auto-swe/shared/db';
import type {
  CodeResult,
  CodeSecurityFinding,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import {
  buildImplementerTurnRunner,
  type ImplementerTurnRunner,
} from '../agents/implementerRuntimeSelect.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { recallLessonsBlock } from '../lib/lessonRecall.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import { commitStaged, diffForResult, pushRefspec, startPathGuard } from './allowedPaths.js';
import {
  detectTestCommand,
  parseDiffToFileChanges,
  parseTestOutput,
  TEST_RUN_TIMEOUT_MS,
  testRunCommand,
} from './utils.js';
import {
  createWorkspace,
  fetchBranchesSubcommand,
  shellQuote,
  type Workspace,
} from './workspace.js';

export type FixMode = 'CI_FIX' | 'REVIEW_FIX' | 'GATE_FIX';

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

export interface FixSessionInput {
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
  /** When set, the change may touch only these paths; anything else fails before the push. */
  allowedPaths?: string[];
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
   * A trace event recorded when the session starts, before anything can fail,
   * so it is persisted with the session's trace whatever happens next. The CI
   * fixer records the failure it was handed here (`lib/attemptTrace.ts`).
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
export async function runImplementerFixSession(input: FixSessionInput): Promise<CodeResult> {
  const { mode, previousCodeResult } = input;
  // First, before a clone or a container exists (see executeImplementation).
  await assertRolePricedForUsdCap(input.agentKey);
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
    try {
      await workspace.gitAuthed(fetchBranchesSubcommand([previousCodeResult.branch]));
      await workspace.exec(`git reset --hard origin/${shellQuote(previousCodeResult.branch)}`);
    } catch {
      // Branch may not exist remotely yet; proceed against the local clone.
      heartbeat(`${mode}: remote branch not found, using clone HEAD`);
    }

    // After the sync to the work branch, before any agent turn: this session's change is
    // checked against the branch tip it started from, so an older branch base never matters.
    // The whole change is reported against the original run's base when the previous result
    // carries it.
    const pathGuard = await startPathGuard(
      workspace,
      repo.defaultBranch,
      input.allowedPaths,
      previousCodeResult.baseSha
    );

    const packageJson = await workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson, repo.gateCommands);

    // The session runs as its own persona (ciFixer / reviewFixer / gateFixer):
    // that Agent row's prompt, tools, skills and MCP binding, with the model
    // inherited from the implementer unless the persona overrides it.
    const activityCtx = await currentRequestContext();
    turns = await buildImplementerTurnRunner({
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
    const fullSystemPrompt = turns.systemPrompt(systemPrompt) + lessonsContext;
    const userMessage = JSON.stringify({
      mode,
      previousDiff: previousCodeResult.diff.slice(-20_000),
      ...input.userPayload,
    });

    await assertBudgetAvailable(input.usageEventName);
    await runImplementerTurn({
      context: { mode },
      role: input.agentKey,
      runtime: turns.runtime,
      system: fullSystemPrompt,
      tracer,
      usageEvent: input.usageEventName,
      user: userMessage,
    });

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
    const testStart = Date.now();
    try {
      const testOutput = await workspace.exec(testRunCommand(testCommand), {
        timeoutMs: TEST_RUN_TIMEOUT_MS,
      });
      // exec resolves only on exit 0.
      testResult = parseTestOutput(testOutput, Date.now() - testStart, 0);
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
    const pushSha = await commitStaged(workspace, input.commitMessage, pathGuard);
    // Never push on behalf of a run that has already been cancelled.
    throwIfActivityCancelled();
    await workspace.gitAuthed(`push origin ${pushRefspec(previousCodeResult.branch, pushSha)}`);

    // `defaultBranch` is an operator-editable column — quote it like every other
    // interpolated ref so it cannot smuggle shell syntax into the container.
    const diff = await diffForResult(workspace, repo.defaultBranch, pathGuard, pushSha);
    // A guarded step reports the commit it pushed, not whatever HEAD has become.
    const headSha = pushSha ?? (await workspace.exec('git rev-parse HEAD')).trim();

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
      // Carried forward for a guarded step only, so the next session can report the whole
      // change against the same base; an unguarded step returns exactly what it always did.
      ...(pathGuard && previousCodeResult.baseSha ? { baseSha: previousCodeResult.baseSha } : {}),
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
    await turns?.close();
    const done = persistActivityTrace(tracer, input.agentKey);
    await workspace.destroy();
    await done;
  }
}
