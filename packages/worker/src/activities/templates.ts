import type { Prisma } from '@auto-swe/shared';
import type { SettingResolveCtx } from '@auto-swe/shared/config';
import { snapshotPinnedSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { currentYearMonth } from '@auto-swe/shared/lib/billing';
import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { migrateSpec, parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { Context } from '@temporalio/activity';
import {
  notifySlackRunComplete,
  notifySlackStepFailure,
  postSlackThreadMessage,
} from '../lib/slackNotify.js';
import { accrueChannelUsage } from './channelAssistant.js';

/**
 * Workflow run lifecycle activities. These live OUTSIDE the workflow file so
 * the interpreter (which runs in the V8 isolate) can call them through proxies.
 */

export interface CreateWorkflowRunInput {
  workflowId: string;
  templateId: string;
  templateVersion: number;
  workRequestId?: string;
  /// Evals P2 canary: when set, this agent key is pinned to candidateVersion
  /// for the life of the run, and the run is tagged isCanary=true.
  canaryAgentKey?: string;
  canaryVersion?: number;
}

/**
 * Creates the WorkflowRun row (used by RunnableWorkflow on first tick) and
 * returns its id + the spec snapshot. The spec is snapshotted on the row so
 * later edits to the template don't affect this run.
 */
export async function createWorkflowRun(
  input: CreateWorkflowRunInput
): Promise<
  | { runId: string; spec: WorkflowSpec; pinnedSettings?: Record<string, unknown> }
  | { error: string }
> {
  const version = await prisma.workflowTemplateVersion.findUnique({
    include: {
      template: { select: { estimatedHumanTimeSavedMinutes: true, workspaceProvider: true } },
    },
    where: { templateId_version: { templateId: input.templateId, version: input.templateVersion } },
  });
  if (!version) {
    return { error: `template ${input.templateId}@v${input.templateVersion} not found` };
  }

  let spec: WorkflowSpec;
  try {
    const migrated = migrateSpec(version.spec, SPEC_SCHEMA_VERSION);
    spec = parseWorkflowSpec(migrated);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // P1/WS3: snapshot the active GLOBAL Agent versions so this run resolves a
  // fixed Agent version regardless of later library edits. One row per key
  // today (version 1); kept as a { key: version } map for forward pins.
  const agents = await runUnscoped(
    'GLOBAL-scope rows are the deployment-wide defaults; they have no tenant by definition',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        select: { key: true, version: true },
        where: { isActive: true, scope: 'GLOBAL' },
      })
  );
  const agentVersions: Record<string, number> = {};
  for (const a of agents) {
    agentVersions[a.key] = Math.max(agentVersions[a.key] ?? 0, a.version);
  }

  // Evals P2 canary: override the candidate agent's pinned version so
  // resolveAgent routes this run to the candidate arm.
  const { canaryAgentKey, canaryVersion } = input;
  const isCanary = !!(canaryAgentKey && canaryVersion != null);
  if (canaryAgentKey && canaryVersion != null) {
    agentVersions[canaryAgentKey] = canaryVersion;
  }

  // Freeze the registry settings marked `runPinned` for the life of this run,
  // alongside the agent-version pin. The interpreter runs in the V8 isolate and
  // cannot read the database, and a run that started under one transition
  // ceiling must finish under the same one or its replay history stops matching
  // its code — so these are resolved once, here, and carried forward.
  const settingsCtx = await runSettingsContext(input);
  const pinnedSettings = await snapshotPinnedSettings(settingsCtx);

  // Upsert by workflowId — re-runs of a Temporal workflow execution with the
  // same workflowId should not create duplicate rows. `update: {}` preserves the
  // original spec, agentVersions and pinnedSettings snapshots across Temporal
  // retries.
  const run = await prisma.workflowRun.upsert({
    create: {
      agentVersions,
      estimatedHumanTimeSaved: version.template?.estimatedHumanTimeSavedMinutes ?? null,
      isCanary,
      outcomeDomain: version.template?.workspaceProvider ?? null,
      pinnedSettings: pinnedSettings as Prisma.InputJsonObject,
      specSnapshot: spec as unknown as object,
      status: 'RUNNING',
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      workflowId: input.workflowId,
      workRequestId: input.workRequestId,
    },
    update: {},
    where: { workflowId: input.workflowId },
  });

  // Read the pin back off the row rather than trusting the value just computed:
  // on a Temporal retry `update: {}` keeps the *original* snapshot, and the run
  // must keep using that one.
  let persisted =
    run.pinnedSettings && typeof run.pinnedSettings === 'object'
      ? (run.pinnedSettings as Record<string, unknown>)
      : null;

  if (!persisted) {
    // The row pre-dates this column. Returning the fresh snapshot without
    // storing it would leave the workflow reading pinned limits while
    // `currentRequestContext()` reported none to its activities — a run that is
    // neither pinned nor consistently live. Backfill so both sides agree.
    await prisma.workflowRun.update({
      data: { pinnedSettings: pinnedSettings as Prisma.InputJsonObject },
      where: { id: run.id },
    });
    persisted = pinnedSettings;
  }

  // Always return the spec actually stored on the row. On a Temporal retry the
  // row may already exist (update: {}), and returning the freshly-parsed spec
  // from `version.spec` would make the workflow see a different snapshot than
  // the history recorded.
  return {
    pinnedSettings: persisted,
    runId: run.id,
    spec: (run.specSnapshot as unknown as WorkflowSpec) ?? spec,
  };
}

/// Scope context for the run's pinned-settings snapshot. The template comes from
/// the input; team and org have to be derived, and they must land on the SAME
/// tenant `currentRequestContext()` resolves for this run's activities — a
/// snapshot pinned at GLOBAL while every other setting resolves at TEAM is worse
/// than no pin at all.
///
/// Two sources, because the launch paths disagree: `POST /work-requests` sets
/// `RunInput.connectionId`, while the Slack slash-command and scheduled-request
/// paths leave it null and carry the repo on `ActiveWorkflow.repoId` instead.
/// `currentRequestContext()` reads the latter, so this reads both.
async function runSettingsContext(input: CreateWorkflowRunInput): Promise<SettingResolveCtx> {
  const ctx: SettingResolveCtx = { workflowTemplateId: input.templateId };

  const [request, active] = await Promise.all([
    input.workRequestId
      ? prisma.runInput.findUnique({
          select: { connection: { select: { team: { select: { orgId: true } }, teamId: true } } },
          where: { id: input.workRequestId },
        })
      : null,
    prisma.activeWorkflow.findFirst({
      select: { repository: { select: { team: { select: { orgId: true } }, teamId: true } } },
      where: { temporalWorkflowId: input.workflowId },
    }),
  ]);

  const team = request?.connection ?? active?.repository;
  ctx.teamId = team?.teamId ?? undefined;
  ctx.orgId = team?.team?.orgId ?? undefined;
  return ctx;
}

export interface RecordStepInput {
  runId: string;
  nodeId: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
  attempt?: number;
}

export async function recordWorkflowStep(input: RecordStepInput): Promise<void> {
  const now = new Date();
  const attempt = input.attempt ?? 1;

  // Temporal can retry an activity within the same attempt number under some
  // failure modes; the unique constraint on (run_id, node_id, attempt) plus an
  // upsert makes step recording idempotent.
  await prisma.workflowStep.upsert({
    create: {
      attempt,
      endedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
      error: input.error,
      inputs: input.inputs as object | undefined,
      nodeId: input.nodeId,
      outputs: input.outputs as object | undefined,
      runId: input.runId,
      startedAt: now,
      status: input.status,
    },
    update: {
      endedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
      error: input.error,
      inputs: input.inputs as object | undefined,
      outputs: input.outputs as object | undefined,
      status: input.status,
    },
    where: { runId_nodeId_attempt: { attempt, nodeId: input.nodeId, runId: input.runId } },
  });

  // Phase-7: best-effort Slack notification on terminal FAILED records. The
  // interpreter records the FAILED row only after onFail retry budget is
  // exhausted (or for warn-mode it records and continues), so we won't spam
  // the channel on every mid-retry attempt. Guard on the Temporal activity
  // attempt as well, so a notification that succeeds but is followed by an
  // activity failure is not re-sent on retry.
  if (input.status === 'FAILED' && Context.current().info.attempt === 1) {
    await notifySlackStepFailure({
      attempt: input.attempt ?? 1,
      error: input.error,
      nodeId: input.nodeId,
      runId: input.runId,
    });
  }
}

export async function finalizeWorkflowRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  contextSnapshot?: unknown
): Promise<void> {
  // Phase-8 denormalize the run's cost + token totals onto workflow_runs at finalize
  // time. Read the workRequest → activeWorkflows join once, sum, then write back.
  const run = await prisma.workflowRun.findUnique({
    select: {
      endedAt: true,
      workflowId: true,
      workRequest: {
        select: {
          activeWorkflows: {
            select: { costUsdAccrued: true, tokensInputUsed: true, tokensOutputUsed: true },
          },
          connection: {
            select: { team: { select: { orgId: true } } },
          },
          externalTicketId: true,
          // Channel assistant (Phase A): a channel-launched task run carries its
          // origin in `payload.channelId` + the Slack thread coordinates. Used
          // below to accrue cost to ChannelMonthlyUsage + report the result back.
          payload: true,
          slackChannelId: true,
          slackMessageTs: true,
        },
      },
    },
    where: { id: runId },
  });
  const workflows = run?.workRequest?.activeWorkflows ?? [];
  let costUsdAccrued = workflows.reduce((sum, aw) => sum + aw.costUsdAccrued, 0);
  let tokensInputTotal = workflows.reduce((sum, aw) => sum + (aw.tokensInputUsed ?? 0n), 0n);
  let tokensOutputTotal = workflows.reduce((sum, aw) => sum + (aw.tokensOutputUsed ?? 0n), 0n);

  // Phase-5 metadata: outcome type, human step presence, and autonomy.
  const [outcomeRefs, humanStepCount, autonomyDecisions, errorEvals] = await Promise.all([
    prisma.workflowOutcomeReference.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { result: true },
      where: { runId },
    }),
    prisma.workflowHumanStep.count({ where: { runId } }),
    prisma.autonomyDecision.findMany({
      select: { event: true, payload: true },
      where: { runId },
    }),
    prisma.evalResult.findMany({
      select: { source: true },
      where: { passed: false, runId },
    }),
  ]);

  const firstConnectionType =
    outcomeRefs &&
    typeof outcomeRefs.result === 'object' &&
    outcomeRefs.result !== null &&
    'connectionType' in outcomeRefs.result
      ? String((outcomeRefs.result as { connectionType?: unknown }).connectionType)
      : undefined;
  const hadHumanStep = humanStepCount > 0;
  const wasAutonomous =
    !hadHumanStep &&
    autonomyDecisions.length > 0 &&
    autonomyDecisions.every((d) => {
      if (d.event !== 'publish') {
        return true;
      }
      const decision =
        typeof d.payload === 'object' && d.payload !== null && 'decision' in d.payload
          ? String((d.payload as { decision?: unknown }).decision)
          : undefined;
      return decision === 'auto';
    });

  const ERROR_EVAL_SOURCES = new Set(['GATE', 'ASSERT', 'PII', 'POLICY', 'REVIEW', 'HUMAN_AUDIT']);
  const hasError = errorEvals.some((e) => ERROR_EVAL_SOURCES.has(e.source));

  // Repo-less runs (e.g. a general Channel Task) have no ActiveWorkflow ledger
  // row, so `recordLlmUsage` never accrued run-level cost/tokens there — the only
  // record of the spend is the run's AgentTrace rows. Sum those so `/runs` shows
  // the real cost instead of $0/0 tokens. (SWE runs always have an ActiveWorkflow,
  // so this branch is skipped for them.) The summed cost is reused below for the
  // channel-budget ledger so `finalizeChannelTaskRun` doesn't re-aggregate.
  let channelTraceCostUsd: number | undefined;
  if (workflows.length === 0) {
    const traceTotals = await prisma.agentTrace.aggregate({
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      where: { runId },
    });
    costUsdAccrued = traceTotals._sum.costUsd ?? 0;
    tokensInputTotal = BigInt(traceTotals._sum.inputTokens ?? 0);
    tokensOutputTotal = BigInt(traceTotals._sum.outputTokens ?? 0);
    channelTraceCostUsd = costUsdAccrued;
  }

  // P5: aggregate cost into OrgMonthlyUsage with Prisma's increment operator
  // (race-safe across concurrent finalizations). finalizeWorkflowRun is a Temporal
  // activity that can be retried, so we gate the write on the atomic
  // `updateMany` count instead of a stale pre-read. The denormalize update + org
  // upsert run in one transaction when an org is present. That makes the pair
  // atomic: a retry after commit sees endedAt set and count === 0; a retry after
  // rollback re-reads endedAt null and re-does both. runsCompleted counts only
  // SUCCESS; cost/tokens accrue for every terminal status (real spend).
  if (run?.endedAt != null) {
    return;
  }

  const orgId = run?.workRequest?.connection?.team?.orgId;
  const runsIncrement = status === 'SUCCESS' ? 1 : 0;

  // Write the terminal status back to the ActiveWorkflow row. Templates only
  // advance currentStatus through happy-path states, so without this a
  // failed/timed-out/cancelled run leaves its row "active" forever and the
  // dashboard KPIs drift. SUCCESS maps to COMPLETED (a no-op on specs that
  // already set it); SKIPPED has no ActiveWorkflow equivalent and is left as-is.
  const terminalStatus = status === 'SUCCESS' ? 'COMPLETED' : status === 'SKIPPED' ? null : status;

  const terminalUpdate = {
    contextSnapshot: contextSnapshot as object | undefined,
    costUsdAccrued,
    endedAt: new Date(),
    hadHumanStep,
    hasError,
    outcomeType: firstConnectionType ?? null,
    status,
    tokensInputTotal,
    tokensOutputTotal,
    wasAutonomous,
  };

  let didFinalize = false;
  if (orgId) {
    const yearMonth = currentYearMonth();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))
      `;
      const { count } = await tx.workflowRun.updateMany({
        data: terminalUpdate,
        where: { endedAt: null, id: runId },
      });
      if (count === 0) {
        return; // already finalized by a concurrent attempt
      }
      didFinalize = true;
      if (terminalStatus && run?.workflowId) {
        await tx.activeWorkflow.updateMany({
          data: { currentStatus: terminalStatus },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
      await tx.orgMonthlyUsage.upsert({
        create: {
          costUsdAccrued,
          orgId,
          runsCompleted: runsIncrement,
          tokensInput: tokensInputTotal,
          tokensOutput: tokensOutputTotal,
          yearMonth,
        },
        update: {
          costUsdAccrued: { increment: costUsdAccrued },
          runsCompleted: { increment: runsIncrement },
          tokensInput: { increment: tokensInputTotal },
          tokensOutput: { increment: tokensOutputTotal },
        },
        where: { orgId_yearMonth: { orgId, yearMonth } },
      });
    });
  } else {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.workflowRun.updateMany({
        data: terminalUpdate,
        where: { endedAt: null, id: runId },
      });
      if (count === 0) {
        return; // already finalized by a concurrent attempt
      }
      didFinalize = true;
      if (terminalStatus && run?.workflowId) {
        await tx.activeWorkflow.updateMany({
          data: { currentStatus: terminalStatus },
          where: { temporalWorkflowId: run.workflowId },
        });
      }
    });
  }

  if (!didFinalize) {
    return;
  }

  // The side effects below (Slack notifications + channel task finalization +
  // tracker sync) are non-idempotent. Only fire them when we actually finalized
  // the run above.
  // Channel-task runs own their terminal in-thread report (finalizeChannelTaskRun
  // below — opt-in-independent, exactly one message). Skip the generic
  // run-complete notification for them: the CODE route resolves a real
  // team-via-connection, so notifySlackRunComplete would otherwise post a SECOND,
  // redundant completion message into the SAME thread (double-post). For ordinary
  // SWE runs this still fires (gated on the team's `slackNotifySuccess` opt-in).
  const channelTaskPayload = readChannelTaskPayload(run?.workRequest?.payload);
  if (!channelTaskPayload) {
    await notifySlackRunComplete({ runId, status });
  }

  // Channel assistant (Phase A): for a channel-launched task run, (a) accrue its
  // cost to the channel's monthly budget (from the run's AgentTrace rows; for the
  // code route that is a SEPARATE ledger from the OrgMonthlyUsage the connection
  // path already billed — different tables, not a double-count) and (b) report
  // the result back into the originating thread REGARDLESS of the team success
  // opt-in (these runs are user-requested in-thread). Both best-effort. We pass the
  // already-summed trace cost (general route) + the in-hand contextSnapshot so it
  // re-reads neither.
  await finalizeChannelTaskRun(runId, status, run?.workRequest, channelTaskPayload, {
    contextSnapshot,
    traceCostUsd: channelTraceCostUsd,
  });

  // Best-effort tracker sync on workflow terminal status.
  const externalTicketId = run?.workRequest?.externalTicketId;
  if (externalTicketId && (status === 'SUCCESS' || status === 'FAILED' || status === 'TIMED_OUT')) {
    const trackerConfig = await resolveIssueTrackerConfig();
    await syncTrackerOnEvent(
      status === 'SUCCESS'
        ? { issueId: externalTicketId, type: 'workflow_completed' }
        : {
            issueId: externalTicketId,
            summary: `Workflow ended with status: ${status}`,
            type: 'workflow_failed',
          },
      trackerConfig
    ).catch(() => null);
  }
}

/** Shape of the `payload` we stamp onto a channel-task RunInput. */
interface ChannelTaskPayload {
  kind?: string;
  channelId?: string;
  title?: string;
}

/**
 * Narrow a RunInput `payload` to a channel-task payload — returns it only when
 * `kind === 'channel-task'` and a `channelId` is present, else `null`. Shared by
 * `finalizeWorkflowRun` (to suppress the duplicate run-complete notification) and
 * `finalizeChannelTaskRun` so the channel-task discriminant is parsed once.
 */
function readChannelTaskPayload(payload: unknown): ChannelTaskPayload | null {
  const p = (payload ?? null) as ChannelTaskPayload | null;
  if (p?.kind !== 'channel-task' || !p.channelId) {
    return null;
  }
  return p;
}

/** Max chars of the agent's result text posted back to the thread. */
const CHANNEL_TASK_RESULT_MAX = 3500;

/**
 * Channel assistant (Phase A): finalize the channel-specific side effects of a
 * channel-launched task run. No-ops for any non-channel run (the common SWE
 * path). Both steps are best-effort + wrapped so they never fail the finalize.
 *
 *  1. Accrue the run's total cost to `ChannelMonthlyUsage` (the per-channel
 *     budget ledger). The cost lives in the run's AgentTrace rows — channel
 *     tasks have no ActiveWorkflow, so `recordLlmUsage` never wrote a run-level
 *     ledger row, and there's no connection→org link, so OrgMonthlyUsage was not
 *     touched either (no double-count).
 *  2. Post the run's result back into the originating Slack thread regardless of
 *     `Team.slackNotifySuccess` — these runs are explicitly user-requested
 *     in-thread, so they always report.
 */
async function finalizeChannelTaskRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  workRequest:
    | {
        slackChannelId: string | null;
        slackMessageTs: string | null;
      }
    | null
    | undefined,
  payload: ChannelTaskPayload | null,
  ctx: { contextSnapshot: unknown; traceCostUsd: number | undefined }
): Promise<void> {
  // `payload` is the already-narrowed channel-task discriminant from
  // `finalizeWorkflowRun` (`readChannelTaskPayload`). Null → not a channel task.
  if (!payload?.channelId) {
    return;
  }
  const channelId = payload.channelId;

  // 1. Accrue cost to the channel ledger. `finalizeWorkflowRun` already summed the
  //    run's AgentTrace cost for the repo-less general route (passed as
  //    `traceCostUsd`); reuse it rather than re-aggregating. The code route bills
  //    OrgMonthlyUsage via its connection path, so here we sum its AgentTrace cost
  //    once for the SEPARATE channel ledger (a different table, not a double-count).
  try {
    const costUsd =
      ctx.traceCostUsd ??
      (await prisma.agentTrace.aggregate({ _sum: { costUsd: true }, where: { runId } }))._sum
        .costUsd ??
      0;
    await accrueChannelUsage(channelId, costUsd);
  } catch (err) {
    console.error(
      `[finalizeChannelTaskRun] failed to accrue channel usage for ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }

  // 2. Report the result back into the originating thread (opt-in-independent).
  const slackChannelId = workRequest?.slackChannelId;
  const threadTs = workRequest?.slackMessageTs;
  if (!slackChannelId || !threadTs) {
    return;
  }
  try {
    const text = buildChannelTaskResultText(ctx.contextSnapshot, status, payload.title);
    await postSlackThreadMessage(slackChannelId, threadTs, text);
  } catch (err) {
    // Best-effort: a Slack failure must not fail the finalize.
    console.error(
      `[finalizeChannelTaskRun] failed to post result for channel ${channelId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Build the in-thread result message for a finished channel task. On SUCCESS we
 * surface the general-route agent's text result from the in-hand `contextSnapshot`.
 * The Channel Task spec has two answer-producing shapes: the decompose path ends at
 * the `composite` step node (`runChannelSubtasks`), the single-agent path at `task` —
 * read `composite` first, falling back to `task`. When neither is present — the code
 * route (a SWE run with different node ids) or an empty answer — we post a plain
 * completion line. The code route's PR link is already threaded into the conversation
 * by `notifySlackPrReady` at PR-open time, so we don't re-surface it here. Non-success
 * statuses get a short failure note. Truncated to {@link CHANNEL_TASK_RESULT_MAX} chars.
 */
function buildChannelTaskResultText(
  contextSnapshot: unknown,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  title: string | undefined
): string {
  const titleLine = title ? ` *${title}*` : '';
  if (status !== 'SUCCESS') {
    return `:rotating_light: Task${titleLine} finished with status *${status}*.`;
  }

  const snapshot = (contextSnapshot ?? null) as {
    nodes?: {
      composite?: { output?: { text?: unknown } };
      task?: { output?: { text?: unknown } };
    };
  } | null;
  const out = snapshot?.nodes?.composite?.output?.text ?? snapshot?.nodes?.task?.output?.text;
  const resultText = typeof out === 'string' ? out.trim() : '';

  if (!resultText) {
    return `:white_check_mark: Task${titleLine} is done.`;
  }
  const body =
    resultText.length > CHANNEL_TASK_RESULT_MAX
      ? `${resultText.slice(0, CHANNEL_TASK_RESULT_MAX)}…`
      : resultText;
  return `:white_check_mark: Task${titleLine} is done:\n\n${body}`;
}

/**
 * Resolve which workflow template a repo's work should run against. Prefers
 * the repo's team default; falls back to the global (teamId IS NULL) default.
 * Used by the epic orchestrator to start child workflows per repo. Throws if
 * no template is configured — workflows can't run without one.
 */
export async function resolveTemplateForRepo(
  repoId: string
): Promise<{ templateId: string; templateVersion: number }> {
  const repo = await prisma.connection.findUniqueOrThrow({
    select: { teamId: true },
    where: { id: repoId },
  });

  const teamTpl = await prisma.workflowTemplate.findFirst({
    orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
    where: { isDefault: true, status: 'ACTIVE', teamId: repo.teamId },
  });
  const tpl =
    teamTpl ??
    (await prisma.workflowTemplate.findFirst({
      orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
      where: { isDefault: true, status: 'ACTIVE', teamId: null },
    }));

  if (!tpl?.activeVersion) {
    throw new Error(
      `no active default workflow template for repo ${repoId} (team ${repo.teamId}). Run \`yarn db:seed\`.`
    );
  }
  return { templateId: tpl.id, templateVersion: tpl.activeVersion };
}
