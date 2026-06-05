import type {
  CodeResult,
  RepoWorkRequest,
  Subtask,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import { lookupPath } from '@auto-swe/shared/workflow/expr';
import type { CancellationToken, Dispatcher } from '@auto-swe/shared/workflow/interpreter';
import { BranchCancelledError, runSpec } from '@auto-swe/shared/workflow/interpreter';
import { SignalSlots } from '@auto-swe/shared/workflow/signalSlots';
import type { Duration } from '@temporalio/common';
import { CancelledFailure } from '@temporalio/common';
import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
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
    | 'updateDomainState'
    | 'createWorkflowRun'
    | 'recordWorkflowStep'
    | 'finalizeWorkflowRun'
    | 'createHumanStep'
    | 'resolveHumanStep'
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

// Phase 6: user-authored shell steps. `runShellStep` shells out synchronously
// via `spawnSync`, so it can't emit heartbeats while the user command runs.
// We rely on `startToCloseTimeout` (the activity's built-in wall-clock cap is
// `timeoutMs`, set on the shell node) and skip heartbeat enforcement.
const shellActivities = proxyActivities<Pick<typeof activitiesType, 'runShellStep'>>({
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 2,
    maximumInterval: '30s',
  },
  startToCloseTimeout: '60m',
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
  // HITL nodes also get signal handlers — name is `hitl_${nodeId}`.
  const slots = new SignalSlots();
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    let signalName: string | null = null;
    if (node.type === 'signal') {
      signalName = node.name;
    } else if (
      node.type === 'humanApproval' ||
      node.type === 'humanDecision' ||
      node.type === 'humanInput' ||
      node.type === 'humanReview'
    ) {
      signalName = `hitl_${nodeId}`;
    }
    if (signalName && !slots.isRegistered(signalName)) {
      // Capture in a local const for the closure to bind correctly
      const name = signalName;
      slots.register(name);
      const def = defineSignal<[unknown]>(name);
      setHandler(def, (payload: unknown) => {
        slots.deliver(name, payload);
      });
    }
  }

  // 3. Build the Temporal-backed dispatcher.
  //
  // Phase-8: when the interpreter passes a `cancellation` sink (every dispatch
  // inside a fan-out branch), we wrap the activity await in a per-call
  // `CancellationScope` and install a token that maps to the scope's cancel
  // handle. fan-out's block-mode then calls `token.cancel()` on every sibling
  // when one branch fails, which aborts the underlying Temporal activity
  // instead of letting it drain.
  const dispatcher: Dispatcher = {
    async dispatchShell({ node, inputs, cancellation }) {
      return runWithCancellation(cancellation, () =>
        shellActivities.runShellStep({
          ...(typeof node.cpus === 'number' ? { cpus: node.cpus } : {}),
          ...(node.memory ? { memory: node.memory } : {}),
          ...(node.network ? { network: node.network } : {}),
          ...(typeof node.timeoutMs === 'number' ? { timeoutMs: node.timeoutMs } : {}),
          ...(typeof inputs.branch === 'string' ? { branch: inputs.branch } : {}),
          command: typeof inputs.command === 'string' ? inputs.command : node.command,
          image: typeof inputs.image === 'string' ? inputs.image : node.image,
          request: input.request,
        })
      );
    },
    async dispatchStep({ step, ctx, inputs, config, cancellation }) {
      return runWithCancellation(cancellation, () =>
        dispatchStepImpl(step, ctx, input.request, config, inputs)
      );
    },
    async notifyHumanStep(args) {
      await stateActivities.createHumanStep({ ...args, runId });
    },
    async recordStep(args) {
      await stateActivities.recordWorkflowStep({ ...args, runId });
    },
    async resolveHumanStep(args) {
      await stateActivities.resolveHumanStep({ ...args, runId });
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

  // Phase-8: wrap runSpec so an `onFail: 'block'` throw doesn't skip the
  // finalize step. Without this, FAILED runs leave `workflow_runs.status =
  // 'RUNNING'` forever, the cost denorm never lands, and Slack
  // run-complete notifications never fire for the common failure path.
  let outcome: Awaited<ReturnType<typeof runSpec>> | null = null;
  let runError: unknown = null;
  try {
    outcome = await runSpec(spec, initialCtx, dispatcher);
  } catch (err) {
    runError = err;
  }

  const finalStatus: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED' = outcome
    ? (outcome.status as 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED')
    : 'FAILED';
  const finalContext = outcome
    ? summarizeContext(outcome.finalContext)
    : { error: String(runError) };
  await stateActivities.finalizeWorkflowRun(runId, finalStatus, finalContext);

  if (runError) {
    throw runError instanceof Error ? runError : new Error(String(runError));
  }

  // Spread result FIRST so a `status` key inside the terminate node's result
  // cannot overwrite the workflow's actual outcome status.
  const result = outcome?.result ?? {};
  return { ...result, status: finalStatus as WorkflowResult['status'] };
}

// ── Step dispatch ──

async function dispatchStepImpl(
  step: string,
  ctx: Context,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<unknown> {
  const systemPromptOverride = config.systemPrompt as string | undefined;
  const toolsOverride = Array.isArray(config.tools) ? (config.tools as string[]) : undefined;
  switch (step) {
    case 'updateDomainState': {
      const status = (inputs.status ?? config.status) as string;
      await stateActivities.updateDomainState(workflowInfo().workflowId, status);
      return { status };
    }
    case 'validateContext':
      return await contextActivities.validateContext(request, systemPromptOverride);
    case 'executeImplementation': {
      // Inside a fanOut, the per-branch element is bound at `ctx[itemKey]`.
      const subtask =
        (inputs.subtask as Subtask | undefined) ??
        (lookupPath(ctx, 'subtask') as Subtask | undefined);
      return subtask
        ? await agentActivities.executeImplementation(
            request,
            subtask,
            systemPromptOverride,
            toolsOverride
          )
        : await agentActivities.executeImplementation(
            request,
            undefined,
            systemPromptOverride,
            toolsOverride
          );
    }
    case 'runReviewNetwork': {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      const successCriteria =
        (inputs.successCriteria as string[] | undefined) ??
        (lookupPath(ctx, 'context.successCriteria') as string[] | undefined);
      return await agentActivities.runReviewNetwork(
        codeResult,
        successCriteria,
        systemPromptOverride
      );
    }
    case 'executeReviewFixImplementation': {
      const rejection =
        (inputs.rejectionSummary as string | undefined) ??
        (lookupPath(ctx, 'context.lastRejectionSummary') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeReviewFixImplementation(
        rejection,
        prev,
        systemPromptOverride,
        toolsOverride
      );
    }
    case 'executeCIFixImplementation': {
      const failureContext =
        (inputs.failureContext as string | undefined) ??
        (lookupPath(ctx, 'context.lastCILogs') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return await agentActivities.executeCIFixImplementation(
        failureContext,
        prev,
        systemPromptOverride,
        toolsOverride
      );
    }
    case 'createOrUpdatePullRequest': {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      return await githubActivities.createOrUpdatePullRequest(request, codeResult);
    }
    case 'fetchCILogs':
      return await githubActivities.fetchCILogs(inputs.logsUrl as string | undefined);
    case 'commitToMemory': {
      const repoId = (inputs.repoId as string | undefined) ?? request.repoId;
      const lessonId = await memoryActivities.commitToMemory(
        workflowInfo().workflowId,
        repoId,
        systemPromptOverride
      );
      return { lessonId };
    }
    // ── Phase 2 quality gates ──────────────────────────────────────────────
    case 'runLint':
    case 'runTypecheck':
    case 'runTests':
    case 'runBuild':
    case 'runVulnScan':
    case 'runPerfBench': {
      // Per-branch fan-out can override `branch` to point gates at the
      // subtask branch instead of the parent ticket branch (phase 8).
      const branchOverride =
        (inputs.branch as string | undefined) ??
        (config.branch as string | undefined) ??
        (lookupPath(ctx, 'context.currentCodeResult.branch') as string | undefined);
      const gateInput = {
        ...(branchOverride ? { branch: branchOverride } : {}),
        command: (inputs.command as string | undefined) ?? (config.command as string | undefined),
        request,
        timeoutMs:
          (inputs.timeoutMs as number | undefined) ?? (config.timeoutMs as number | undefined),
      };
      return await gateActivities[step](gateInput);
    }
    case 'planDecomposition':
      return await agentActivities.planDecomposition(request, systemPromptOverride);
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
        ...(toolsOverride ? { toolsOverride } : {}),
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
        systemPromptOverride,
        toolsOverride,
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
 * Phase-8 cancellation bridge. When the interpreter passes a `cancellation`
 * sink, wrap the activity call in a `CancellationScope` and write a
 * `cancel()` callback into the sink so fan-out's block-mode can abort the
 * activity. Without a sink we fall through to the bare callback (the
 * pre-phase-8 drain behavior).
 *
 * Cancellation surfaces as a Temporal `CancelledFailure`. We rethrow as a
 * {@link BranchCancelledError} so the interpreter's `runRetryable` recognises
 * it and bypasses `onError` / `onFail` policies — otherwise a sibling branch
 * could `onFail: 'warn'`-swallow a cancellation that block-mode raised on it
 * and keep running after another branch had already failed.
 */
async function runWithCancellation<T>(
  cancellation: { token?: CancellationToken } | undefined,
  body: () => Promise<T>
): Promise<T> {
  if (!cancellation) {
    return body();
  }
  const scope = new CancellationScope({ cancellable: true });
  cancellation.token = { cancel: () => scope.cancel() };
  try {
    return await scope.run(body);
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) {
      throw new BranchCancelledError();
    }
    throw err;
  }
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
