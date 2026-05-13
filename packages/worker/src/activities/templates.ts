import { prisma } from '@auto-swe/shared/db';
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

  // Upsert by workflowId — re-runs of a Temporal workflow execution with the
  // same workflowId should not create duplicate rows.
  const run = await prisma.workflowRun.upsert({
    create: {
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
  // Phase-8: denormalize the run's cost onto workflow_runs at finalize time.
  // Reads through workRequest → activeWorkflows (the same join the analytics
  // route used to do every request) and writes the sum to the run row. Skips
  // the join if the run has no work-request attached.
  const run = await prisma.workflowRun.findUnique({
    select: {
      workRequest: { select: { activeWorkflows: { select: { costUsdAccrued: true } } } },
    },
    where: { id: runId },
  });
  const costUsdAccrued = (run?.workRequest?.activeWorkflows ?? []).reduce(
    (sum, aw) => sum + aw.costUsdAccrued,
    0
  );

  await prisma.workflowRun.update({
    data: {
      contextSnapshot: contextSnapshot as object | undefined,
      costUsdAccrued,
      endedAt: new Date(),
      status,
    },
    where: { id: runId },
  });

  // Best-effort terminal notification. Team must have opted in via
  // `Team.slackNotifySuccess`; otherwise this is a silent no-op.
  await notifySlackRunComplete({ runId, status });
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
  const repo = await prisma.repository.findUniqueOrThrow({
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
