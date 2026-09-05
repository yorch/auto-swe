import { describe, expect, it } from 'vitest';
import { DEFAULT_FANOUT_WIDTH, DEFAULT_ROLE_PRICING, estimateSpecCost } from './costEstimator.js';
import type { StepMetadata } from './registry-types.js';
import { makeSpec as spec } from './testHelpers.js';

const REGISTRY: Record<string, StepMetadata> = {
  cheapPlanner: {
    category: 'agent',
    configFields: [],
    costHint: { role: 'planner', tokensIn: 1_000_000, tokensOut: 1_000_000 },
    description: '',
    label: '',
    name: 'cheapPlanner',
  },
  implement: {
    category: 'agent',
    configFields: [],
    costHint: { role: 'implementer', tokensIn: 1_000_000, tokensOut: 1_000_000 },
    description: '',
    label: '',
    name: 'implement',
  },
  noHint: {
    category: 'control',
    configFields: [],
    description: '',
    label: '',
    name: 'noHint',
  },
};
const lookup = (name: string): StepMetadata | undefined => REGISTRY[name];

describe('estimateSpecCost', () => {
  it('returns zero for a spec with no step nodes', () => {
    const result = estimateSpecCost(
      spec({
        entry: 't',
        nodes: { t: { status: 'SUCCESS', type: 'terminate' } },
      }),
      { stepLookup: lookup }
    );
    expect(result.totalUsd).toBe(0);
    expect(result.perStep).toEqual([]);
  });

  it('sums implementer cost (1M in × $15 + 1M out × $75 = $90)', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'i',
        nodes: {
          i: { next: 't', step: 'implement', type: 'step' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { stepLookup: lookup }
    );
    expect(result.totalUsd).toBeCloseTo(90, 6);
    expect(result.perStep).toEqual([{ nodeId: 'i', step: 'implement', usd: 90 }]);
  });

  it('ignores nodes without a costHint', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'n',
        nodes: {
          n: { next: 't', step: 'noHint', type: 'step' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { stepLookup: lookup }
    );
    expect(result.totalUsd).toBe(0);
    expect(result.perStep).toEqual([]);
  });

  it('takes the max of cond arms (pessimistic)', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'c',
        nodes: {
          c: { expr: 'true', onFalse: 'p', onTrue: 'i', type: 'cond' },
          i: { next: 't', step: 'implement', type: 'step' },
          p: { next: 't', step: 'cheapPlanner', type: 'step' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { stepLookup: lookup }
    );
    // implementer = $90, planner = 1M*3 + 1M*15 = $18 → max = $90
    expect(result.totalUsd).toBeCloseTo(90, 6);
  });

  it('multiplies fanOut subgraph cost by the assumed width', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'fan',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          fan: {
            itemKey: 'subtask',
            join: 'done',
            onBranchFail: 'block',
            over: { literal: [] },
            subgraph: 'i',
            type: 'fanOut',
          },
          i: { next: 'leaf', step: 'implement', type: 'step' },
          leaf: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { stepLookup: lookup }
    );
    // implementer = $90, fanOut width = 4 → $360
    expect(result.totalUsd).toBeCloseTo(90 * DEFAULT_FANOUT_WIDTH, 6);
    expect(result.fanOutWidthAssumed).toBe(DEFAULT_FANOUT_WIDTH);
  });

  it('honors a custom fanOutWidth override', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'fan',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          fan: {
            itemKey: 'subtask',
            join: 'done',
            onBranchFail: 'block',
            over: { literal: [] },
            subgraph: 'i',
            type: 'fanOut',
          },
          i: { next: 'leaf', step: 'implement', type: 'step' },
          leaf: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { fanOutWidth: 10, stepLookup: lookup }
    );
    expect(result.totalUsd).toBeCloseTo(900, 6);
  });

  it('counts a join shared by both arms in each arm, whichever arm is walked first', () => {
    // Diamond: the cheap arm reaches the join first. A visited-set walker
    // then saw the join as "already counted" from the expensive arm and
    // returned $90 instead of $90 + $18.
    const result = estimateSpecCost(
      spec({
        entry: 'c',
        nodes: {
          c: { expr: 'true', onFalse: 'i', onTrue: 'skip', type: 'cond' },
          i: { next: 'join', step: 'implement', type: 'step' },
          join: { next: 't', step: 'cheapPlanner', type: 'step' },
          skip: { next: 'join', step: 'noHint', type: 'step' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { stepLookup: lookup }
    );
    expect(result.totalUsd).toBeCloseTo(108, 6);
    // Each priced node appears once in the breakdown even though two arms reach it.
    expect(result.perStep.map((s) => s.nodeId).sort()).toEqual(['i', 'join']);
  });

  it('terminates on cycles instead of running forever', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'c',
        nodes: {
          c: { expr: 'true', onFalse: 'done', onTrue: 'i', type: 'cond' },
          done: { status: 'SUCCESS', type: 'terminate' },
          i: { next: 'c', step: 'implement', type: 'step' },
        },
      }),
      { stepLookup: lookup }
    );
    // implementer counted once, cycle broken
    expect(result.totalUsd).toBeCloseTo(90, 6);
  });

  it('exposes the default pricing table', () => {
    expect(DEFAULT_ROLE_PRICING.implementer.inputUsdPerM).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_PRICING.implementer.outputUsdPerM).toBeGreaterThan(
      DEFAULT_ROLE_PRICING.implementer.inputUsdPerM
    );
  });
});
