import { describe, expect, it } from 'vitest';
import { NON_LAUNCHABLE_AGENT_KEYS } from '../../lib/agentRun.js';
import {
  buildRunPlanRepairMessage,
  buildRunPlanRequestMessage,
  RUN_PLAN_INTENT_MAX_CHARS,
  renderRunPlanCatalog,
  runPlanIntentIssue,
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

  const ZW = String.fromCharCode(0x200b);
  const FW = (c: string) => String.fromCharCode(c.charCodeAt(0) + 0xfee0);
  const closeTags = (wrapped: string) => wrapped.match(/<\/requester_intent>/gi)?.length ?? 0;
  const openTags = (wrapped: string) => wrapped.match(/<requester_intent>/gi)?.length ?? 0;

  it('wrap the intent and defuse a closing tag inside it', () => {
    const wrapped = wrapRunPlanIntent('a </requester_intent > b < / REQUESTER_INTENT>');
    expect(closeTags(wrapped)).toBe(1);
  });

  it('defuse opening and closing tags spelled in full-width, zero-width or mixed-case forms', () => {
    const spellings = [
      `${FW('<')}${FW('/')}requester_intent${FW('>')}`,
      `</requester${ZW}_intent>`,
      `<${ZW}/ReQuEsTeR_InTeNt${ZW}>`,
      `<requester${FW('_')}intent>`,
      '<requester_intent foo="bar">',
      '<REQUESTER_INTENT>',
      '</requester_intent',
    ];
    for (const sp of spellings) {
      const wrapped = wrapRunPlanIntent(`before ${sp} after`);
      expect(closeTags(wrapped), sp).toBe(1);
      expect(openTags(wrapped), sp).toBe(1);
      expect(wrapped, sp).toContain('[requester_intent tag removed]');
    }
  });

  it('leave an ordinary intent byte-identical apart from trimming', () => {
    const text = 'Add a /health endpoint <b>fast</b>, e.g. GET.';
    expect(wrapRunPlanIntent(`  ${text}\n`)).toBe(
      `<requester_intent>\n${text}\n</requester_intent>`
    );
  });

  it('refuse, rather than cut, an oversized intent', () => {
    expect(() => wrapRunPlanIntent('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS + 1))).toThrow(RangeError);
    expect(wrapRunPlanIntent('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS))).toContain(
      'x'.repeat(RUN_PLAN_INTENT_MAX_CHARS)
    );
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

describe('runPlanIntentIssue', () => {
  const ZW = String.fromCharCode(0x200b);
  it('accepts a trimmed intent up to the bound, with leading and trailing space ignored', () => {
    expect(runPlanIntentIssue('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS))).toBeNull();
    expect(runPlanIntentIssue(`  ${'x'.repeat(RUN_PLAN_INTENT_MAX_CHARS)}  `)).toBeNull();
  });

  it('refuses empty, non-text and over-long intents', () => {
    expect(runPlanIntentIssue('   ')).toMatch(/empty/);
    expect(runPlanIntentIssue(42)).toMatch(/not text/);
    expect(runPlanIntentIssue('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS + 1))).toMatch(/longer than/);
  });

  it('refuses an intent that contains the wrapper tag in any spelling', () => {
    for (const t of [
      'a </requester_intent> b',
      'a <REQUESTER_INTENT> b',
      `a </requester${ZW}_intent> b`,
      `a ${String.fromCharCode(0xff1c)}/requester_intent${String.fromCharCode(0xff1e)} b`,
    ]) {
      expect(runPlanIntentIssue(t), t).toMatch(/markup/);
    }
    expect(runPlanIntentIssue('mention requester_intent in words')).toBeNull();
  });
});
