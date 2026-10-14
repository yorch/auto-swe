import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, builtinModelSpec } from '../lib/builtinModels.js';
import { SWE_AGENTS } from '../lib/syncBuiltins.js';
import {
  type CostEstimate,
  DEFAULT_FANOUT_WIDTH,
  DEFAULT_ROLE_PRICING,
  describeCostExclusions,
  estimateSpecCost,
  type UnpricedReason,
} from './costEstimator.js';
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
  // Mirrors the real registry: the declarative `agent` node is priced from this
  // step's hint, since the referenced Agent's own model is not statically known.
  runAgentNode: {
    category: 'agent',
    configFields: [],
    costHint: { role: 'implementer', tokensIn: 1_000_000, tokensOut: 1_000_000 },
    description: '',
    label: '',
    name: 'runAgentNode',
  },
};
const lookup = (name: string): StepMetadata | undefined => REGISTRY[name];

/**
 * Fixed rates for the walk tests, so they check the estimator's arithmetic
 * rather than today's model prices — DEFAULT_ROLE_PRICING moves with them.
 */
const PRICING = {
  commitToMemory: { inputUsdPerM: 3, outputUsdPerM: 15 },
  evalJudge: { inputUsdPerM: 1, outputUsdPerM: 5 },
  implementer: { inputUsdPerM: 15, outputUsdPerM: 75 },
  planner: { inputUsdPerM: 3, outputUsdPerM: 15 },
  reviewer: { inputUsdPerM: 15, outputUsdPerM: 75 },
  securityReview: { inputUsdPerM: 15, outputUsdPerM: 75 },
  validateContext: { inputUsdPerM: 3, outputUsdPerM: 15 },
};

describe('estimateSpecCost', () => {
  it('returns zero for a spec with no step nodes', () => {
    const result = estimateSpecCost(
      spec({
        entry: 't',
        nodes: { t: { status: 'SUCCESS', type: 'terminate' } },
      }),
      { pricing: PRICING, stepLookup: lookup }
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
      { pricing: PRICING, stepLookup: lookup }
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
      { pricing: PRICING, stepLookup: lookup }
    );
    expect(result.totalUsd).toBe(0);
    expect(result.perStep).toEqual([]);
    // Not silently dropped: an unpriced step is reported so the editor can say
    // what the number leaves out.
    expect(result.unpriced).toEqual([{ nodeId: 'n', reason: 'no-cost-hint' }]);
  });

  it('prices a declarative agent node from the runAgentNode hint', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'a',
        nodes: {
          a: { agentRef: 'supportResponder', next: 't', type: 'agent' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { pricing: PRICING, stepLookup: lookup }
    );
    // Priced from the hint's proxy role rather than contributing nothing.
    expect(result.totalUsd).toBeCloseTo(90, 6);
    expect(result.perStep).toEqual([{ nodeId: 'a', step: 'runAgentNode', usd: 90 }]);
    expect(result.unpriced).toEqual([]);
  });

  it('reports container, external, and hint-less nodes as unpriced', () => {
    const result = estimateSpecCost(
      spec({
        entry: 'n',
        nodes: {
          c: { image: 'x', next: 'm', type: 'containerStep' },
          m: { connectionRef: 'c1', next: 't', tool: 'do', type: 'mcp' },
          n: { next: 'sh', step: 'noHint', type: 'step' },
          sh: { command: 'true', image: 'alpine:latest', next: 'c', type: 'shell' },
          t: { status: 'SUCCESS', type: 'terminate' },
        },
      }),
      { pricing: PRICING, stepLookup: lookup }
    );
    expect(result.totalUsd).toBe(0);
    expect(result.unpriced).toEqual([
      { nodeId: 'n', reason: 'no-cost-hint' },
      { nodeId: 'sh', reason: 'container-runtime' },
      { nodeId: 'c', reason: 'container-runtime' },
      { nodeId: 'm', reason: 'external-call' },
    ]);
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
      { pricing: PRICING, stepLookup: lookup }
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
      { pricing: PRICING, stepLookup: lookup }
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
      { fanOutWidth: 10, pricing: PRICING, stepLookup: lookup }
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
      { pricing: PRICING, stepLookup: lookup }
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
      { pricing: PRICING, stepLookup: lookup }
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

describe('DEFAULT_ROLE_PRICING', () => {
  /** The spec a seeded agent runs, following `inheritsModelFrom` the way the resolver does. */
  function seededSpec(key: string, seen: Set<string> = new Set()): string | undefined {
    const agent = SWE_AGENTS.find((a) => a.key === key);
    if (!agent || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    return (
      agent.modelSpec ??
      (agent.inheritsModelFrom ? seededSpec(agent.inheritsModelFrom, seen) : undefined)
    );
  }

  it('prices each role at the built-in price of the model its seeded agent runs', () => {
    const builtin = new Map(BUILTIN_MODELS.map((m) => [builtinModelSpec(m), m]));
    for (const [role, rates] of Object.entries(DEFAULT_ROLE_PRICING)) {
      const spec = seededSpec(role);
      expect(spec, `no seeded agent for role ${role}`).toBeDefined();
      const model = builtin.get(spec as string);
      expect(model, `${spec} has no built-in price`).toBeDefined();
      expect(rates, role).toEqual({
        inputUsdPerM: model?.inputUsdPerMTok,
        outputUsdPerM: model?.outputUsdPerMTok,
      });
    }
  });
});

describe('describeCostExclusions', () => {
  const est = (unpriced: Array<{ nodeId: string; reason: UnpricedReason }>): CostEstimate => ({
    fanOutWidthAssumed: DEFAULT_FANOUT_WIDTH,
    perStep: [],
    totalUsd: 0,
    unpriced,
  });

  it('returns null when the walk priced everything it reached', () => {
    expect(describeCostExclusions(est([]))).toBeNull();
  });

  it('names each excluded class, with counts and the retry caveat', () => {
    const sentence = describeCostExclusions(
      est([
        { nodeId: 'a', reason: 'container-runtime' },
        { nodeId: 'b', reason: 'external-call' },
        { nodeId: 'c', reason: 'no-cost-hint' },
        { nodeId: 'd', reason: 'no-cost-hint' },
      ])
    );
    expect(sentence).toBe(
      'Excludes container runtime (1 node), external calls (1 node), unpriced steps (2 nodes) and retries (each node is counted once).'
    );
  });

  it('omits a class that is not present', () => {
    const sentence = describeCostExclusions(est([{ nodeId: 'a', reason: 'external-call' }]));
    expect(sentence).toBe(
      'Excludes external calls (1 node) and retries (each node is counted once).'
    );
  });
});
