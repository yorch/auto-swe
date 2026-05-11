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
      await safeRecord(dispatcher, {
        error: err instanceof Error ? err.message : String(err),
        nodeId,
        status: 'FAILED',
      });
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
  try {
    const output = await dispatcher.dispatchStep({ config, ctx, inputs, nodeId, step: node.step });
    setPath(ctx, `nodes.${nodeId}.output`, output);
    await safeRecord(dispatcher, {
      inputs,
      nodeId,
      outputs: output,
      status: 'PASSED',
    });
    return node.next;
  } catch (err) {
    if (node.onError === 'continue') {
      await safeRecord(dispatcher, {
        error: err instanceof Error ? err.message : String(err),
        nodeId,
        status: 'SKIPPED',
      });
      setPath(ctx, `nodes.${nodeId}.output`, null);
      setPath(ctx, `nodes.${nodeId}.error`, String(err));
      return node.next;
    }
    throw err;
  }
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

function setPath(ctx: Context, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = ctx as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (cur[k] == null || typeof cur[k] !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

export { lookupPath };
