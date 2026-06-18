/**
 * Pure interpreter for WorkflowSpec — has no external runtime imports so it
 * can be loaded by both Temporal workflow code (V8 isolate) and tests.
 *
 * Side effects (running activities, awaiting signals, persisting step rows)
 * are abstracted behind the {@link Dispatcher} interface. The actual
 * Temporal-backed dispatcher lives in packages/worker/src/workflows/runnable.ts.
 */

import type { Context } from './expr.js';
import { describeOperand, evalBoolean, lookupPath, resolveBinding } from './expr.js';
import type {
  CondNode,
  FanOutNode,
  HumanApprovalNode,
  HumanDecisionNode,
  HumanInputNode,
  HumanReviewNode,
  Node,
  SetNode,
  ShellNode,
  SignalNode,
  StepNode,
  TerminateNode,
  WorkflowSpec,
} from './spec.js';

/**
 * A cancellation scope passed into `dispatchStep` / `dispatchShell`. Workflow
 * runtimes that support cooperative cancellation (Temporal) wrap each activity
 * call in a scope and expose `cancel()` here; the fan-out walker calls it on
 * sibling branches when `onBranchFail: 'block'` fires.
 *
 * Dispatchers that don't support cancellation can omit the field — the
 * interpreter falls back to "let in-flight work drain" (the pre-phase-8 behavior).
 */
export interface CancellationToken {
  cancel(): void;
}

/**
 * Thrown by a dispatcher when its activity was cancelled via the
 * {@link CancellationToken} the interpreter handed it. The interpreter
 * recognizes this class in `runRetryable` and rethrows immediately, bypassing
 * `onError` / `onFail` retry+warn policies — otherwise a sibling branch could
 * `onFail: 'warn'`-swallow a cancellation that block-mode raised on it and
 * keep running after another branch had already failed.
 */
export class BranchCancelledError extends Error {
  // Tag for cross-realm instanceof safety (Temporal workflows run in V8
  // isolates so the imported class identity can drift).
  readonly __branchCancelled = true as const;
  constructor(message = 'fan-out branch cancelled by sibling failure (block-mode)') {
    super(message);
    this.name = 'BranchCancelledError';
  }
}

function isBranchCancelled(err: unknown): boolean {
  return (
    err instanceof BranchCancelledError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { __branchCancelled?: unknown }).__branchCancelled === true)
  );
}

export interface DispatchArgs {
  nodeId: string;
  step?: string;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  ctx: Context;
  /**
   * Set when the dispatch happens inside a fan-out branch. The interpreter
   * registers a {@link CancellationToken} into this object before awaiting
   * the dispatch promise; the dispatcher should write back a cancel handle
   * (or leave it undefined when cancellation isn't supported).
   */
  cancellation?: { token?: CancellationToken };
}

export interface Dispatcher {
  /** Invoke a step's activity. Returns the activity output, or throws on failure. */
  dispatchStep(args: {
    nodeId: string;
    step: string;
    config: Record<string, unknown>;
    inputs: Record<string, unknown>;
    ctx: Context;
    cancellation?: { token?: CancellationToken };
  }): Promise<unknown>;

  /**
   * Run a user-authored shell node in an ephemeral container. Returns the
   * activity output (a `{passed, summary, exitCode, ...}` shape compatible
   * with the gate-failure branch in {@link runStep}) or throws on a runtime
   * failure (image-not-allowed, container-spawn-error, etc.).
   *
   * Optional — interpreters that don't support phase-6 shell nodes may throw
   * "shell node type is not supported by this dispatcher" if they encounter
   * one.
   */
  dispatchShell?(args: {
    nodeId: string;
    node: ShellNode;
    inputs: Record<string, unknown>;
    ctx: Context;
    cancellation?: { token?: CancellationToken };
  }): Promise<unknown>;

  /**
   * Wait for a named signal. Returns the payload (any value, including null/0/false)
   * or `undefined` on timeout.
   */
  waitSignal(name: string, timeout: string): Promise<unknown | undefined>;

  /** Record a step's outcome (best-effort; failures here must not throw). */
  recordStep(args: {
    nodeId: string;
    status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
    inputs?: unknown;
    outputs?: unknown;
    error?: string;
    attempt?: number;
  }): Promise<void>;

  /**
   * Create a pending human step record in the DB and send notifications.
   * Optional — test dispatchers that don't need DB access can skip it.
   * Returns after the DB record is created (best-effort; Slack failure is swallowed).
   */
  notifyHumanStep?(args: {
    nodeId: string;
    signalName: string;
    kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
    title: string;
    description?: string;
    context?: unknown;
    options?: Array<{ label: string; value: string }>;
    fields?: Array<{
      key: string;
      label: string;
      type: string;
      required?: boolean;
      options?: string[];
    }>;
    /** Raw timeout duration string from the node spec (e.g. "24h", "30m"). */
    timeout?: string;
  }): Promise<void>;

  /**
   * Mark a pending human step record as TIMED_OUT in the DB.
   * Called when the HITL node times out. Optional — test dispatchers may skip it.
   */
  resolveHumanStep?(args: { nodeId: string; status: 'TIMED_OUT' }): Promise<void>;
}

export interface InterpreterResult {
  status: string;
  result: Record<string, unknown>;
  transitions: number;
  finalContext: Context;
}

export const DEFAULT_MAX_TRANSITIONS = 500;

/** Maps HITL node type names to their DB enum kind values. */
export const HITL_KINDS = {
  humanApproval: 'APPROVAL',
  humanDecision: 'DECISION',
  humanInput: 'INPUT',
  humanReview: 'REVIEW',
} as const;

export type HitlKind = (typeof HITL_KINDS)[keyof typeof HITL_KINDS];

/**
 * Valid `action` values per HITL kind. Used by the gateway respond endpoint to
 * validate incoming responses before writing to the DB and signalling Temporal.
 * Keeping this alongside HITL_KINDS ensures the two stay in sync — a new kind
 * added here must also get a valid-actions entry or TypeScript will error.
 */
export const HITL_VALID_ACTIONS: Record<HitlKind, readonly string[]> = {
  APPROVAL: ['approve', 'reject'],
  DECISION: ['select'],
  INPUT: ['submit'],
  REVIEW: ['submit'],
};

/**
 * Default per-fanOut concurrency cap when a spec doesn't supply one. Bounded
 * to avoid swamping LLM providers when a planner returns the maximum
 * subtask count — operators can raise this per-node via `fanOut.concurrency`.
 */
export const DEFAULT_FANOUT_CONCURRENCY = 4;

/** Outcome of a single branch walk (used by fanOut). */
interface BranchOutcome {
  status: string;
  result: Record<string, unknown>;
  exports: Record<string, unknown> | undefined;
}

/**
 * Shared transition counter passed down into nested walks (fanOut branches)
 * so the maxTransitions cap is enforced across the whole run, not per-branch.
 */
interface Cursor {
  count: number;
  cap: number;
}

export async function runSpec(
  spec: WorkflowSpec,
  initialContext: Context,
  dispatcher: Dispatcher,
  maxTransitions = DEFAULT_MAX_TRANSITIONS
): Promise<InterpreterResult> {
  const ctx: Context = { ...initialContext };
  if (!('nodes' in ctx)) {
    ctx.nodes = {};
  }
  if (!('context' in ctx)) {
    ctx.context = {};
  }

  const cursor: Cursor = { cap: maxTransitions, count: 0 };
  const outcome = await walk(spec, spec.entry, ctx, dispatcher, cursor, '');

  return {
    finalContext: ctx,
    result: outcome.result,
    status: outcome.status,
    transitions: cursor.count,
  };
}

/**
 * Walk the spec from `entry` until a terminate node is reached. Nested
 * invocations (fan-out branches) pass a non-empty `nodeIdPrefix` so the
 * branch's step records show up disambiguated in workflow_steps; the prefix
 * also marks the call as "branch-local," which the caller uses to distinguish
 * a branch-terminate from a workflow-terminate by the returned status alone.
 */
async function walk(
  spec: WorkflowSpec,
  entry: string,
  ctx: Context,
  dispatcher: Dispatcher,
  cursor: Cursor,
  nodeIdPrefix: string,
  cancellationSink?: { token?: CancellationToken }
): Promise<BranchOutcome> {
  let currentNodeId: string | undefined = entry;
  let terminal: { status: string; result: Record<string, unknown> } | null = null;

  while (currentNodeId) {
    if (++cursor.count > cursor.cap) {
      throw new Error(
        `workflow exceeded MAX_NODE_TRANSITIONS (${cursor.cap}) — likely an infinite loop in spec '${spec.name}'`
      );
    }
    const node: Node | undefined = spec.nodes[currentNodeId];
    if (!node) {
      throw new Error(`unknown node id: ${currentNodeId}`);
    }
    const nodeId = currentNodeId;
    const recordingId = nodeIdPrefix ? `${nodeIdPrefix}${nodeId}` : nodeId;

    try {
      switch (node.type) {
        case 'step': {
          currentNodeId = await runStep(recordingId, node, ctx, dispatcher, cancellationSink);
          break;
        }
        case 'agent': {
          currentNodeId = await runAgentNode(recordingId, node, ctx, dispatcher, cancellationSink);
          break;
        }
        case 'mcp': {
          currentNodeId = await runMcpNode(recordingId, node, ctx, dispatcher, cancellationSink);
          break;
        }
        case 'containerStep': {
          currentNodeId = await runContainerStep(
            recordingId,
            node,
            ctx,
            dispatcher,
            cancellationSink
          );
          break;
        }
        case 'set': {
          currentNodeId = runSet(node, ctx);
          break;
        }
        case 'cond': {
          currentNodeId = runCond(node, ctx);
          break;
        }
        case 'signal': {
          currentNodeId = await runSignal(recordingId, node, ctx, dispatcher);
          break;
        }
        case 'terminate': {
          terminal = runTerminate(node, ctx);
          currentNodeId = undefined;
          break;
        }
        case 'fanOut': {
          currentNodeId = await runFanOut(
            recordingId,
            nodeId,
            node,
            spec,
            ctx,
            dispatcher,
            cursor,
            nodeIdPrefix
          );
          break;
        }
        case 'shell': {
          currentNodeId = await runShell(recordingId, node, ctx, dispatcher, cancellationSink);
          break;
        }
        case 'humanApproval':
        case 'humanDecision':
        case 'humanInput':
        case 'humanReview': {
          currentNodeId = await runHumanNode(recordingId, nodeId, node, ctx, dispatcher);
          break;
        }
      }
    } catch (err) {
      // step + shell nodes already record their own per-attempt FAILED rows
      // (so workflow_steps table reflects each retry). Don't double-record.
      if (node.type !== 'step' && node.type !== 'shell') {
        await safeRecord(dispatcher, {
          error: err instanceof Error ? err.message : String(err),
          nodeId: recordingId,
          status: 'FAILED',
        });
      }
      throw err;
    }
  }

  return {
    exports: undefined,
    result: terminal?.result ?? {},
    status: terminal?.status ?? 'SUCCESS',
  };
}

async function runStep(
  nodeId: string,
  node: StepNode,
  ctx: Context,
  dispatcher: Dispatcher,
  cancellationSink?: { token?: CancellationToken }
): Promise<string | undefined> {
  const config = node.config ?? {};
  const inputs = resolveInputs(node.inputs, ctx);
  return runRetryable({
    ctx,
    dispatcher,
    inputs,
    invoke: () =>
      dispatcher.dispatchStep({
        ...(cancellationSink ? { cancellation: cancellationSink } : {}),
        config,
        ctx,
        inputs,
        nodeId,
        step: node.step,
      }),
    next: node.next,
    nodeId,
    onError: node.onError,
    onFail: node.onFail,
  });
}

async function runAgentNode(
  nodeId: string,
  node: import('./spec.js').AgentNode,
  ctx: Context,
  dispatcher: Dispatcher,
  cancellationSink?: { token?: CancellationToken }
): Promise<string | undefined> {
  const inputs = resolveInputs(node.inputs, ctx);
  // Pack the agent-node fields into the step config; the worker's `runAgentNode`
  // executor resolves agentRef → resolveAgentSpec → runAgent. Dispatching
  // through the same step path means retry/onFail/recording behave identically
  // to a step node, and the agent output lands at `nodes.<id>.output`.
  const config: Record<string, unknown> = { agentRef: node.agentRef };
  if (node.userMessage !== undefined) {
    config.userMessage = node.userMessage;
  }
  if (node.spanName !== undefined) {
    config.spanName = node.spanName;
  }
  if (node.systemPrompt !== undefined) {
    config.systemPrompt = node.systemPrompt;
  }
  return runRetryable({
    ctx,
    dispatcher,
    inputs,
    invoke: () =>
      dispatcher.dispatchStep({
        ...(cancellationSink ? { cancellation: cancellationSink } : {}),
        config,
        ctx,
        inputs,
        nodeId,
        step: 'runAgentNode',
      }),
    next: node.next,
    nodeId,
    onError: node.onError,
    onFail: node.onFail,
  });
}

async function runMcpNode(
  nodeId: string,
  node: import('./spec.js').McpNode,
  ctx: Context,
  dispatcher: Dispatcher,
  cancellationSink?: { token?: CancellationToken }
): Promise<string | undefined> {
  const inputs = resolveInputs(node.inputs, ctx);
  // Pack the mcp-node fields into the step config; the worker's `mcpCallTool`
  // executor resolves connectionRef → mcp server URL, loads the named tool, and
  // calls it with the resolved inputs. Dispatching through the same step path
  // gives identical retry/onFail/recording; the result lands at `nodes.<id>.output`.
  const config: Record<string, unknown> = { connectionRef: node.connectionRef, tool: node.tool };
  if (node.spanName !== undefined) {
    config.spanName = node.spanName;
  }
  return runRetryable({
    ctx,
    dispatcher,
    inputs,
    invoke: () =>
      dispatcher.dispatchStep({
        ...(cancellationSink ? { cancellation: cancellationSink } : {}),
        config,
        ctx,
        inputs,
        nodeId,
        step: 'mcpCallTool',
      }),
    next: node.next,
    nodeId,
    onError: node.onError,
    onFail: node.onFail,
  });
}

async function runContainerStep(
  nodeId: string,
  node: import('./spec.js').ContainerStepNode,
  ctx: Context,
  dispatcher: Dispatcher,
  cancellationSink?: { token?: CancellationToken }
): Promise<string | undefined> {
  const inputs = resolveInputs(node.inputs, ctx);
  // Pack the container-contract fields into the step config; the worker's
  // `runContainerStep` executor runs the image (ephemeral sandbox) with the
  // inputs as JSON env and binds parsed stdout JSON at `nodes.<id>.output`.
  const config: Record<string, unknown> = { image: node.image };
  if (node.command !== undefined) {
    config.command = node.command;
  }
  if (node.network !== undefined) {
    config.network = node.network;
  }
  if (node.memory !== undefined) {
    config.memory = node.memory;
  }
  if (node.cpus !== undefined) {
    config.cpus = node.cpus;
  }
  if (node.timeoutMs !== undefined) {
    config.timeoutMs = node.timeoutMs;
  }
  if (node.transport !== undefined) {
    config.transport = node.transport;
  }
  if (node.sidecar !== undefined) {
    config.sidecar = node.sidecar;
  }
  return runRetryable({
    ctx,
    dispatcher,
    inputs,
    invoke: () =>
      dispatcher.dispatchStep({
        ...(cancellationSink ? { cancellation: cancellationSink } : {}),
        config,
        ctx,
        inputs,
        nodeId,
        step: 'runContainerStep',
      }),
    next: node.next,
    nodeId,
    onError: node.onError,
    onFail: node.onFail,
  });
}

async function runShell(
  nodeId: string,
  node: ShellNode,
  ctx: Context,
  dispatcher: Dispatcher,
  cancellationSink?: { token?: CancellationToken }
): Promise<string | undefined> {
  if (!dispatcher.dispatchShell) {
    throw new Error(
      `shell node '${nodeId}' encountered but this dispatcher has no dispatchShell handler`
    );
  }
  const inputs = resolveInputs(node.inputs, ctx);
  const dispatchShell = dispatcher.dispatchShell.bind(dispatcher);
  return runRetryable({
    ctx,
    dispatcher,
    inputs,
    invoke: () =>
      dispatchShell({
        ...(cancellationSink ? { cancellation: cancellationSink } : {}),
        ctx,
        inputs,
        node,
        nodeId,
      }),
    next: node.next,
    nodeId,
    onError: node.onError,
    onFail: node.onFail,
  });
}

function resolveInputs(
  map: Record<string, import('./spec.js').Binding> | undefined,
  ctx: Context
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (!map) {
    return inputs;
  }
  for (const [k, b] of Object.entries(map)) {
    inputs[k] = resolveBinding(b, ctx);
  }
  return inputs;
}

/**
 * Shared retry + onFail policy for step and shell nodes. Both accept the same
 * gate-style failure contract (`{ passed: false, summary }` on the output) and
 * react to thrown errors the same way; only the activity-invocation differs.
 */
async function runRetryable(args: {
  nodeId: string;
  inputs: Record<string, unknown>;
  ctx: Context;
  invoke: () => Promise<unknown>;
  next: string | undefined;
  onFail: StepNode['onFail'];
  onError: StepNode['onError'];
  dispatcher: Dispatcher;
}): Promise<string | undefined> {
  const { nodeId, inputs, ctx, invoke, next, onFail, onError, dispatcher } = args;

  // A quality-gate / shell-step may return { passed: false, ... } to signal a
  // logical failure without throwing. Treat that the same as a thrown error
  // under the configured onFail policy.
  const isGateFailure = (out: unknown): boolean =>
    typeof out === 'object' && out !== null && (out as { passed?: unknown }).passed === false;

  // onFail.retry: re-run the step up to N additional times before falling
  // back to terminal (block) semantics. Attempts are passed to recordStep so
  // each iteration shows up as its own row in workflow_steps.
  const maxAttempts =
    onFail && typeof onFail === 'object' && 'retry' in onFail ? onFail.retry + 1 : 1;

  let lastError: unknown = null;
  let lastOutput: unknown = null;
  let lastFailedAsGate = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await invoke();

      if (isGateFailure(output)) {
        lastOutput = output;
        lastFailedAsGate = true;
        await safeRecord(dispatcher, {
          attempt,
          error: gateFailureMessage(output),
          inputs,
          nodeId,
          outputs: output,
          status: 'FAILED',
        });
        if (attempt < maxAttempts) {
          continue;
        }
        break;
      }

      setPath(ctx, `nodes.${nodeId}.output`, output);
      await safeRecord(dispatcher, {
        attempt,
        inputs,
        nodeId,
        outputs: output,
        status: 'PASSED',
      });
      return next;
    } catch (err) {
      // Cancellation bypasses onError + onFail entirely — block-mode fan-out
      // raised it on this branch and the worker pool already recorded the
      // originating failure.
      if (isBranchCancelled(err)) {
        await safeRecord(dispatcher, {
          attempt,
          error: err instanceof Error ? err.message : String(err),
          nodeId,
          status: 'FAILED',
        });
        throw err;
      }
      lastError = err;
      lastFailedAsGate = false;
      // Legacy onError: 'continue' wins — record SKIPPED and proceed.
      if (onError === 'continue') {
        await safeRecord(dispatcher, {
          attempt,
          error: err instanceof Error ? err.message : String(err),
          nodeId,
          status: 'SKIPPED',
        });
        setPath(ctx, `nodes.${nodeId}.output`, null);
        setPath(ctx, `nodes.${nodeId}.error`, String(err));
        return next;
      }
      // Record the failed attempt; retry if budget remains.
      await safeRecord(dispatcher, {
        attempt,
        error: err instanceof Error ? err.message : String(err),
        nodeId,
        status: 'FAILED',
      });
      if (attempt < maxAttempts) {
      }
      // Fall through to terminal handling.
    }
  }

  // All attempts exhausted. Decide terminal mode from onFail (default block).
  const mode = onFail ?? 'block';
  const terminalBlock = mode === 'block' || (typeof mode === 'object' && 'retry' in mode);

  if (!terminalBlock) {
    // warn: surface the failure in context but continue.
    setPath(ctx, `nodes.${nodeId}.output`, lastOutput ?? null);
    if (lastError) {
      setPath(ctx, `nodes.${nodeId}.error`, String(lastError));
    }
    return next;
  }

  if (lastFailedAsGate) {
    setPath(ctx, `nodes.${nodeId}.output`, lastOutput);
    throw new Error(gateFailureMessage(lastOutput));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function gateFailureMessage(output: unknown): string {
  if (typeof output === 'object' && output !== null) {
    const summary = (output as { summary?: unknown }).summary;
    if (typeof summary === 'string' && summary.length > 0) {
      return summary;
    }
  }
  return 'step returned passed=false';
}

function runSet(node: SetNode, ctx: Context): string | undefined {
  for (const [path, binding] of Object.entries(node.values)) {
    setPath(ctx, path, resolveBinding(binding, ctx));
  }
  return node.next;
}

function runCond(node: CondNode, ctx: Context): string {
  return evalBoolean(node.expr, ctx) ? node.onTrue : node.onFalse;
}

async function runSignal(
  nodeId: string,
  node: SignalNode,
  ctx: Context,
  dispatcher: Dispatcher
): Promise<string> {
  const payload = await dispatcher.waitSignal(node.name, node.timeout);
  if (payload === undefined) {
    await safeRecord(dispatcher, { nodeId, status: 'SKIPPED' });
    return node.onTimeout;
  }
  if (node.storeAs) {
    setPath(ctx, node.storeAs, payload);
  }
  setPath(ctx, `nodes.${nodeId}.output`, payload);
  await safeRecord(dispatcher, { nodeId, outputs: payload, status: 'PASSED' });
  return node.onReceive;
}

async function runHumanNode(
  recordingId: string,
  specNodeId: string,
  node: HumanApprovalNode | HumanDecisionNode | HumanInputNode | HumanReviewNode,
  ctx: Context,
  dispatcher: Dispatcher
): Promise<string | undefined> {
  // Signal name must use the unprefixed spec key so it matches the handler
  // registered at workflow startup (which iterates spec.nodes keys directly).
  // Inside a fanOut branch, recordingId carries a prefix but the Temporal
  // signal handler was registered under `hitl_${specNodeId}`.
  const signalName = `hitl_${specNodeId}`;
  const kind = HITL_KINDS[node.type];

  // Snapshot context if specified
  const contextData =
    'contextFrom' in node && node.contextFrom ? lookupPath(ctx, node.contextFrom) : undefined;
  const contentData = node.type === 'humanReview' ? lookupPath(ctx, node.contentFrom) : undefined;

  // Record the pending state before waiting
  await safeRecord(dispatcher, { nodeId: recordingId, status: 'PENDING' });

  // Notify — creates DB record + Slack. Best-effort: don't let notification
  // failure block the workflow; the step is already recorded as PENDING.
  const { notifyHumanStep } = dispatcher;
  await safeDispatch(
    notifyHumanStep
      ? () =>
          notifyHumanStep({
            context: contextData ?? contentData,
            description: node.description,
            fields: node.type === 'humanInput' ? node.fields : undefined,
            kind,
            nodeId: specNodeId,
            options:
              node.type === 'humanDecision'
                ? node.options.map((o) => ({ label: o.label, value: o.value }))
                : undefined,
            signalName,
            timeout: node.timeout,
            title: node.title,
          })
      : undefined
  );

  // Wait for human response
  const payload = await dispatcher.waitSignal(signalName, node.timeout);

  if (payload === undefined) {
    // Timed out — update the step record, mark the DB row, and route to timeout path
    await safeRecord(dispatcher, { nodeId: recordingId, status: 'SKIPPED' });
    const { resolveHumanStep } = dispatcher;
    await safeDispatch(
      resolveHumanStep
        ? () => resolveHumanStep({ nodeId: specNodeId, status: 'TIMED_OUT' })
        : undefined
    );
    return node.onTimeout;
  }

  // Store result in context if requested
  const storeAs = 'storeAs' in node ? node.storeAs : undefined;
  if (storeAs) {
    setPath(ctx, storeAs, payload);
  }
  setPath(ctx, `nodes.${specNodeId}.output`, payload);
  await safeRecord(dispatcher, { nodeId: recordingId, outputs: payload, status: 'PASSED' });

  // Route based on node type
  const p = payload as { action?: string; value?: unknown };
  if (node.type === 'humanApproval') {
    return p.action === 'reject' ? node.onReject : node.onApprove;
  }
  if (node.type === 'humanDecision') {
    const chosen = node.options.find((o) => o.value === p.value);
    return chosen?.next ?? node.onTimeout;
  }
  // humanInput + humanReview
  return node.onSubmit;
}

function runTerminate(
  node: TerminateNode,
  ctx: Context
): { status: string; result: Record<string, unknown> } {
  const result: Record<string, unknown> = {};
  if (node.result) {
    for (const [k, b] of Object.entries(node.result)) {
      result[k] = resolveBinding(b, ctx);
    }
  }
  return { result, status: node.status };
}

/**
 * Fan-out: resolve `over` to an array, run the subgraph once per element in
 * a sealed child context, aggregate results into `nodes.<fanOutId>.output`.
 *
 * Branches run through a `concurrency`-bounded worker pool (default
 * {@link DEFAULT_FANOUT_CONCURRENCY}). `onBranchFail: 'block'` stops
 * scheduling new branches but lets in-flight ones drain — Temporal activity
 * cancellation isn't plumbed through the dispatcher, so we can't abort
 * mid-flight without losing replay determinism.
 *
 * Determinism: Temporal workflows run on a single-threaded event loop, so
 * the worker pool's shared `nextIndex` counter and `Promise.all` of N
 * workers produce a fully deterministic activity-scheduling order.
 */
async function runFanOut(
  recordingId: string,
  nodeId: string,
  node: FanOutNode,
  spec: WorkflowSpec,
  ctx: Context,
  dispatcher: Dispatcher,
  cursor: Cursor,
  parentPrefix: string
): Promise<string> {
  const resolved = resolveBinding(node.over, ctx);
  if (!Array.isArray(resolved)) {
    throw new Error(
      `fanOut '${recordingId}': 'over' must resolve to an array (got ${describeOperand(resolved)})`
    );
  }
  const raw: unknown[] = resolved;

  const concurrency = Math.max(1, node.concurrency ?? DEFAULT_FANOUT_CONCURRENCY);

  await safeRecord(dispatcher, {
    inputs: {
      concurrency,
      count: raw.length,
      itemKey: node.itemKey,
      over: summarizeForRecord(raw),
    },
    nodeId: recordingId,
    status: 'RUNNING',
  });

  type Entry = {
    status: string;
    result: Record<string, unknown>;
    exports?: Record<string, unknown>;
    error?: string;
  };

  // Pre-allocated by index so the aggregate preserves item order regardless
  // of completion order. Holes (un-scheduled branches when block fires) are
  // filtered out at the end.
  const slots: Array<Entry | undefined> = new Array(raw.length);
  // Phase-8: each in-flight branch gets a cancellation sink. Dispatchers that
  // don't support cancellation leave `token` undefined, in which case
  // `cancelAllExcept` is a no-op (pre-phase-8 drain behavior).
  const branchSinks = new Map<number, { token?: CancellationToken }>();
  let firstError: unknown = null;
  let nextIndex = 0;
  let stop = false;

  function cancelAllExcept(exceptIndex: number): void {
    for (const [idx, sink] of branchSinks.entries()) {
      if (idx === exceptIndex) {
        continue;
      }
      if (sink.token) {
        try {
          sink.token.cancel();
        } catch {
          // Cancellation is best-effort; a cancel-throw shouldn't fail
          // the whole fan-out beyond the original block trigger.
        }
      }
    }
  }

  async function worker(): Promise<void> {
    while (!stop) {
      const i = nextIndex++;
      if (i >= raw.length) {
        return;
      }
      const item = raw[i];
      const branchPrefix = `${parentPrefix}${nodeId}[${i}]/`;
      const childCtx = makeChildContext(ctx, node.itemKey, item, i);
      const sink: { token?: CancellationToken } = {};
      branchSinks.set(i, sink);

      try {
        const outcome = await walk(
          spec,
          node.subgraph,
          childCtx,
          dispatcher,
          cursor,
          branchPrefix,
          sink
        );
        const exports = collectExports(node.exports, childCtx);
        slots[i] = {
          ...(exports ? { exports } : {}),
          result: outcome.result,
          status: outcome.status,
        };
        if (outcome.status !== 'SUCCESS') {
          // A branch that terminates non-SUCCESS never throws — surface it
          // here so onBranchFail:'block' still fires.
          firstError ??= new Error(
            `fanOut '${recordingId}' branch ${i} terminated with status ${outcome.status}`
          );
          if (node.onBranchFail === 'block') {
            stop = true;
            cancelAllExcept(i);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        slots[i] = { error: msg, result: {}, status: 'FAILED' };
        firstError ??= err;
        if (node.onBranchFail === 'block') {
          stop = true;
          cancelAllExcept(i);
        }
      } finally {
        branchSinks.delete(i);
      }
    }
  }

  const workerCount = Math.min(concurrency, raw.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Drop holes (branches that block-mode skipped) but preserve index order
  // for everything that did run.
  const results: Entry[] = [];
  for (const slot of slots) {
    if (slot !== undefined) {
      results.push(slot);
    }
  }
  const succeeded = results.filter((r) => r.status === 'SUCCESS').length;
  const failed = results.length - succeeded;
  const skipped = raw.length - results.length;

  const aggregate: {
    count: number;
    failed: number;
    plucked?: unknown[];
    results: Entry[];
    skipped: number;
    succeeded: number;
  } = {
    count: raw.length,
    failed,
    results,
    skipped,
    succeeded,
  };
  if (node.pluck) {
    aggregate.plucked = results.map((r) => lookupPath(r, node.pluck as string) ?? null);
  }
  setPath(ctx, `nodes.${nodeId}.output`, aggregate);

  if (firstError !== null && node.onBranchFail === 'block') {
    await safeRecord(dispatcher, {
      error: firstError instanceof Error ? firstError.message : String(firstError),
      nodeId: recordingId,
      outputs: aggregate,
      status: 'FAILED',
    });
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  await safeRecord(dispatcher, {
    nodeId: recordingId,
    outputs: aggregate,
    status: 'PASSED',
  });
  return node.join;
}

/**
 * Build a sealed child context for a fan-out branch:
 *   - clone `request` / `workflow` references so the branch can read them
 *   - fresh `nodes` and `context` so branch-local writes never leak into the
 *     parent (only `exports` flow back, at join time)
 *   - inject `<itemKey>` and `<itemKey>Index` for the subgraph to bind to
 */
function makeChildContext(parent: Context, itemKey: string, item: unknown, index: number): Context {
  const child: Context = {
    [itemKey]: item,
    [`${itemKey}Index`]: index,
    context: { ...((parent.context as Record<string, unknown> | undefined) ?? {}) },
    nodes: {},
    request: parent.request,
    workflow: parent.workflow,
  };
  return child;
}

function collectExports(
  paths: readonly string[] | undefined,
  childCtx: Context
): Record<string, unknown> | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    out[p] = lookupPath(childCtx, p);
  }
  return out;
}

/** Don't dump giant arrays into workflow_steps.inputs; record a length-only summary. */
function summarizeForRecord(arr: unknown[]): unknown {
  if (arr.length <= 4) {
    return arr;
  }
  return { length: arr.length, sample: arr.slice(0, 2) };
}

async function safeRecord(
  dispatcher: Dispatcher,
  args: Parameters<Dispatcher['recordStep']>[0]
): Promise<void> {
  try {
    await dispatcher.recordStep(args);
  } catch {
    // Recording is best-effort; do not let DB hiccups poison the workflow.
  }
}

/** Call an optional dispatcher hook best-effort — failures must not abort the workflow. */
async function safeDispatch(fn: (() => Promise<void>) | undefined): Promise<void> {
  if (!fn) {
    return;
  }
  try {
    await fn();
  } catch {
    // best-effort
  }
}

const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function setPath(ctx: Context, path: string, value: unknown): void {
  // NB: write paths are split on '.' only — bracket notation (`a[0]`, `a["k"]`)
  // that `lookupPath` understands for reads is NOT interpreted here. A path
  // segment may legitimately contain brackets (fanOut branch node ids look like
  // `fan[0]/echo`), so those are treated as a single literal key, by design.
  const parts = path.split('.');
  for (const seg of parts) {
    if (RESERVED_SEGMENTS.has(seg)) {
      // Specs are team-authored JSON; in phase 6 they'll be user-authored
      // shell-step configs. Refuse to write through prototype-pollution
      // segments regardless of source so an attacker who slips a crafted
      // spec past validation cannot corrupt subsequent workflow execution.
      throw new Error(`setPath: refusing to write through reserved segment '${seg}' in '${path}'`);
    }
  }
  let cur: Record<string, unknown> = ctx as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (cur[k] == null || typeof cur[k] !== 'object') {
      // Use a null-prototype object so even if a future code path bypasses
      // the segment check above, there's no prototype to walk into.
      cur[k] = Object.create(null) as Record<string, unknown>;
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

export { lookupPath };
