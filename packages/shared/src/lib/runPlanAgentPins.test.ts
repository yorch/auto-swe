import { describe, expect, it } from 'vitest';
import {
  type AgentPinReader,
  agentPinDrift,
  parseAgentPinRef,
  resolveRunPlanAgentPins,
  specAgentKeys,
} from './runPlanAgentPins.js';

interface Row {
  key: string;
  scope: string;
  version: number;
  active?: boolean;
  modelSpec?: string | null;
  inheritsModelFrom?: string | null;
  teamId?: string;
  orgId?: string;
  workflowTemplateId?: string;
}

function reader(rows: Row[]): AgentPinReader {
  return {
    agent: {
      findFirst: async ({ where }) => {
        const w = where as Record<string, unknown>;
        const hit = rows
          .filter(
            (r) =>
              r.active !== false &&
              r.key === w.key &&
              r.scope === w.scope &&
              (w.version === undefined || r.version === w.version) &&
              (w.teamId === undefined || r.teamId === w.teamId) &&
              (w.orgId === undefined || r.orgId === w.orgId) &&
              (w.workflowTemplateId === undefined || r.workflowTemplateId === w.workflowTemplateId)
          )
          .sort((a, b) => b.version - a.version)[0];
        return hit
          ? {
              inheritsModelFrom: hit.inheritsModelFrom ?? null,
              modelSpec: hit.modelSpec === undefined ? 'a/b' : hit.modelSpec,
              scope: hit.scope,
              version: hit.version,
            }
          : null;
      },
    },
  };
}

const scope = { orgId: 'o1', teamId: 't1', workflowTemplateId: 'tpl1' };

describe('specAgentKeys', () => {
  it('collects agent-node refs as written and the agents step nodes resolve', () => {
    const keys = specAgentKeys({
      nodes: {
        a: { agentRef: 'docsMaintainer@3', type: 'agent' },
        b: { step: 'executeImplementation', type: 'step' },
        c: { step: 'runReviewNetwork', type: 'step' },
        d: { step: 'runLint', type: 'step' },
        e: { status: 'SUCCESS', type: 'terminate' },
      },
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        'docsMaintainer@3',
        'implementer',
        'securityReview',
        'reviewer',
        'securityReviewer',
      ])
    );
    expect(keys).not.toContain('docsMaintainer');
  });

  it('a core made only of step nodes still yields the core agents', () => {
    const keys = specAgentKeys({
      nodes: {
        x: { step: 'commitToMemory', type: 'step' },
        y: { step: 'gatherTicketContext', type: 'step' },
      },
    });
    expect(keys).toEqual(['commitToMemory', 'planner', 'ticketContextGatherer']);
  });
});

describe('parseAgentPinRef', () => {
  it('parses a float and a pinned ref, and rejects a malformed pin', () => {
    expect(parseAgentPinRef('a')).toEqual({ key: 'a' });
    expect(parseAgentPinRef('a@2')).toEqual({ key: 'a', version: 2 });
    expect(parseAgentPinRef('a@0')).toBeNull();
    expect(parseAgentPinRef('a@x')).toBeNull();
    expect(parseAgentPinRef('')).toBeNull();
  });
});

describe('resolveRunPlanAgentPins', () => {
  it('walks the template tier first, so a template-scoped override is the pin and a later one is drift', async () => {
    const before = await resolveRunPlanAgentPins(
      reader([{ key: 'implementer', scope: 'GLOBAL', version: 3 }]),
      ['implementer'],
      scope
    );
    expect(before).toEqual({ implementer: 'GLOBAL:3' });
    const after = await resolveRunPlanAgentPins(
      reader([
        { key: 'implementer', scope: 'GLOBAL', version: 3 },
        { key: 'implementer', scope: 'WORKFLOW_TEMPLATE', version: 1, workflowTemplateId: 'tpl1' },
      ]),
      ['implementer'],
      scope
    );
    expect(after).toEqual({ implementer: 'WORKFLOW_TEMPLATE:1' });
    expect(agentPinDrift(before, after)).toEqual(['implementer']);
  });

  it('ignores a template-scoped override that belongs to another template', async () => {
    const pins = await resolveRunPlanAgentPins(
      reader([
        { key: 'implementer', scope: 'GLOBAL', version: 3 },
        { key: 'implementer', scope: 'WORKFLOW_TEMPLATE', version: 1, workflowTemplateId: 'other' },
      ]),
      ['implementer'],
      scope
    );
    expect(pins).toEqual({ implementer: 'GLOBAL:3' });
  });

  it('pins the version a key@N ref names, not the latest', async () => {
    const rows: Row[] = [
      { key: 'docs', scope: 'GLOBAL', version: 2 },
      { key: 'docs', scope: 'GLOBAL', version: 5 },
    ];
    const pins = await resolveRunPlanAgentPins(reader(rows), ['docs@2', 'docs'], scope);
    expect(pins).toEqual({ docs: 'GLOBAL:5', 'docs@2': 'GLOBAL:2' });
  });

  it('refuses drift when the referenced version no longer exists or is inactive', async () => {
    const recorded = { 'docs@2': 'GLOBAL:2' };
    const gone = await resolveRunPlanAgentPins(
      reader([{ key: 'docs', scope: 'GLOBAL', version: 5 }]),
      ['docs@2'],
      scope
    );
    expect(gone).toEqual({ 'docs@2': null });
    expect(agentPinDrift(recorded, gone, ['docs@2'])).toEqual(['docs@2']);
    const inactive = await resolveRunPlanAgentPins(
      reader([{ active: false, key: 'docs', scope: 'GLOBAL', version: 2 }]),
      ['docs@2'],
      scope
    );
    expect(agentPinDrift(recorded, inactive, ['docs@2'])).toEqual(['docs@2']);
  });

  it('is null for a malformed ref', async () => {
    expect(await resolveRunPlanAgentPins(reader([]), ['a@zero'], scope)).toEqual({
      'a@zero': null,
    });
  });

  it('pins the parent a persona inherits its model from, and flags a new or moved parent', async () => {
    const rows: Row[] = [
      {
        inheritsModelFrom: 'implementer',
        key: 'ciFixer',
        modelSpec: null,
        scope: 'GLOBAL',
        version: 1,
      },
      { key: 'implementer', scope: 'GLOBAL', version: 3 },
    ];
    const pins = await resolveRunPlanAgentPins(reader(rows), ['ciFixer'], scope);
    expect(pins).toEqual({ ciFixer: 'GLOBAL:1', implementer: 'GLOBAL:3' });
    // The parent gets a team override later: the persona's own pin is unchanged, the parent drifts.
    const moved = await resolveRunPlanAgentPins(
      reader([...rows, { key: 'implementer', scope: 'TEAM', teamId: 't1', version: 1 }]),
      ['ciFixer', 'implementer'],
      scope
    );
    expect(agentPinDrift(pins, moved, ['ciFixer'])).toEqual(['implementer']);
    // A plan recorded without the parent is drift once the parent resolves.
    expect(agentPinDrift({ ciFixer: 'GLOBAL:1' }, pins, ['ciFixer'])).toEqual(['implementer']);
  });

  it('survives an inheritance cycle', async () => {
    const rows: Row[] = [
      { inheritsModelFrom: 'b', key: 'a', modelSpec: null, scope: 'GLOBAL', version: 1 },
      { inheritsModelFrom: 'a', key: 'b', modelSpec: null, scope: 'GLOBAL', version: 1 },
    ];
    expect(await resolveRunPlanAgentPins(reader(rows), ['a'], scope)).toEqual({
      a: 'GLOBAL:1',
      b: 'GLOBAL:1',
    });
  });
});
