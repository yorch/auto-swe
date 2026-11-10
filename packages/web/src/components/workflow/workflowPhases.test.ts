import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { phasesOf } from './workflowPhases';

const spec = parseWorkflowSpec({
  entry: 'a',
  name: 'p',
  nodes: {
    a: { group: 'Plan', next: 'b', step: 'x', type: 'step' },
    b: { group: 'Build', next: 'c', step: 'x', type: 'step' },
    b2: { group: 'Build', next: 'c', step: 'x', type: 'step' },
    c: { group: 'Ship', next: 'end', step: 'x', type: 'step' },
    end: { status: 'SUCCESS', type: 'terminate' },
    orphan: { group: 'Extra', next: 'end', step: 'x', type: 'step' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});

describe('phasesOf', () => {
  it('orders by flow, then unreachable nodes', () => {
    expect(phasesOf(spec)).toEqual(['Plan', 'Build', 'Ship', 'Extra']);
  });
  it('is empty without groups', () => {
    const plain = parseWorkflowSpec({
      entry: 'e',
      name: 'n',
      nodes: { e: { status: 'SUCCESS', type: 'terminate' } },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    expect(phasesOf(plain)).toEqual([]);
  });
  it('survives a cycle, a self-loop and an unreachable node', () => {
    const odd = parseWorkflowSpec({
      entry: 'a',
      name: 'odd',
      nodes: {
        a: { group: 'One', next: 'b', step: 'x', type: 'step' },
        b: { group: 'Two', next: 'b', step: 'x', type: 'step' },
        c: { group: 'Three', next: 'a', step: 'x', type: 'step' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    expect(phasesOf(odd)).toEqual(['One', 'Two', 'Three']);
  });
});
