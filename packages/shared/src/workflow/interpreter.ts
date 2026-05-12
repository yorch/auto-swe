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
  Node,
  SetNode,
  SignalNode,
  StepNode,
  TerminateNode,
  WorkflowSpec,
} from './spec.js';

export interface Dispatcher {
  /** Invoke a step's activity. Returns the activity output, or throws on failure. */
  dispatchStep(args: {
    nodeId: string;
    step: string;
    config: Record<string, unknown>;
    inputs: Record<string, unknown>;
    ctx: Context;
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
}

export interface InterpreterResult {
  status: string;
  result: Record<string, unknown>;
  transitions: number;
  finalContext: Context;
}

export const DEFAULT_MAX_TRANSITIONS = 500;

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
  if (!('nodes' in ctx)) ctx.nodes = {};
  if (!('context' in ctx)) ctx.context = {};

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
  nodeIdPrefix: string
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
          currentNodeId = await runStep(recordingId, node, ctx, dispatcher);
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
      }
    } catch (err) {
      // Step nodes already record their own per-attempt FAILED rows (so the
      // workflow_steps table reflects each retry). Don't double-record here.
      if (node.type !== 'step') {
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
  dispatcher: Dispatcher
): Promise<string | undefined> {
  const config = node.config ?? {};
  const inputs: Record<string, unknown> = {};
  if (node.inputs) {
    for (const [k, b] of Object.entries(node.inputs)) {
      inputs[k] = resolveBinding(b, ctx);
    }
  }

  // A quality-gate step may also return { passed: false, ... } to signal a
  // logical failure without throwing. Treat that the same as a thrown error
  // under the configured onFail policy.
  const isGateFailure = (out: unknown): boolean =>
    typeof out === 'object' && out !== null && (out as { passed?: unknown }).passed === false;

  // onFail.retry: re-run the step up to N additional times before falling
  // back to terminal (block) semantics. Attempts are passed to recordStep so
  // each iteration shows up as its own row in workflow_steps.
  const maxAttempts =
    node.onFail && typeof node.onFail === 'object' && 'retry' in node.onFail
      ? node.onFail.retry + 1
      : 1;

  let lastError: unknown = null;
  let lastOutput: unknown = null;
  let lastFailedAsGate = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await dispatcher.dispatchStep({
        config,
        ctx,
        inputs,
        nodeId,
        step: node.step,
      });

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
        if (attempt < maxAttempts) continue;
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
      return node.next;
    } catch (err) {
      lastError = err;
      lastFailedAsGate = false;
      // Legacy onError: 'continue' wins — record SKIPPED and proceed.
      if (node.onError === 'continue') {
        await safeRecord(dispatcher, {
          attempt,
          error: err instanceof Error ? err.message : String(err),
          nodeId,
          status: 'SKIPPED',
        });
        setPath(ctx, `nodes.${nodeId}.output`, null);
        setPath(ctx, `nodes.${nodeId}.error`, String(err));
        return node.next;
      }
      // Record the failed attempt; retry if budget remains.
      await safeRecord(dispatcher, {
        attempt,
        error: err instanceof Error ? err.message : String(err),
        nodeId,
        status: 'FAILED',
      });
      if (attempt < maxAttempts) continue;
      // Fall through to terminal handling.
    }
  }

  // All attempts exhausted. Decide terminal mode from onFail (default block).
  const mode = node.onFail ?? 'block';
  const terminalBlock = mode === 'block' || (typeof mode === 'object' && 'retry' in mode);

  if (!terminalBlock) {
    // warn: surface the failure in context but continue.
    setPath(ctx, `nodes.${nodeId}.output`, lastOutput ?? null);
    if (lastError) setPath(ctx, `nodes.${nodeId}.error`, String(lastError));
    return node.next;
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
    if (typeof summary === 'string' && summary.length > 0) return summary;
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
  if (node.storeAs) setPath(ctx, node.storeAs, payload);
  setPath(ctx, `nodes.${nodeId}.output`, payload);
  await safeRecord(dispatcher, { nodeId, outputs: payload, status: 'PASSED' });
  return node.onReceive;
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
 * Phase-3 fan-out. Resolves `over` to an array, spawns one nested walk per
 * element using a sealed child context, then aggregates results into the
 * parent under `nodes.<fanOutId>.output`.
 *
 * Branches run sequentially; concurrency is reserved for the follow-up that
 * adds Promise.all-with-limit and tighter Temporal-history budgeting.
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
  const raw = resolveBinding(node.over, ctx);
  if (!Array.isArray(raw)) {
    throw new Error(
      `fanOut '${recordingId}': 'over' must resolve to an array (got ${describeOperand(raw)})`
    );
  }

  await safeRecord(dispatcher, {
    inputs: { count: raw.length, itemKey: node.itemKey, over: summarizeForRecord(raw) },
    nodeId: recordingId,
    status: 'RUNNING',
  });

  const results: Array<{
    status: string;
    result: Record<string, unknown>;
    exports?: Record<string, unknown>;
    error?: string;
  }> = [];
  let failed = 0;
  let succeeded = 0;
  let firstError: unknown = null;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const branchPrefix = `${parentPrefix}${nodeId}[${i}]/`;
    const childCtx = makeChildContext(ctx, node.itemKey, item, i);

    try {
      const outcome = await walk(spec, node.subgraph, childCtx, dispatcher, cursor, branchPrefix);
      const exports = collectExports(node.exports, childCtx);
      const entry: (typeof results)[number] = {
        ...(exports ? { exports } : {}),
        result: outcome.result,
        status: outcome.status,
      };
      results.push(entry);
      if (outcome.status === 'SUCCESS') {
        succeeded++;
      } else {
        failed++;
        // A branch that reaches `terminate { status: !== 'SUCCESS' }` never
        // throws, so we need to surface the failure here for onBranchFail:'block'.
        if (firstError === null) {
          firstError = new Error(
            `fanOut '${recordingId}' branch ${i} terminated with status ${outcome.status}`
          );
        }
        if (node.onBranchFail === 'block') break;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ error: msg, result: {}, status: 'FAILED' });
      if (firstError === null) firstError = err;
      if (node.onBranchFail === 'block') break;
    }
  }

  const aggregate: {
    count: number;
    failed: number;
    plucked?: unknown[];
    results: typeof results;
    succeeded: number;
  } = {
    count: raw.length,
    failed,
    results,
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
  if (!paths || paths.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    out[p] = lookupPath(childCtx, p);
  }
  return out;
}

/** Don't dump giant arrays into workflow_steps.inputs; record a length-only summary. */
function summarizeForRecord(arr: unknown[]): unknown {
  if (arr.length <= 4) return arr;
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

const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function setPath(ctx: Context, path: string, value: unknown): void {
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
