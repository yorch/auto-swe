import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from './spec.js';

describe('parseWorkflowSpec', () => {
  const minimal = {
    description: 'demo',
    entry: 'start',
    name: 'minimal',
    nodes: {
      start: { status: 'SUCCESS', type: 'terminate' },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  };

  it('parses a minimal valid spec', () => {
    const spec = parseWorkflowSpec(minimal);
    expect(spec.entry).toBe('start');
    expect(spec.nodes.start.type).toBe('terminate');
  });

  it('rejects unknown entry node', () => {
    expect(() => parseWorkflowSpec({ ...minimal, entry: 'missing' })).toThrow(/entry node/);
  });

  it('rejects edges to unknown nodes', () => {
    expect(() =>
      parseWorkflowSpec({
        ...minimal,
        nodes: {
          start: { expr: 'a == 1', onFalse: 'never2', onTrue: 'never', type: 'cond' },
        },
      })
    ).toThrow(/unknown node/);
  });

  it('parses a multi-node spec with all node types', () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'all types',
      nodes: {
        a: { config: { status: 'X' }, next: 'b', step: 'updateDomainState', type: 'step' },
        b: { next: 'c', type: 'set', values: { 'counters.x': { literal: 0 } } },
        c: { expr: 'counters.x == 0', onFalse: 'd', onTrue: 'd', type: 'cond' },
        d: {
          name: 'ci',
          onReceive: 'e',
          onTimeout: 'e',
          timeout: '1h',
          type: 'signal',
        },
        e: { status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    expect(Object.keys(spec.nodes).length).toBe(5);
  });
});
