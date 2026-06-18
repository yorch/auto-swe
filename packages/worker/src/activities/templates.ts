import { prisma } from '@auto-swe/shared/db';
import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { migrateSpec, parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { notifySlackRunComplete, notifySlackStepFailure } from '../lib/slackNotify.js';

/**
 * Workflow run lifecycle activities. These live OUTSIDE the workflow file so
 * the interpreter (which runs in the V8 isolate) can call them through proxies.
 */

export interface CreateWorkflowRunInput {
  workflowId: string;
  templateId: string;
  templateVersion: number;
  workRequestId?: string;
}

/**
 * Creates the WorkflowRun row (used by RunnableWorkflow on first tick) and
 * returns its id + the spec snapshot. The spec is snapshotted on the row so
 * later edits to the template don't affect this run.
 */
export async function createWorkflowRun(
  input: CreateWorkflowRunInput
): Promise<{ runId: string; spec: WorkflowSpec } | { error: string }> {
  const version = await prisma.workflowTemplateVersion.findUnique({
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
  const agents = await prisma.agent.findMany({
    select: { key: true, version: true },
    where: { isActive: true, scope: 'GLOBAL' },
  });
  const agentVersions: Record<string, number> = {};
  for (const a of agents) {
    agentVersions[a.key] = Math.max(agentVersions[a.key] ?? 0, a.version);
  }

  // Upsert by workflowId — re-runs of a Temporal workflow execution with the
  // same workflowId should not create duplicate rows. `update: {}` preserves the
  // original spec + agentVersions snapshot across Temporal retries.
  const run = await prisma.workflowRun.upsert({
    create: {
      agentVersions,
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
  return { runId: run.id, spec };
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
  await prisma.workflowStep.create({
    data: {
      attempt: input.attempt ?? 1,
      endedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
      error: input.error,
      inputs: input.inputs as object | undefined,
      nodeId: input.nodeId,
      outputs: input.outputs as object | undefined,
      runId: input.runId,
      startedAt: now,
      status: input.status,
    },
  });

  // Phase-7: best-effort Slack notification on terminal FAILED records. The
  // interpreter records the FAILED row only after onFail retry budget is
  // exhausted (or for warn-mode it records and continues), so we won't spam
  // the channel on every mid-retry attempt.
  if (input.status === 'FAILED') {
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
        },
      },
    },
    where: { id: runId },
  });
  const workflows = run?.workRequest?.activeWorkflows ?? [];
  const costUsdAccrued = workflows.reduce((sum, aw) => sum + aw.costUsdAccrued, 0);
  const tokensInputTotal = workflows.reduce((sum, aw) => sum + aw.tokensInputUsed, 0);
  const tokensOutputTotal = workflows.reduce((sum, aw) => sum + aw.tokensOutputUsed, 0);

  await prisma.workflowRun.update({
    data: {
      contextSnapshot: contextSnapshot as object | undefined,
      costUsdAccrued,
      endedAt: new Date(),
      status,
      tokensInputTotal,
      tokensOutputTotal,
    },
    where: { id: runId },
  });

  // Write the terminal status back to the ActiveWorkflow row. Templates only
  // advance currentStatus through happy-path states, so without this a
  // failed/timed-out/cancelled run leaves its row "active" forever and the
  // dashboard KPIs drift. SUCCESS maps to COMPLETED (a no-op on specs that
  // already set it); SKIPPED has no ActiveWorkflow equivalent and is left as-is.
  const terminalStatus = status === 'SUCCESS' ? 'COMPLETED' : status === 'SKIPPED' ? null : status;
  if (terminalStatus && run?.workflowId) {
    await prisma.activeWorkflow.updateMany({
      data: { currentStatus: terminalStatus },
      where: { temporalWorkflowId: run.workflowId },
    });
  }

  // P5: aggregate cost into OrgMonthlyUsage using Prisma's increment operator
  // to avoid read-modify-write races on concurrent run finalization.
  const orgId = run?.workRequest?.connection?.team?.orgId;
  if (orgId) {
    const yearMonth = new Date().toISOString().slice(0, 7);
    await prisma.orgMonthlyUsage.upsert({
      create: {
        costUsdAccrued,
        orgId,
        runsCompleted: 1,
        tokensInput: tokensInputTotal,
        tokensOutput: tokensOutputTotal,
        yearMonth,
      },
      update: {
        costUsdAccrued: { increment: costUsdAccrued },
        runsCompleted: { increment: 1 },
        tokensInput: { increment: tokensInputTotal },
        tokensOutput: { increment: tokensOutputTotal },
      },
      where: { orgId_yearMonth: { orgId, yearMonth } },
    });
  }

  // Team must have opted in via `Team.slackNotifySuccess`; otherwise no-op.
  await notifySlackRunComplete({ runId, status });

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
