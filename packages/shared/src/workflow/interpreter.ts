/**
 * Pure interpreter for WorkflowSpec — has no external runtime imports so it
 * can be loaded by both Temporal workflow code (V8 isolate) and tests.
 *
 * Side effects (running activities, awaiting signals, persisting step rows)
 * are abstracted behind the {@link Dispatcher} interface. The actual
 * Temporal-backed dispatcher lives in packages/worker/src/workflows/runnable.ts.
 */

import type { Context } from './expr.js';
import { evalBoolean, lookupPath, resolveBinding } from './expr.js';
import type {
  CondNode,
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

export async function runSpec(
  spec: WorkflowSpec,
  initialContext: Context,
  dispatcher: Dispatcher,
  maxTransitions = DEFAULT_MAX_TRANSITIONS
): Promise<InterpreterResult> {
  const ctx: Context = { ...initialContext };
  if (!('nodes' in ctx)) ctx.nodes = {};
  if (!('context' in ctx)) ctx.context = {};

  let currentNodeId: string | undefined = spec.entry;
  let transitions = 0;
  let terminal: { status: string; result: Record<string, unknown> } | null = null;

  while (currentNodeId) {
    if (++transitions > maxTransitions) {
      throw new Error(
        `workflow exceeded MAX_NODE_TRANSITIONS (${maxTransitions}) — likely an infinite loop in spec '${spec.name}'`
      );
    }
    const node: Node | undefined = spec.nodes[currentNodeId];
    if (!node) {
      throw new Error(`unknown node id: ${currentNodeId}`);
    }
    const nodeId = currentNodeId;

    try {
      switch (node.type) {
        case 'step': {
          currentNodeId = await runStep(nodeId, node, ctx, dispatcher);
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
          currentNodeId = await runSignal(nodeId, node, ctx, dispatcher);
          break;
        }
        case 'terminate': {
          terminal = runTerminate(node, ctx);
          currentNodeId = undefined;
          break;
        }
      }
    } catch (err) {
      // Step nodes already record their own per-attempt FAILED rows (so the
      // workflow_steps table reflects each retry). Don't double-record here.
      if (node.type !== 'step') {
        await safeRecord(dispatcher, {
          error: err instanceof Error ? err.message : String(err),
          nodeId,
          status: 'FAILED',
        });
      }
      throw err;
    }
  }

  return {
    finalContext: ctx,
    result: terminal?.result ?? {},
    status: terminal?.status ?? 'SUCCESS',
    transitions,
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
