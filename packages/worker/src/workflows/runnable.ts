import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import type {
  CodeResult,
  RepoWorkRequest,
  Subtask,
  WorkflowResult,
} from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import type { CancellationToken, Dispatcher } from '@auto-swe/shared/workflow/interpreter';
import type { Duration } from '@temporalio/common';
import { CancelledFailure } from '@temporalio/common';
import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import {
  BranchCancelledError,
  CHANNEL_TASK_STEER_SIGNAL,
  lookupPath,
  readInterpreterLimits,
  runSpec,
  SignalSlots,
} from '../lib/workflowEngine.js';
import {
  RETRY_AGENT,
  RETRY_LLM_LIGHT,
  RETRY_SANDBOX,
  RETRY_SINGLE_ATTEMPT,
  RETRY_STANDARD,
  RETRY_STATE,
  T_1M,
  T_2M,
  T_5M,
  T_10M,
  T_15M,
  T_30M,
  T_30S,
  T_60M,
} from './proxyOptions.js';

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
    | 'cancelPendingHumanSteps'
    | 'storeContextOverflowBatch'
  >
>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

const genericActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'resolveWorkspace' | 'readSource' | 'writeOutcome' | 'publishOutcome' | 'runTool'
  >
>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_1M,
});

const agentActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'executeImplementation'
    | 'executeCIFixImplementation'
    | 'executeReviewFixImplementation'
    | 'executeGateFixImplementation'
    | 'planDecomposition'
    | 'runChannelSubtasks'
    | 'runReviewNetwork'
  >
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_AGENT,
  startToCloseTimeout: T_30M,
});

const mergeActivities = proxyActivities<Pick<typeof activitiesType, 'mergeBranches'>>({
  heartbeatTimeout: T_5M,
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 2,
    maximumInterval: '1m',
  },
  startToCloseTimeout: T_15M,
});

// Conflict resolution is implementer-bound (one or more LLM calls per branch);
// share the long-lived agent timeouts rather than the cheaper merge proxy.
const conflictActivities = proxyActivities<Pick<typeof activitiesType, 'resolveMergeConflict'>>({
  heartbeatTimeout: T_5M,
  retry: RETRY_AGENT,
  startToCloseTimeout: T_30M,
});

// Phase 6: user-authored shell steps. `runShellStep` runs the command via
// async spawn with heartbeat pumping; `startToCloseTimeout` still caps the
// wall clock (the activity's own cap is `timeoutMs`, set on the shell node).
const shellActivities = proxyActivities<Pick<typeof activitiesType, 'runShellStep'>>({
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_60M,
});

// P4/WS4: container-contract coded steps. Same sandbox/lifecycle shape as shell.
const containerStepActivities = proxyActivities<Pick<typeof activitiesType, 'runContainerStep'>>({
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_60M,
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
  heartbeatTimeout: T_2M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_15M,
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
  startToCloseTimeout: T_2M,
});

const contextActivities = proxyActivities<Pick<typeof activitiesType, 'validateContext'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_5M,
});

const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_5M,
});

// P2: declarative agent node. Tool-free single-shot agent run; same retry shape
// as the other LLM activities. `planChannelTask` (general-route decomposition
// planner) is the same shape — a single-shot structured LLM call.
const agentNodeActivities = proxyActivities<
  Pick<typeof activitiesType, 'runAgentNode' | 'planChannelTask'>
>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// Evals P2: declarative `eval` node. Runs scorers (assert/trajectory + judge
// LLM call), so it gets the longer agent-style timeout.
const evalNodeActivities = proxyActivities<Pick<typeof activitiesType, 'runEvalNode'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// P2/WS4: declarative mcp node. Single external MCP tool call (network I/O in
// the activity); heartbeat + retry like the other network activities.
const mcpNodeActivities = proxyActivities<Pick<typeof activitiesType, 'mcpCallTool'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// CI-wait config resolution — a quick DB read, same shape as the other config
// activities.
const ciConfigActivities = proxyActivities<Pick<typeof activitiesType, 'resolveCiWaitConfig'>>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_1M,
});

// CI polling — a long-running activity that self-bounds by its `deadlineSec`
// input and heartbeats each tick. `startToCloseTimeout` must exceed the largest
// configurable deadline (default 4h); no Temporal-level retry — the poll loop
// already tolerates transient fetch errors, and a deadline is terminal.
const ciPollActivities = proxyActivities<Pick<typeof activitiesType, 'waitForCiByPolling'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: '6h',
});

// PRD decomposition workflow steps. analyzePrd + decomposePrd call LLM agents
// (heartbeat + generous timeout); createTrackerItems + submitPrdWorkRequests
// make external HTTP calls (shorter timeout; no heartbeat needed).
const prdActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'analyzePrd' | 'decomposePrd' | 'createTrackerItems' | 'submitPrdWorkRequests'
  >
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_LLM_LIGHT,
  startToCloseTimeout: T_15M,
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
    canaryAgentKey: input.request.canaryAgentKey,
    canaryVersion: input.request.canaryVersion,
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
  // Interpreter bounds come from the pinned-settings snapshot taken when the run
  // row was created. Reading them here rather than resolving them live is what
  // keeps a mid-run edit from changing the ceiling a replay was recorded under.
  const interpreterLimits = readInterpreterLimits(runInfo.pinnedSettings);

  // Generic runs carry their workspace provider and target connection on the
  // request; SWE runs fall back to the git_repo provider and the repoId.
  const runConnectionId = input.request.connectionId ?? input.request.repoId ?? null;
  const rawWorkspaceProvider = input.request.workspaceProvider;
  const runWorkspaceProvider =
    typeof rawWorkspaceProvider === 'string'
      ? (rawWorkspaceProvider as WorkspaceProviderType)
      : 'git_repo';

  // 2. Register signal handlers for every signal name referenced in the spec.
  // SignalSlots owns the stale-payload-reset semantics so dispatcher remains
  // a thin wrapper (see packages/shared/src/workflow/signalSlots.ts).
  // HITL nodes also get signal handlers — name is `hitl_${nodeId}`.
  //
  // This covers the names known statically. A HITL node reached inside a
  // fanOut branch waits on a branch-unique name (`hitl_fan[0]/gate`) that only
  // exists once the interpreter gets there, so `waitSignal` below registers
  // any name it has not seen on first use. Temporal buffers a signal that
  // arrives before its handler is set, and handler registration emits no
  // command, so the lazy path is replay-safe.
  const slots = new SignalSlots();
  const ensureSignalHandler = (name: string): void => {
    if (slots.isRegistered(name)) {
      return;
    }
    slots.register(name);
    setHandler(defineSignal<[unknown]>(name), (payload: unknown) => {
      slots.deliver(name, payload);
    });
  };
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (node.type === 'signal') {
      ensureSignalHandler(node.name);
    } else if (
      node.type === 'humanApproval' ||
      node.type === 'humanDecision' ||
      node.type === 'humanInput' ||
      node.type === 'humanReview'
    ) {
      ensureSignalHandler(`hitl_${nodeId}`);
    }
  }

  // 2b. Channel steering: an append-only buffer fed by the `steer` signal. The
  // gateway signals `steer` with new user guidance on a thread reply; the next
  // `agent` node drains and incorporates it (SOFT — the in-progress node, if
  // any, is never preempted). A plain in-workflow array is Temporal-deterministic
  // (mirrors `epicOrchestrator`'s `cancelled` flag). The signal name is the
  // shared `CHANNEL_TASK_STEER_SIGNAL` const — `@auto-swe/shared/lib/channelTask`
  // is pure (no Node deps), so the value import is isolate-safe.
  //
  // Scope: steering reaches `agent` nodes only. The GENERAL Channel Task route is
  // a single agent node, so it picks up steering that arrives before it runs. The
  // CODE route runs the SWE template (implement/review via `step` nodes, not
  // `agent` nodes), so steering buffered for a code task is NOT consumed — wiring
  // mid-flight steering into the implementer/reviewer step executors is a future
  // refinement (see docs/channel-assistant.md §8).
  const steerBuffer: string[] = [];
  setHandler(defineSignal<[string]>(CHANNEL_TASK_STEER_SIGNAL), (msg: string) => {
    steerBuffer.push(msg);
  });

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
    drainSteering() {
      // Drain (return + clear) so each agent node consumes only the steering
      // that arrived since the previous one.
      return steerBuffer.splice(0);
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
      // No stale-payload reset here: a signal that lands before the interpreter
      // reaches its wait node (a CI webhook racing the PR-open step is the
      // common case) is kept and satisfies that wait. `take()` consumes the
      // payload, so a wait never sees a value an earlier wait already used.
      ensureSignalHandler(name);
      const received = await condition(() => slots.hasPending(name), timeout as Duration);
      return received ? slots.take(name) : undefined;
    },
  };

  // 4. Run.
  const initialCtx: Context = {
    context: {
      workspace: {
        connectionId: runConnectionId,
        provider: runWorkspaceProvider,
      },
    },
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
    outcome = await runSpec(spec, initialCtx, dispatcher, interpreterLimits);
  } catch (err) {
    runError = err;
  }

  // A workflow cancellation (handle.cancel(), the run-cancel route) surfaces
  // from runSpec as a CancelledFailure. It is not a failure of the spec: record
  // it as CANCELLED so the run row, the inbox, and Slack all say what happened.
  const cancelled = runError !== null && isCancellation(runError);
  const finalStatus: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED' = outcome
    ? (outcome.status as 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED')
    : cancelled
      ? 'CANCELLED'
      : 'FAILED';
  // Persist the terminate-node result so the run detail page can surface it
  // without re-deriving it from the spec and step traces.
  if (outcome) {
    outcome.finalContext.result = outcome.result;
  }
  // Finalisation must run to completion even after the workflow's root scope
  // was cancelled: every activity started from a cancelled scope throws
  // CancelledFailure immediately, which left cancelled runs RUNNING forever
  // with their PENDING human steps still in the inbox.
  await CancellationScope.nonCancellable(async () => {
    const finalContext = outcome
      ? await snapshotContext(outcome.finalContext, runId)
      : { error: String(runError) };
    // Cancel any PENDING human-step rows before finalizing. This cleans up steps
    // left waiting by a workflow cancellation, hard failure, or other abnormal exit
    // so they don't linger in the inbox as un-actionable ghost tasks.
    // Best-effort: a failure here must not prevent finalization.
    try {
      await stateActivities.cancelPendingHumanSteps(runId);
    } catch (err) {
      log.warn('cancelPendingHumanSteps failed; lingering PENDING rows may remain in the inbox', {
        err: err instanceof Error ? err.message : String(err),
        runId,
      });
    }
    await stateActivities.finalizeWorkflowRun(runId, finalStatus, finalContext);
  });

  if (runError) {
    throw runError instanceof Error ? runError : new Error(String(runError));
  }

  // Spread result FIRST so a `status` key inside the terminate node's result
  // cannot overwrite the workflow's actual outcome status.
  const result = outcome?.result ?? {};
  return { ...result, status: finalStatus as WorkflowResult['status'] };
}

// ── Step dispatch ──
//
// Steps are registered as executors in STEP_EXECUTORS, keyed by step name;
// `dispatchStepImpl` does a single Map lookup with no `switch`. The map is
// built once at module load — the `proxyActivities` stubs above are
// deterministic (no I/O), so this is safe inside the V8 workflow isolate.
// Adding a step = adding a map entry; control flow never changes.
//
// Each executor receives the same args; it derives `config.systemPrompt`
// (toolsOverride is intentionally NOT passed to activities — tool selection is
// DB-driven via AgentSkillAssignment, WORKFLOW_TEMPLATE → TEAM → GLOBAL).

interface StepExecutorArgs {
  step: string;
  ctx: Context;
  request: RepoWorkRequest;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

type StepExecutor = (args: StepExecutorArgs) => Promise<unknown>;

/** Resolve a step's target connection, defaulting to the run-level workspace. */
function resolveConnectionId(step: string, ctx: Context, inputs: Record<string, unknown>): string {
  const workspaceConnectionId =
    ((ctx.context as Record<string, unknown>).workspace as Record<string, unknown> | undefined)
      ?.connectionId ?? undefined;
  const connectionId =
    (inputs.connectionId as string | undefined) ??
    (typeof workspaceConnectionId === 'string' ? workspaceConnectionId : undefined);
  if (!connectionId) {
    throw new Error(`${step} requires inputs.connectionId or a resolved workspace connection`);
  }
  return connectionId;
}

/**
 * Read the two cross-repo step opt-ins off a step's config (repo dependency
 * graph, P2) and hand them to the activity as a plain object.
 *
 * `crossRepoContext` defaults ON — it is a bounded prompt block, and an
 * unconfigured template should still get the graph. `crossRepoCheckout` defaults
 * OFF — it clones repos into the workspace. Only explicit booleans are passed
 * through, so `undefined` reaches the activity as "unset" and the activity's own
 * default applies.
 */
function crossRepoOptions(config: Record<string, unknown>): {
  crossRepoCheckout?: boolean;
  crossRepoContext?: boolean;
} {
  return {
    ...(typeof config.crossRepoCheckout === 'boolean'
      ? { crossRepoCheckout: config.crossRepoCheckout }
      : {}),
    ...(typeof config.crossRepoContext === 'boolean'
      ? { crossRepoContext: config.crossRepoContext }
      : {}),
  };
}

// Shared executor for the six shell-bound quality gates — they differ only by
// the activity name, which is the step name itself.
const gateExecutor: StepExecutor = ({ step, ctx, request, config, inputs }) => {
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
    timeoutMs: (inputs.timeoutMs as number | undefined) ?? (config.timeoutMs as number | undefined),
  };
  // All six gate activities share the same input/return shape; index by name.
  return gateActivities[step as 'runLint'](gateInput);
};

const STEP_EXECUTORS: ReadonlyMap<string, StepExecutor> = new Map<string, StepExecutor>([
  [
    'updateDomainState',
    async ({ config, inputs }) => {
      const status = (inputs.status ?? config.status) as string;
      await stateActivities.updateDomainState(workflowInfo().workflowId, status);
      return { status };
    },
  ],
  [
    'validateContext',
    ({ request, config }) =>
      contextActivities.validateContext(request, config.systemPrompt as string | undefined),
  ],
  [
    // P2 declarative agent node: run a library Agent by reference.
    'runAgentNode',
    ({ request, config, inputs }) =>
      agentNodeActivities.runAgentNode({
        agentRef: config.agentRef as string,
        // Phase A: thread the run's originating channel (if any) so the agent
        // resolves the CHANNEL config tier. Undefined for non-channel runs.
        ...(request.channelId ? { channelId: request.channelId } : {}),
        inputs,
        spanName: config.spanName as string | undefined,
        // Phase C: soft steering drained by the interpreter from the `steer`
        // signal buffer; the activity prepends it as a labeled prompt block.
        ...(config.steering ? { steering: config.steering as string[] } : {}),
        systemPrompt: config.systemPrompt as string | undefined,
        userMessage: config.userMessage as string | undefined,
      }),
  ],
  [
    // Evals P2 declarative eval node: score a target value with a list of scorers.
    'runEvalNode',
    ({ config }) =>
      evalNodeActivities.runEvalNode({
        judgeAdvisory: config.judgeAdvisory as boolean | undefined,
        scorers: config.scorers as Parameters<typeof evalNodeActivities.runEvalNode>[0]['scorers'],
        spanName: config.spanName as string | undefined,
        targetValue: config.targetValue,
      }),
  ],
  [
    // P2/WS4 declarative mcp node: call one MCP tool as a workflow step.
    'mcpCallTool',
    ({ config, inputs }) =>
      mcpNodeActivities.mcpCallTool({
        connectionRef: config.connectionRef as string,
        inputs,
        spanName: config.spanName as string | undefined,
        tool: config.tool as string,
      }),
  ],
  [
    // P4/WS4 container-contract coded step: run an image with JSON in/out.
    'runContainerStep',
    ({ request, config, inputs }) =>
      containerStepActivities.runContainerStep({
        command: config.command as string | undefined,
        cpus: config.cpus as number | undefined,
        image: config.image as string,
        inputs,
        memory: config.memory as string | undefined,
        network: config.network as 'none' | 'egress' | undefined,
        request,
        ...(config.sidecar
          ? { sidecar: config.sidecar as { port: number; requestPath?: string } }
          : {}),
        timeoutMs: config.timeoutMs as number | undefined,
        transport: config.transport as 'stdout' | 'ndjson' | 'sidecar' | undefined,
      }),
  ],
  [
    'executeImplementation',
    ({ ctx, request, config, inputs }) => {
      const systemPromptOverride = config.systemPrompt as string | undefined;
      const crossRepo = crossRepoOptions(config);
      // Inside a fanOut, the per-branch element is bound at `ctx[itemKey]`.
      const subtask =
        (inputs.subtask as Subtask | undefined) ??
        (lookupPath(ctx, 'subtask') as Subtask | undefined);
      // `subtask` is already `Subtask | undefined`, so both arms of the ternary
      // this replaced passed the same thing.
      return agentActivities.executeImplementation(
        request,
        subtask,
        systemPromptOverride,
        crossRepo
      );
    },
  ],
  [
    'runReviewNetwork',
    ({ ctx, config, inputs }) => {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      const successCriteria =
        (inputs.successCriteria as string[] | undefined) ??
        (lookupPath(ctx, 'context.successCriteria') as string[] | undefined);
      return agentActivities.runReviewNetwork(
        codeResult,
        successCriteria,
        config.systemPrompt as string | undefined,
        crossRepoOptions(config)
      );
    },
  ],
  [
    'executeReviewFixImplementation',
    ({ ctx, config, inputs }) => {
      const rejection =
        (inputs.rejectionSummary as string | undefined) ??
        (lookupPath(ctx, 'context.lastRejectionSummary') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return agentActivities.executeReviewFixImplementation(
        rejection,
        prev,
        config.systemPrompt as string | undefined
      );
    },
  ],
  [
    'executeCIFixImplementation',
    ({ ctx, config, inputs }) => {
      const failureContext =
        (inputs.failureContext as string | undefined) ??
        (lookupPath(ctx, 'context.lastCILogs') as string | undefined) ??
        '';
      const prev = pickCodeResult(inputs.previousCodeResult, ctx);
      return agentActivities.executeCIFixImplementation(
        failureContext,
        prev,
        config.systemPrompt as string | undefined
      );
    },
  ],
  [
    'createOrUpdatePullRequest',
    ({ ctx, request, inputs }) => {
      const codeResult = pickCodeResult(inputs.codeResult, ctx);
      return githubActivities.createOrUpdatePullRequest(request, codeResult);
    },
  ],
  [
    'fetchCILogs',
    ({ inputs }) => githubActivities.fetchCILogs(inputs.logsUrl as string | undefined),
  ],
  ['resolveCiWaitConfig', () => ciConfigActivities.resolveCiWaitConfig()],
  [
    'waitForCiByPolling',
    ({ ctx, request, inputs }) => {
      const ref =
        (inputs.ref as string | undefined) ??
        (lookupPath(ctx, 'context.currentCodeResult.branch') as string | undefined);
      if (!ref) {
        throw new Error(
          'waitForCiByPolling requires inputs.ref or context.currentCodeResult.branch'
        );
      }
      return ciPollActivities.waitForCiByPolling({
        deadlineSec: inputs.deadlineSec as number,
        graceSec: inputs.graceSec as number,
        intervalSec: inputs.intervalSec as number,
        ref,
        repoId: request.repoId,
      });
    },
  ],
  [
    'commitToMemory',
    async ({ request, config, inputs }) => {
      const repoId = (inputs.repoId as string | undefined) ?? request.repoId;
      const lessonId = await memoryActivities.commitToMemory(
        workflowInfo().workflowId,
        repoId,
        config.systemPrompt as string | undefined
      );
      return { lessonId };
    },
  ],
  // ── Phase 2 quality gates (all six share gateExecutor) ──────────────────────
  ['runLint', gateExecutor],
  ['runTypecheck', gateExecutor],
  ['runTests', gateExecutor],
  ['runBuild', gateExecutor],
  ['runVulnScan', gateExecutor],
  ['runPerfBench', gateExecutor],
  [
    'planDecomposition',
    ({ request, config }) =>
      agentActivities.planDecomposition(request, config.systemPrompt as string | undefined),
  ],
  [
    // General-route decomposition planner. `task` binds from request.description;
    // thread the run's channelId so the planner resolves the CHANNEL model tier.
    'planChannelTask',
    ({ request, config, inputs }) =>
      agentNodeActivities.planChannelTask({
        task: (inputs.task as string | undefined) ?? request.description,
        ...(request.channelId ? { channelId: request.channelId } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt as string } : {}),
      }),
  ],
  [
    // Decompose path: run each planned subtask + synthesize (long-running, so it
    // rides the agent proxy). `subtasks` binds from the planner's output.
    'runChannelSubtasks',
    ({ request, config, inputs }) =>
      agentActivities.runChannelSubtasks({
        subtasks: (inputs.subtasks as { title: string; description: string }[] | undefined) ?? [],
        task: (inputs.task as string | undefined) ?? request.description,
        ...(request.channelId ? { channelId: request.channelId } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt as string } : {}),
      }),
  ],
  [
    'mergeBranches',
    ({ step, request, config, inputs }) => {
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      return mergeActivities.mergeBranches({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    },
  ],
  [
    'resolveMergeConflict',
    ({ step, request, config, inputs }) => {
      // Decision 17 symmetry: sourceBranches must be bound explicitly
      // (typically `{ from: 'nodes.merge.output.unmergedBranches' }`).
      const { targetBranch, sourceBranches } = resolveMergeBindings(step, request, config, inputs);
      const maxAttemptsPerBranch =
        (inputs.maxAttemptsPerBranch as number | undefined) ??
        (config.maxAttemptsPerBranch as number | undefined);
      return conflictActivities.resolveMergeConflict({
        ...(config.mergeMessagePrefix
          ? { mergeMessagePrefix: config.mergeMessagePrefix as string }
          : {}),
        ...(typeof maxAttemptsPerBranch === 'number' ? { maxAttemptsPerBranch } : {}),
        request,
        sourceBranches,
        targetBranch,
      });
    },
  ],
  // ── PRD decomposition workflow ───────────────────────────────────────────────
  [
    'analyzePrd',
    ({ request, config }) =>
      prdActivities.analyzePrd(request, config.systemPrompt as string | undefined),
  ],
  [
    'decomposePrd',
    ({ request, config, inputs }) =>
      prdActivities.decomposePrd(
        request,
        { analysis: inputs.analysis, pmFeedback: inputs.pmFeedback },
        config.systemPrompt as string | undefined
      ),
  ],
  [
    'createTrackerItems',
    ({ request, inputs }) =>
      prdActivities.createTrackerItems(request, {
        decomposition: inputs.decomposition,
      }),
  ],
  [
    'submitPrdWorkRequests',
    ({ request, inputs }) =>
      prdActivities.submitPrdWorkRequests(request, {
        decomposition: inputs.decomposition,
        trackerItems: inputs.trackerItems,
      }),
  ],
  [
    'executeGateFixImplementation',
    ({ ctx, config, inputs }) => {
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
      return agentActivities.executeGateFixImplementation({
        gateName,
        gateOutput,
        previousCodeResult: prev,
        systemPromptOverride: config.systemPrompt as string | undefined,
      });
    },
  ],
  [
    'resolveWorkspace',
    async ({ request, config, inputs, ctx }) => {
      const workspaceCtx =
        ((ctx.context as Record<string, unknown>).workspace as
          | Record<string, unknown>
          | undefined) ?? {};
      const workspaceProvider =
        (config.workspaceProvider as WorkspaceProviderType | undefined) ??
        (workspaceCtx.provider as WorkspaceProviderType | undefined) ??
        'git_repo';
      const connectionId =
        (inputs.connectionId as string | null | undefined) ??
        (workspaceCtx.connectionId as string | null | undefined) ??
        request.connectionId ??
        null;
      const result = await genericActivities.resolveWorkspace({
        connectionId,
        payload: (inputs.payload as unknown) ?? request.payload,
        workspaceProvider,
      });
      (ctx.context as Record<string, unknown>).workspace = { ...workspaceCtx, ...result };
      return result;
    },
  ],
  [
    'readSource',
    ({ inputs, ctx, step }) =>
      genericActivities.readSource({
        connectionId: resolveConnectionId(step, ctx, inputs),
        query:
          inputs.pageId !== undefined
            ? { pageId: inputs.pageId as string }
            : inputs.ticketId !== undefined
              ? { ticketId: inputs.ticketId as string }
              : inputs.query,
      }),
  ],
  [
    'writeOutcome',
    ({ inputs, ctx, step }) => {
      let data = inputs.data;
      // Convenience for Notion: a template can pass `text` + `pageId` and the
      // step wraps it into a single paragraph block.
      if (data === undefined && inputs.text && inputs.pageId) {
        data = {
          blocks: [
            {
              paragraph: {
                rich_text: [{ text: { content: inputs.text as string } }],
              },
              type: 'paragraph',
            },
          ],
          pageId: inputs.pageId,
        };
      }
      // Convenience for Zendesk: build a comment payload from `body`, `ticketId`,
      // and the optional `public` flag.
      if (
        data === undefined &&
        typeof inputs.body === 'string' &&
        typeof inputs.ticketId === 'string'
      ) {
        data = {
          body: inputs.body,
          public: inputs.public === true,
          ticketId: inputs.ticketId,
        };
      }
      // Convenience for Zendesk: pass through the public/private flag.
      if (typeof inputs.public === 'boolean' && typeof data === 'object' && data != null) {
        data = { ...(data as object), public: inputs.public };
      }
      return genericActivities.writeOutcome({
        connectionId: resolveConnectionId(step, ctx, inputs),
        data,
        nodeId: step,
      });
    },
  ],
  [
    'publishOutcome',
    ({ config, ctx, inputs }) =>
      genericActivities.publishOutcome({
        action:
          (inputs.action as string | undefined) ??
          (config.action as string | undefined) ??
          'external_communication',
        description: inputs.description as string | undefined,
        workflowId: (ctx.workflow as { id: string }).id,
      }),
  ],
  [
    'runTool',
    ({ inputs, ctx, step }) =>
      genericActivities.runTool({
        connectionId: resolveConnectionId(step, ctx, inputs),
        inputs: inputs.inputs,
        tool: inputs.tool as string,
      }),
  ],
]);

async function dispatchStepImpl(
  step: string,
  ctx: Context,
  request: RepoWorkRequest,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<unknown> {
  const executor = STEP_EXECUTORS.get(step);
  if (!executor) {
    throw new Error(`unknown step: ${step}`);
  }
  return executor({ config, ctx, inputs, request, step });
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
  } finally {
    // The token belongs to this call's scope. Leaving it behind would let a
    // later block-mode cancel target a scope that has already settled instead
    // of the branch's actual in-flight work.
    cancellation.token = undefined;
  }
}

/** Strings longer than this are spilled to a `WorkflowArtifact`. */
const CONTEXT_INLINE_LIMIT = 4000;

/**
 * Per-activity payload budget for spilled values, in UTF-16 code units.
 *
 * Temporal caps how large a single activity input may be, and a run that
 * exceeds it fails at finalization — after all the real work is done. Well
 * under the limit on purpose: this is a floor on round trips, not an attempt to
 * pack the payload.
 */
const SPILL_CHUNK_BUDGET = 1_000_000;

/**
 * Ceiling on how much a single run may spill in total, across all chunks.
 *
 * Activity *inputs* are recorded in workflow history, so spilling is not free
 * the way a plain artifact write would be: every byte sent through
 * `storeContextOverflowBatch` also lands in the run's history, which Temporal
 * caps. The old 20-value cap bounded this incidentally; removing it removed the
 * bound too. Past this, values fall back to truncation — the same degradation
 * the cap used to apply, but keyed on the resource that actually runs out.
 */
const SPILL_TOTAL_BUDGET = 8_000_000;

/**
 * Groups values into chunks whose combined length stays under the budget.
 * A value bigger than the budget on its own occupies a chunk by itself, which
 * is the same payload it had when every value was sent individually.
 */
function chunkBySize<T extends { value: string }>(items: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.value.length > SPILL_CHUNK_BUDGET) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.value.length;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function truncatedPlaceholder(value: string, note: string): string {
  return `${value.slice(0, CONTEXT_INLINE_LIMIT)}… [truncated ${value.length} bytes — ${note}]`;
}

/**
 * Keep the persisted run snapshot small without losing anything.
 *
 * The snapshot exists so a run is reproducible, and the values most worth
 * keeping — diffs, gate logs, agent output — are exactly the ones that used to
 * be clipped at 4KB. Oversized strings are now written to a `WorkflowArtifact`
 * and replaced by a reference the run viewer can resolve, so `workflow_runs`
 * rows stay small and the content survives.
 *
 * Spilling is best-effort: if the artifact write fails we degrade to the old
 * truncation rather than failing the run at its final step.
 */
async function snapshotContext(ctx: Context, runId: string): Promise<unknown> {
  const oversized: { path: string; value: string }[] = [];

  // First pass: find what needs spilling, recording each value's path so the
  // placeholder can say where it came from.
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.length > CONTEXT_INLINE_LIMIT) {
        oversized.push({ path, value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(ctx, '');

  // Batched, but size-bounded. Spilling one value per activity used to cost a
  // round trip each, which is why this was capped at 20 and truncated the rest.
  // Batching removes that reason — but putting *every* value in one activity
  // input would push a large context past Temporal's payload limit and fail the
  // run at its final step, which is strictly worse than the truncation it
  // replaced. So chunk by accumulated size instead.
  //
  // A single value larger than the budget still goes alone, exactly as it did
  // when every value went alone.
  // Past the total ceiling, stop spilling and truncate the remainder — the
  // placeholder says which case applied, so a reader can tell a failed write
  // from a run that simply produced more context than history can hold.
  const spillable: typeof oversized = [];
  let budget = SPILL_TOTAL_BUDGET;
  for (const item of oversized) {
    if (item.value.length > budget) {
      break;
    }
    budget -= item.value.length;
    spillable.push(item);
  }

  const spilled = new Map<string, string>();
  for (const chunk of chunkBySize(spillable)) {
    const refs = await stateActivities.storeContextOverflowBatch({
      runId,
      values: chunk.map(({ path, value }) => ({ content: value, path })),
    });
    chunk.forEach(({ path, value }, i) => {
      const ref = refs[i];
      spilled.set(
        path,
        ref
          ? `[stored as artifact ${ref.artifactId} — ${ref.sizeBytes} bytes]`
          : truncatedPlaceholder(value, 'artifact write failed')
      );
    });
  }

  // Second pass: substitute by path, so two identical strings at different
  // paths cannot collide.
  const rebuild = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (value.length <= CONTEXT_INLINE_LIMIT) {
        return value;
      }
      // A value with no `spilled` entry is one the total ceiling stopped at.
      return (
        spilled.get(path) ?? truncatedPlaceholder(value, 'run exceeded its total spill budget')
      );
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => rebuild(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rebuild(v, path ? `${path}.${k}` : k)])
      );
    }
    return value;
  };

  return rebuild(ctx, '');
}
