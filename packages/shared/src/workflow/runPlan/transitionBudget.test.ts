import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { DEFAULT_MAX_TRANSITIONS, type Dispatcher, runSpec } from '../interpreter.js';
import { type Node, SPEC_SCHEMA_VERSION, WorkflowSpecSchema } from '../spec.js';
import { buildCanonicalCore, CORE_ENTRY } from './canonicalCore.js';
import { TRANSITION_BUDGET, TRANSITION_MARGIN, worstCaseTransitions } from './transitionBudget.js';

const set = (next: string): Node => ({ next, type: 'set', values: {} }) as Node;

describe('worstCaseTransitions', () => {
  it('counts a straight line once per node', () => {
    const nodes = {
      a: set('b'),
      b: set('c'),
      c: { status: 'SUCCESS', type: 'terminate' },
    } as Record<string, Node>;
    expect(worstCaseTransitions(nodes, Object.keys(nodes))).toBe(3);
  });

  it('counts a bounded node maxVisits + 1 times, the exhausting entry included', () => {
    const nodes = {
      out: set('out2'),
      out2: { status: 'SUCCESS', type: 'terminate' },
      spin: {
        expr: 'true',
        maxVisits: 4,
        onExhausted: 'out',
        onFalse: 'out',
        onTrue: 'spin',
        type: 'cond',
      },
    } as Record<string, Node>;
    expect(worstCaseTransitions(nodes, Object.keys(nodes))).toBe(5 + 1 + 1);
  });

  it('charges an unbounded node on a loop for every pass of the loop', () => {
    const nodes = {
      a: set('b'),
      b: {
        expr: 'true',
        maxVisits: 2,
        onExhausted: 'out',
        onFalse: 'out',
        onTrue: 'a',
        type: 'cond',
      },
      out: { status: 'SUCCESS', type: 'terminate' },
    } as Record<string, Node>;
    // a: 1 + (2 + 1) = 4, b: 3, out: 1
    expect(worstCaseTransitions(nodes, Object.keys(nodes))).toBe(8);
  });

  it('is infinite for a loop nothing bounds', () => {
    const nodes = { a: set('b'), b: set('a') } as Record<string, Node>;
    expect(worstCaseTransitions(nodes, Object.keys(nodes))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the canonical core against the interpreter cap', () => {
  const core = buildCanonicalCore();
  const bound = worstCaseTransitions(core.nodes, Object.keys(core.nodes));

  it('derives a finite bound that leaves the free regions a usable budget', () => {
    expect(Number.isFinite(bound)).toBe(true);
    expect(TRANSITION_BUDGET).toBe(DEFAULT_MAX_TRANSITIONS - TRANSITION_MARGIN);
    expect(TRANSITION_BUDGET - bound).toBeGreaterThanOrEqual(150);
  });

  it('is never exceeded by the real interpreter, whatever the review, CI and merge answer', async () => {
    const spec = WorkflowSpecSchema.parse({
      description: 'core',
      entry: CORE_ENTRY,
      name: 'core-only',
      nodes: core.nodes,
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    let max = 0;
    for (let seed = 1; seed <= 400; seed++) {
      let state = seed * 2654435761;
      // Mostly reject and fail, so the loops run long; a few lucky answers vary the route.
      const roll = (pFalse: number): boolean => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296 >= pFalse;
      };
      let n = 0;
      const dispatcher: Dispatcher = {
        async dispatchStep({ step }) {
          n++;
          switch (step) {
            case 'runReviewNetwork':
              return { approved: roll(0.6), rejectionFingerprint: `f${n}`, stalled: false };
            case 'resolveCiWaitConfig':
              return { mode: roll(0.5) ? 'poll' : 'signal' };
            case 'waitForCiByPolling':
              return { ciPassed: roll(0.6) };
            case 'executeImplementation':
            case 'executeReviewFixImplementation':
            case 'executeCIFixImplementation':
              return { branch: 'b', headSha: `sha${n}` };
            default:
              return {};
          }
        },
        async recordStep() {},
        async waitSignal(name) {
          return name === 'humanMergeSignal' ? { merged: true } : { passed: roll(0.6) };
        },
      };
      const ctx: Context = {
        context: { ciRetries: 0, currentCodeResult: { headSha: 'x' } },
        nodes: {},
        request: { description: 'x', externalTicketId: 'T-1', repoId: 'r-1' },
        workflow: { id: 'eng-t-1' },
      };
      const result = await runSpec(spec, ctx, dispatcher);
      max = Math.max(max, result.transitions);
    }
    expect(max).toBeGreaterThan(20);
    expect(max).toBeLessThanOrEqual(bound);
  });
});
