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

  // ── Phase 2: onFail field on step nodes ──

  it('parses a step node with onFail=block', () => {
    const spec = parseWorkflowSpec({
      ...minimal,
      entry: 'g',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        g: { next: 'done', onFail: 'block', step: 'runLint', type: 'step' },
      },
    });
    expect((spec.nodes.g as { onFail?: unknown }).onFail).toBe('block');
  });

  it('parses a step node with onFail=warn', () => {
    const spec = parseWorkflowSpec({
      ...minimal,
      entry: 'g',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        g: { next: 'done', onFail: 'warn', step: 'runVulnScan', type: 'step' },
      },
    });
    expect((spec.nodes.g as { onFail?: unknown }).onFail).toBe('warn');
  });

  it('parses a step node with onFail={retry:N}', () => {
    const spec = parseWorkflowSpec({
      ...minimal,
      entry: 'g',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        g: { next: 'done', onFail: { retry: 3 }, step: 'runTests', type: 'step' },
      },
    });
    expect((spec.nodes.g as { onFail?: { retry: number } }).onFail).toEqual({ retry: 3 });
  });

  it('rejects onFail with a non-numeric retry', () => {
    expect(() =>
      parseWorkflowSpec({
        ...minimal,
        entry: 'g',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          g: { next: 'done', onFail: { retry: 'lots' }, step: 'runTests', type: 'step' },
        },
      })
    ).toThrow();
  });

  it('rejects onFail with retry=0 or negative', () => {
    for (const bad of [0, -1]) {
      expect(() =>
        parseWorkflowSpec({
          ...minimal,
          entry: 'g',
          nodes: {
            done: { status: 'SUCCESS', type: 'terminate' },
            g: { next: 'done', onFail: { retry: bad }, step: 'runTests', type: 'step' },
          },
        })
      ).toThrow();
    }
  });

  it('rejects onFail with an unrecognized literal', () => {
    expect(() =>
      parseWorkflowSpec({
        ...minimal,
        entry: 'g',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          g: { next: 'done', onFail: 'ignore', step: 'runTests', type: 'step' },
        },
      })
    ).toThrow();
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

  // ── Phase 3: fanOut node ──

  it('parses a minimal fanOut spec', () => {
    const spec = parseWorkflowSpec({
      entry: 'fan',
      name: 'fanout',
      nodes: {
        branchDone: { status: 'SUCCESS', type: 'terminate' },
        done: { status: 'SUCCESS', type: 'terminate' },
        fan: {
          join: 'done',
          over: { literal: [{ id: 'a' }, { id: 'b' }] },
          subgraph: 'branchDone',
          type: 'fanOut',
        },
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    });
    expect(spec.nodes.fan?.type).toBe('fanOut');
  });

  it('rejects fanOut.subgraph and fanOut.join when they reference unknown nodes', () => {
    expect(() =>
      parseWorkflowSpec({
        entry: 'fan',
        name: 'fanout-bad',
        nodes: {
          fan: {
            join: 'nope',
            over: { literal: [] },
            subgraph: 'alsoNope',
            type: 'fanOut',
          },
        },
        schemaVersion: SPEC_SCHEMA_VERSION,
      })
    ).toThrow(/unknown node/);
  });

  it('rejects fanOut without required fields', () => {
    expect(() =>
      parseWorkflowSpec({
        entry: 'fan',
        name: 'fanout-missing',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          fan: { join: 'done', subgraph: 'done', type: 'fanOut' }, // no `over`
        },
        schemaVersion: SPEC_SCHEMA_VERSION,
      })
    ).toThrow();
  });

  it('rejects fanOut.exports longer than the allowed max', () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `context.k${i}`);
    expect(() =>
      parseWorkflowSpec({
        entry: 'fan',
        name: 'fanout-export-cap',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          fan: {
            exports: tooMany,
            join: 'done',
            over: { literal: [] },
            subgraph: 'done',
            type: 'fanOut',
          },
        },
        schemaVersion: SPEC_SCHEMA_VERSION,
      })
    ).toThrow();
  });
});
