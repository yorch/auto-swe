import { prisma } from '@auto-swe/shared/db';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { migrateSpec, parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';

/**
 * Workflow run lifecycle activities. These live OUTSIDE the workflow file so
 * the interpreter (which runs in the V8 isolate) can call them through proxies.
 */

export async function loadTemplateSpec(
  templateId: string,
  version: number
): Promise<{ runId: string; spec: WorkflowSpec; workflowId: string } | { error: string }> {
  const row = await prisma.workflowTemplateVersion.findUnique({
    where: { templateId_version: { templateId, version } },
  });
  if (!row) return { error: `template ${templateId}@v${version} not found` };
  try {
    const migrated = migrateSpec(row.spec, SPEC_SCHEMA_VERSION);
    const spec = parseWorkflowSpec(migrated);
    // Caller (createWorkflowRun) provides runId/workflowId.
    return { runId: '', spec, workflowId: '' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

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
}

export async function finalizeWorkflowRun(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
  contextSnapshot?: unknown
): Promise<void> {
  await prisma.workflowRun.update({
    data: {
      contextSnapshot: contextSnapshot as object | undefined,
      endedAt: new Date(),
      status,
    },
    where: { id: runId },
  });
}
