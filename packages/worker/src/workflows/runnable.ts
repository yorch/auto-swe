import type { CodeResult, RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import type { Dispatcher } from '@auto-swe/shared/workflow/interpreter';
import { runSpec } from '@auto-swe/shared/workflow/interpreter';
import type { Duration } from '@temporalio/common';
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';

/**
 * RunnableWorkflow — generic interpreter that executes any WorkflowSpec.
 *
 * The spec is fetched once at start (deterministic input), then the shared
 * interpreter walks nodes. All side effects go through activities; the
 * workflow body itself is pure walk + dispatch.
 */

// ── Activity proxies (mirror the policies used by the hardcoded engineering workflow) ──

const stateActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'updateDomainState' | 'createWorkflowRun' | 'recordWorkflowStep' | 'finalizeWorkflowRun'
  >
>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '1s',
    maximumAttempts: 5,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '30s',
});

const agentActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'executeImplementation'
    | 'executeCIFixImplementation'
    | 'executeReviewFixImplementation'
    | 'runReviewNetwork'
  >
>({
  heartbeatTimeout: '5m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '30s',
    maximumAttempts: 2,
    maximumInterval: '2m',
  },
  startToCloseTimeout: '30m',
});

const githubActivities = proxyActivities<
  Pick<typeof activitiesType, 'createOrUpdatePullRequest' | 'fetchCILogs'>
>({
  retry: {
    backoffCoefficient: 3,
    initialInterval: '5s',
    maximumAttempts: 4,
    maximumInterval: '2m',
  },
  startToCloseTimeout: '2m',
});

const contextActivities = proxyActivities<Pick<typeof activitiesType, 'validateContext'>>({
  heartbeatTimeout: '2m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 3,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '5m',
});

// ── Inputs ──

export interface RunnableWorkflowInput {
  templateId: string;
  templateVersion: number;
  request: RepoWorkRequest;
}

// ── Workflow ──

export async function RunnableWorkflow(input: RunnableWorkflowInput): Promise<WorkflowResult> {
  const workflowId = workflowInfo().workflowId;

  // 1. Materialize the run row + parsed spec snapshot.
  const runInfo = await stateActivities.createWorkflowRun({
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    workflowId,
    workRequestId: input.request.workRequestId,
  });
  if ('error' in runInfo) {
    throw new Error(`failed to load workflow template: ${runInfo.error}`);
  }
  const spec = runInfo.spec;
  const runId = runInfo.runId;

  // 2. Register signal handlers for every signal name referenced in the spec.
  // Slots use undefined to mean "no signal received yet" so subsequent waits
  // on the same name don't fire on stale payloads.
  const signalSlots = new Map<string, unknown>();
  for (const node of Object.values(spec.nodes)) {
    if (node.type === 'signal' && !signalSlots.has(node.name)) {
      signalSlots.set(node.name, undefined);
      const def = defineSignal<[unknown]>(node.name);
      setHandler(def, (payload: unknown) => {
        signalSlots.set(node.name, payload ?? null);
      });
    }
  }

  // 3. Build the Temporal-backed dispatcher.
  const dispatcher: Dispatcher = {
    async dispatchStep({ step, ctx, inputs, config }) {
      return dispatchStepImpl(step, ctx, input.request, config, inputs);
    },
    async recordStep(args) {
      await stateActivities.recordWorkflowStep({ ...args, runId });
    },
    async waitSignal(name, timeout) {
      // Reset stale payloads so we never satisfy a wait with a previous send.
      if (signalSlots.get(name) !== undefined) signalSlots.set(name, undefined);
      const received = await condition(
        () => signalSlots.get(name) !== undefined,
        timeout as Duration
      );
      if (!received) return undefined;
      const payload = signalSlots.get(name);
      signalSlots.set(name, undefined);
      return payload;
    },
  };

  // 4. Run.
  const initialCtx: Context = {
    context: {},
    nodes: {},
    request: input.request as unknown as Record<string, unknown>,
    workflow: { id: workflowId },
  };

  const outcome = await runSpec(spec, initialCtx, dispatcher);
  await stateActivities.finalizeWorkflowRun(
    runId,
    outcome.status as 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED',
    summarizeContext(outcome.finalContext)
  );

  return { status: outcome.status as WorkflowResult['status'], ...outcome.result };
}

// ── Step dispatch ──

async function dispatchStepImpl(
  step: string,
  ctx: Context,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<unknown> {
  switch (step) {
    case 'updateDomainState': {
      const status = (inputs.status ?? config.status) as string;
      await stateActivities.updateDomainState(workflowInfo().workflowId, status);
      return { status };
    }
    case 'validateContext':
      return await contextActivities.validateContext(request);
    case 'executeImplementation':
      return await agentActivities.executeImplementation(request);
    case 'runReviewNetwork': {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      const successCriteria =
        (inputs.successCriteria as string[] | undefined) ??
        (lookupCtx(ctx, 'context.successCriteria') as string[] | undefined);
      return await agentActivities.runReviewNetwork(codeResult, successCriteria);
    }
    case 'executeReviewFixImplementation': {
      const rejection =
        (inputs.rejectionSummary as string | undefined) ??
        (lookupCtx(ctx, 'context.lastRejectionSummary') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeReviewFixImplementation(rejection, prev);
    }
    case 'executeCIFixImplementation': {
      const failureContext =
        (inputs.failureContext as string | undefined) ??
        (lookupCtx(ctx, 'context.lastCILogs') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeCIFixImplementation(failureContext, prev);
    }
    case 'createOrUpdatePullRequest': {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      return await githubActivities.createOrUpdatePullRequest(request, codeResult);
    }
    case 'fetchCILogs':
      return await githubActivities.fetchCILogs(inputs.logsUrl as string | undefined);
    case 'commitToMemory': {
      const repoId = (inputs.repoId as string | undefined) ?? request.repoId;
      const lessonId = await memoryActivities.commitToMemory(workflowInfo().workflowId, repoId);
      return { lessonId };
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}

// ── Helpers ──

function pickCodeResult(provided: unknown, ctx: Context): CodeResult {
  const v = provided ?? lookupCtx(ctx, 'context.currentCodeResult');
  if (!v) {
    throw new Error('step requires a CodeResult but none is bound (context.currentCodeResult)');
  }
  return v as CodeResult;
}

function lookupCtx(ctx: Context, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Strip large fields from the context before persisting so we don't bloat the
 * workflow_runs row. Phase 2 will move diffs/logs to WorkflowArtifact entirely;
 * for now we just truncate strings >4KB in the snapshot.
 */
function summarizeContext(ctx: Context): unknown {
  return JSON.parse(
    JSON.stringify(ctx, (_k, v) => {
      if (typeof v === 'string' && v.length > 4000) {
        return `${v.slice(0, 4000)}… [truncated ${v.length} bytes]`;
      }
      return v;
    })
  );
}
