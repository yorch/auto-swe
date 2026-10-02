import { describe, expect, it } from 'vitest';
import type { Context } from './expr.js';
import { type Dispatcher, runSpec } from './interpreter.js';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from './spec.js';

/**
 * Every activity dispatch carries the node it runs for: the spec key, the
 * recording id (branch-prefixed inside a fan-out) and the interpreter attempt.
 * The worker turns these into trace attribution, so a dispatch kind that drops
 * them leaves its traces unattributable.
 */

interface Seen {
  kind: 'step' | 'shell';
  nodeId: string;
  specNodeId?: string;
  stepAttempt?: number;
  step?: string;
}

function recorder(failFirst: Record<string, number> = {}) {
  const seen: Seen[] = [];
  const remaining = { ...failFirst };
  const dispatcher: Dispatcher = {
    async dispatchShell(args) {
      seen.push({
        kind: 'shell',
        nodeId: args.nodeId,
        specNodeId: args.specNodeId,
        stepAttempt: args.stepAttempt,
      });
      return { passed: true };
    },
    async dispatchStep(args) {
      seen.push({
        kind: 'step',
        nodeId: args.nodeId,
        specNodeId: args.specNodeId,
        step: args.step,
        stepAttempt: args.stepAttempt,
      });
      if ((remaining[args.nodeId] ?? 0) > 0) {
        remaining[args.nodeId] = (remaining[args.nodeId] ?? 0) - 1;
        throw new Error('boom');
      }
      return { ok: true };
    },
    async recordStep() {},
    async waitSignal() {
      return undefined;
    },
  };
  return { dispatcher, seen };
}

const baseCtx = (): Context => ({
  context: { items: ['a', 'b'] },
  nodes: {},
  request: { externalTicketId: 'T-1', repoId: 'r' },
  workflow: { id: 'wf' },
});

const done = { status: 'SUCCESS', type: 'terminate' } as const;

describe('dispatch identity', () => {
  it('passes the spec node and attempt for step, agent, mcp, eval, containerStep and shell', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'kinds',
      nodes: {
        a: { next: 'b', step: 'runLint', type: 'step' },
        b: { agentRef: 'implementer', next: 'c', type: 'agent' },
        c: { connectionRef: 'conn', next: 'd', tool: 't', type: 'mcp' },
        d: {
          next: 'e',
          scorers: [{ expr: 'true', kind: 'assert' }],
          target: { literal: 1 },
          type: 'eval',
        },
        e: { image: 'alpine', next: 'f', type: 'containerStep' },
        end: done,
        f: { command: 'true', image: 'alpine', next: 'end', type: 'shell' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, seen } = recorder();
    await runSpec(spec, baseCtx(), dispatcher);
    expect(seen.map((s) => [s.kind, s.nodeId, s.specNodeId, s.stepAttempt])).toEqual([
      ['step', 'a', 'a', 1],
      ['step', 'b', 'b', 1],
      ['step', 'c', 'c', 1],
      ['step', 'd', 'd', 1],
      ['step', 'e', 'e', 1],
      ['shell', 'f', 'f', 1],
    ]);
  });

  it('keeps the spec key apart from the branch-prefixed recording id, nested too', async () => {
    const spec = parseWorkflowSpec({
      entry: 'outer',
      name: 'nested',
      nodes: {
        branchEnd: done,
        end: done,
        inner: {
          join: 'branchEnd',
          over: { literal: ['x', 'y'] },
          subgraph: 'work',
          type: 'fanOut',
        },
        outer: { join: 'end', over: { from: 'context.items' }, subgraph: 'inner', type: 'fanOut' },
        work: { next: 'branchEnd', step: 'runLint', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, seen } = recorder();
    await runSpec(spec, baseCtx(), dispatcher);
    const ids = seen.map((s) => `${s.nodeId}=>${s.specNodeId}`).sort();
    expect(ids).toEqual([
      'outer[0]/inner[0]/work=>work',
      'outer[0]/inner[1]/work=>work',
      'outer[1]/inner[0]/work=>work',
      'outer[1]/inner[1]/work=>work',
    ]);
  });

  it('numbers interpreter retries per dispatch', async () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'retry',
      nodes: {
        a: { next: 'end', onFail: { retry: 2 }, step: 'runLint', type: 'step' },
        end: done,
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    const { dispatcher, seen } = recorder({ a: 2 });
    await runSpec(spec, baseCtx(), dispatcher);
    expect(seen.map((s) => s.stepAttempt)).toEqual([1, 2, 3]);
  });
});
