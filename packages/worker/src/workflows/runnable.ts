import type { WorkspaceProviderType } from '@auto-swe/shared/lib/workspaceProviders';
import type { RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';
import type { Context } from '@auto-swe/shared/workflow/expr';
import type { CancellationToken, Dispatcher } from '@auto-swe/shared/workflow/interpreter';
import type { Duration } from '@temporalio/common';
import { ApplicationFailure, CancelledFailure, TemporalFailure } from '@temporalio/common';
import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  log,
  patched,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  BranchCancelledError,
  CHANNEL_TASK_STEER_SIGNAL,
  readInterpreterLimits,
  runSpec,
  SignalSlots,
} from '../lib/workflowEngine.js';
import type { NodeTag } from './nodeTag.js';
import { runWithNodeTag } from './nodeTagScope.js';
import { shellActivities, stateActivities } from './runnableActivities.js';
import { boundForRecord, boundString, snapshotContext } from './runnableContext.js';
import { dispatchStepImpl } from './runnableSteps.js';

/**
 * RunnableWorkflow — generic interpreter that executes any WorkflowSpec.
 *
 * The spec is fetched once at start (deterministic input), then the shared
 * interpreter walks nodes. All side effects go through activities; the
 * workflow body itself is pure walk + dispatch.
 *
 * Split across isolate-safe siblings: the activity proxies live in
 * `runnableActivities.ts`, the step executors in `runnableSteps.ts`, and the
 * step-record bounding and context spill in `runnableContext.ts`.
 */

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
    launchedById: input.request.launchedById,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    workflowId,
    workRequestId: input.request.workRequestId,
    // Epic children get their own ledger row from this activity (the gateway
    // wrote only the epic's). Absent for every other run, so their input is
    // unchanged.
    ...(input.request.parentWorkflowId
      ? { parentWorkflowId: input.request.parentWorkflowId, repoId: input.request.repoId ?? null }
      : {}),
  });
  if ('error' in runInfo) {
    // A plain Error here fails the workflow *task*, which Temporal retries
    // forever; a non-retryable ApplicationFailure fails the run once.
    throw ApplicationFailure.nonRetryable(
      `failed to load workflow template: ${runInfo.error}`,
      'WORKFLOW_RUN_SETUP_FAILED'
    );
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
    async dispatchShell({ node, inputs, cancellation, nodeId, specNodeId, stepAttempt }) {
      return runWithNodeTag(nodeTagOf(nodeId, specNodeId, stepAttempt), () =>
        runWithCancellation(cancellation, () =>
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
        )
      );
    },
    async dispatchStep({
      step,
      ctx,
      inputs,
      config,
      cancellation,
      nodeId,
      specNodeId,
      stepAttempt,
    }) {
      // Tag the activity this dispatch schedules with the node it runs for; the
      // outbound interceptor (nodeTagInterceptor.ts) turns it into a header.
      return runWithNodeTag(nodeTagOf(nodeId, specNodeId, stepAttempt), () =>
        runWithCancellation(cancellation, () =>
          dispatchStepImpl(step, ctx, input.request, config, inputs)
        )
      );
    },
    drainSteering() {
      // Drain (return + clear) so each agent node consumes only the steering
      // that arrived since the previous one.
      return steerBuffer.splice(0);
    },
    isCancellation(err) {
      return isCancellation(err);
    },
    async notifyHumanStep(args) {
      await stateActivities.createHumanStep({ ...args, runId });
    },
    patched(id) {
      return patched(id);
    },
    async recordStep(args) {
      // Activity inputs are written to history, and a step's inputs/outputs can
      // carry a whole diff or log — recorded again on every attempt. Bound what
      // goes through; the full values stay in the run context (spilled to
      // artifacts at finalization by `snapshotContext`).
      await stateActivities.recordWorkflowStep({
        ...args,
        ...(args.error !== undefined ? { error: boundString(args.error) } : {}),
        ...(args.inputs !== undefined ? { inputs: boundForRecord(args.inputs) } : {}),
        ...(args.outputs !== undefined ? { outputs: boundForRecord(args.outputs) } : {}),
        runId,
      });
    },
    async resolveHumanStep(args) {
      await stateActivities.resolveHumanStep({ ...args, runId });
    },
    async waitSignal(name, timeout, opts) {
      // No stale-payload reset here: a signal that lands before the interpreter
      // reaches its wait node (a CI webhook racing the PR-open step is the
      // common case) is kept and satisfies that wait. `take()` consumes the
      // payload, so a wait never sees a value an earlier wait already used.
      ensureSignalHandler(name);
      const received = await condition(() => slots.hasPending(name), timeout as Duration);
      // A wait the interpreter abandoned (block-mode cancelled its fan-out
      // branch) still resolves here when a payload arrives, because the
      // condition is not cancelled — that keeps the commands identical. It must
      // not take the payload a later wait on the same name is owed. `take()`
      // emits no command; the patch gates the payload staying in the slot.
      if (received && opts?.abandoned?.() && patched(ORPHANED_WAIT_PATCH)) {
        return undefined;
      }
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
    // A Temporal failure (an activity failure, a cancellation) keeps its own
    // meaning. Anything else — a blocking gate failure, a failed fan-out branch,
    // MAX_NODE_TRANSITIONS, an expression error, an executor guard — is a plain
    // Error, and a plain Error fails the workflow *task*, which Temporal
    // retries forever: the run would stay Running while its row says FAILED.
    // These failures are deterministic, so a retry can never succeed; fail the
    // run once instead. No `patched()` guard: the old path never completed (its
    // last workflow task kept failing), so no closed history records it, and an
    // open one stuck on it is exactly what this lets finish.
    if (runError instanceof TemporalFailure) {
      throw runError;
    }
    throw ApplicationFailure.nonRetryable(
      runError instanceof Error ? runError.message : String(runError),
      'WORKFLOW_SPEC_FAILED'
    );
  }

  // Spread result FIRST so a `status` key inside the terminate node's result
  // cannot overwrite the workflow's actual outcome status.
  const result = outcome?.result ?? {};
  return { ...result, status: finalStatus as WorkflowResult['status'] };
}

/** The attribution for one dispatch; undefined for a dispatcher caller that supplies no spec node. */
function nodeTagOf(
  recordingId: string,
  specNodeId: string | undefined,
  stepAttempt: number | undefined
): NodeTag | undefined {
  return specNodeId === undefined
    ? undefined
    : { recordingId, specNodeId, stepAttempt: stepAttempt ?? 1 };
}

/**
 * Cancellation bridge. When the interpreter passes a `cancellation` sink,
 * wrap the activity call in a `CancellationScope` and write a `cancel()`
 * callback into the sink so fan-out's block-mode can cancel the branch.
 * Without a sink we fall through to the bare callback (drain behavior).
 *
 * What `scope.cancel()` does and does not do: the workflow stops waiting on
 * the activity immediately (the default `TRY_CANCEL` cancellation type) and a
 * cancel REQUEST is recorded for it. It does not stop the activity. The
 * request reaches the worker only through the activity's next heartbeat, and
 * the activity stops only if it then observes `Context.cancellationSignal` —
 * see `lib/cancellation.ts`. The implementer, fix and merge-resolver loops
 * and `runAgent` do (they abort the in-flight LLM call and refuse to push);
 * an activity that neither heartbeats nor checks the signal runs to
 * completion in the background and its result is discarded.
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
  // The scope the branch runs in. When IT was cancelled — the whole run, not
  // just this branch — the cancellation is the run's, and must reach the
  // workflow as one so the run ends CANCELLED rather than FAILED.
  const parent = CancellationScope.current();
  const scope = new CancellationScope({ cancellable: true });
  cancellation.token = { cancel: () => scope.cancel() };
  try {
    return await scope.run(body);
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) {
      if (parent.consideredCancelled && patched(WORKFLOW_CANCEL_PATCH)) {
        throw err;
      }
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

/**
 * Patch ids. `WORKFLOW_CANCEL_PATCH` is the same literal the interpreter gates
 * its own cancellation handling on (`interpreter.ts`), so one marker decides
 * both halves for a run.
 */
const WORKFLOW_CANCEL_PATCH = 'workflow-cancel-propagates';
const ORPHANED_WAIT_PATCH = 'orphaned-signal-wait-keeps-payload';
