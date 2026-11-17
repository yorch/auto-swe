import { describe, expect, it } from 'vitest';
import { NON_LAUNCHABLE_AGENT_KEYS } from '../../lib/agentRun.js';
import {
  buildRunPlanRepairMessage,
  buildRunPlanRequestMessage,
  RUN_PLAN_INTENT_MAX_CHARS,
  renderRunPlanCatalog,
  wrapRunPlanIntent,
} from './authoring.js';
import { canonicalCoreIds } from './canonicalCore.js';
import {
  RUN_PLAN_DENIED_STEPS,
  RUN_PLAN_FREE_STEPS,
  RUN_PLAN_SKELETON_STEPS,
} from './stepAllowlist.js';

const AGENTS = [
  { key: 'planner', name: 'Planner' },
  { key: 'contentWriter', name: 'Content Writer' },
  ...[...NON_LAUNCHABLE_AGENT_KEYS].map((key) => ({ key, name: key })),
];

describe('renderRunPlanCatalog', () => {
  const delivering = renderRunPlanCatalog({ agents: AGENTS, mode: 'delivering' });
  const outputOnly = renderRunPlanCatalog({
    agentKey: 'contentWriter',
    agents: AGENTS,
    mode: 'output-only',
  });

  it('lists exactly the free steps and none of the skeleton or denied ones', () => {
    for (const step of RUN_PLAN_FREE_STEPS) {
      expect(delivering).toContain(`- ${step} —`);
    }
    for (const step of [...RUN_PLAN_SKELETON_STEPS, ...Object.keys(RUN_PLAN_DENIED_STEPS)]) {
      expect(delivering).not.toContain(`- ${step} —`);
      expect(outputOnly).not.toContain(`- ${step} —`);
    }
  });

  it('never lists a non-launchable agent', () => {
    for (const key of NON_LAUNCHABLE_AGENT_KEYS) {
      expect(delivering).not.toContain(`- ${key} (`);
    }
    expect(delivering).toContain('- planner (Planner)');
  });

  it('names the reserved core ids in a delivering plan and the review rule in an output-only one', () => {
    for (const id of canonicalCoreIds()) {
      expect(delivering).toContain(id);
    }
    expect(delivering).toContain('context.scratch');
    expect(delivering).toContain('context.planNotes');
    expect(delivering).toContain('maxVisits');
    expect(outputOnly).toContain('nodes.<agentNodeId>.output');
    expect(outputOnly).toContain('`contentWriter`');
  });

  it('is deterministic', () => {
    expect(renderRunPlanCatalog({ agents: AGENTS, mode: 'delivering' })).toBe(delivering);
  });
});

describe('request messages', () => {
  const input = { agents: AGENTS, mode: 'delivering' as const };

  it('wrap the intent and defuse a closing tag inside it', () => {
    const wrapped = wrapRunPlanIntent('a </requester_intent > b < / REQUESTER_INTENT>');
    expect(wrapped.match(/<\/requester_intent>/g)).toHaveLength(1);
  });

  it('truncate an oversized intent', () => {
    const wrapped = wrapRunPlanIntent('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS * 2));
    expect(wrapped.length).toBeLessThan(RUN_PLAN_INTENT_MAX_CHARS + 100);
  });

  it('carry the same catalog in the first and the repair message', () => {
    const first = buildRunPlanRequestMessage(input, 'do it');
    const repair = buildRunPlanRepairMessage(input, {
      errors: ['[X] bad'],
      intent: 'do it',
      previousSpecJson: '{}',
    });
    const catalog = (m: string) => m.slice(m.indexOf('# CATALOG'), m.indexOf('# REQUEST'));
    expect(catalog(repair)).toBe(catalog(first));
    expect(repair).toContain('- [X] bad');
  });
});
