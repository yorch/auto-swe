import type {
  CodeResult,
  RepoWorkRequest,
  Subtask,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import { lookupPath } from '@auto-swe/shared/workflow/expr';
import type { Dispatcher } from '@auto-swe/shared/workflow/interpreter';
import { runSpec } from '@auto-swe/shared/workflow/interpreter';
import { SignalSlots } from '@auto-swe/shared/workflow/signalSlots';
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
    | 'executeGateFixImplementation'
    | 'planDecomposition'
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

const mergeActivities = proxyActivities<Pick<typeof activitiesType, 'mergeBranches'>>({
  heartbeatTimeout: '5m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 2,
    maximumInterval: '1m',
  },
  startToCloseTimeout: '15m',
});

// Conflict resolution is implementer-bound (one or more LLM calls per branch);
// share the long-lived agent timeouts rather than the cheaper merge proxy.
const conflictActivities = proxyActivities<Pick<typeof activitiesType, 'resolveMergeConflict'>>({
  heartbeatTimeout: '5m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '30s',
    maximumAttempts: 2,
    maximumInterval: '2m',
  },
  startToCloseTimeout: '30m',
});

// Quality gates: shell-bound, fail-by-exit-code. Temporal-level retries are
// kept low — workflow-level retry/warn/block comes from the spec's onFail
// policy (handled by the interpreter), not the activity proxy.
const gateActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'runLint' | 'runTypecheck' | 'runTests' | 'runBuild' | 'runVulnScan' | 'runPerfBench'
  >
>({
  heartbeatTimeout: '2m',
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 2,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '15m',
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
  // SignalSlots owns the stale-payload-reset semantics so dispatcher remains
  // a thin wrapper (see packages/shared/src/workflow/signalSlots.ts).
  const slots = new SignalSlots();
  for (const node of Object.values(spec.nodes)) {
    if (node.type === 'signal' && !slots.isRegistered(node.name)) {
      slots.register(node.name);
      const def = defineSignal<[unknown]>(node.name);
      setHandler(def, (payload: unknown) => {
        slots.deliver(node.name, payload);
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
      // Clear any stale payload so we never satisfy this wait with a previous
      // send (mirrors the `ciResult = null` reset at the top of the engineering
      // workflow's CI loop).
      slots.clear(name);
      const received = await condition(() => slots.hasPending(name), timeout as Duration);
      return received ? slots.take(name) : undefined;
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

  // Spread result FIRST so a `status` key inside the terminate node's result
  // cannot overwrite the workflow's actual outcome status. `status` always
  // tracks `outcome.status`.
  return { ...outcome.result, status: outcome.status as WorkflowResult['status'] };
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
    case 'executeImplementation': {
      // Inside a fanOut, the per-branch element is bound at `ctx[itemKey]`.
      const subtask =
        (inputs.subtask as Subtask | undefined) ??
        (lookupPath(ctx, 'subtask') as Subtask | undefined);
      return subtask
        ? await agentActivities.executeImplementation(request, subtask)
        : await agentActivities.executeImplementation(request);
    }
    case 'runReviewNetwork': {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      const successCriteria =
        (inputs.successCriteria as string[] | undefined) ??
        (lookupPath(ctx, 'context.successCriteria') as string[] | undefined);
      return await agentActivities.runReviewNetwork(codeResult, successCriteria);
    }
    case 'executeReviewFixImplementation': {
      const rejection =
        (inputs.rejectionSummary as string | undefined) ??
        (lookupPath(ctx, 'context.lastRejectionSummary') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeReviewFixImplementation(rejection, prev);
    }
    case 'executeCIFixImplementation': {
      const failureContext =
        (inputs.failureContext as string | undefined) ??
        (lookupPath(ctx, 'context.lastCILogs') as string | undefined) ??
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
    // ── Phase 2 quality gates ──────────────────────────────────────────────
    case 'runLint':
    case 'runTypecheck':
    case 'runTests':
    case 'runBuild':
    case 'runVulnScan':
    case 'runPerfBench': {
      const gateInput = {
        command: (inputs.command as string | undefined) ?? (config.command as string | undefined),
        request,
        timeoutMs:
          (inputs.timeoutMs as number | undefined) ?? (config.timeoutMs as number | undefined),
      };
      return await gateActivities[step](gateInput);
    }
    case 'planDecomposition':
      return await agentActivities.planDecomposition(request);
    case 'mergeBranches': {
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      return await mergeActivities.mergeBranches({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    }
    case 'resolveMergeConflict': {
      // Decision 17 symmetry: sourceBranches must be bound explicitly
      // (typically `{ from: 'nodes.merge.output.unmergedBranches' }`).
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      const maxAttemptsPerBranch =
        (inputs.maxAttemptsPerBranch as number | undefined) ??
        (config.maxAttemptsPerBranch as number | undefined);
      return await conflictActivities.resolveMergeConflict({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        ...(typeof maxAttemptsPerBranch === 'number' ? { maxAttemptsPerBranch } : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    }
    case 'executeGateFixImplementation': {
      const gateName =
        (inputs.gateName as string | undefined) ??
        (config.gateName as string | undefined) ??
        'unknown';
      const gateOutput = (inputs.gateOutput ?? lookupPath(ctx, 'context.lastGateOutput')) as
        | activitiesType.GateResult
        | undefined;
      if (!gateOutput) {
        throw new Error(
          'executeGateFixImplementation requires inputs.gateOutput or context.lastGateOutput'
        );
      }
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeGateFixImplementation({
        gateName,
        gateOutput,
        previousCodeResult: prev,
      });
    }
    default:
      throw new Error(`unknown step: ${step}`);
  }
}

// ── Helpers ──

function pickCodeResult(provided: unknown, ctx: Context): CodeResult {
  const v = provided ?? lookupPath(ctx, 'context.currentCodeResult');
  if (!v) {
    throw new Error('step requires a CodeResult but none is bound (context.currentCodeResult)');
  }
  return v as CodeResult;
}

/**
 * Resolve the shared `targetBranch` + `sourceBranches` bindings used by
 * `mergeBranches` and `resolveMergeConflict`. Both require `sourceBranches`
 * to be an explicit `string[]` input binding (decision 17).
 */
function resolveMergeBindings(
  step: string,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): { targetBranch: string; sourceBranches: string[] } {
  const branchPrefix = (config.branchPrefix as string | undefined) ?? 'auto';
  const targetBranch =
    (inputs.targetBranch as string | undefined) ??
    (config.targetBranch as string | undefined) ??
    `${branchPrefix}/${request.externalTicketId}`;
  const raw = inputs.sourceBranches;
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== 'string')) {
    throw new Error(`${step}: inputs.sourceBranches must be a string[]`);
  }
  return { sourceBranches: raw as string[], targetBranch };
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
