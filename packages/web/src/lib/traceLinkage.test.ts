import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec, SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow/spec';
import { describe, expect, it } from 'vitest';
import {
  attributeTrace,
  buildTraceLinker,
  recordingMatchesSelection,
  specNodeIdOfRecording,
  traceBelongsToStep,
  traceMatchesSelection,
} from './traceLinkage';

const done = { status: 'SUCCESS', type: 'terminate' } as const;

// `lintA` and `lintB` share a step (the case the old name map got wrong); `fan`
// runs `impl` per branch and nests `inner`.
const spec = parseWorkflowSpec({
  entry: 'lintA',
  name: 'linkage',
  nodes: {
    agentN: { agentRef: 'implementer', next: 'fan', type: 'agent' },
    branchDone: done,
    done,
    fan: { join: 'done', over: { literal: [1, 2] }, subgraph: 'impl', type: 'fanOut' },
    impl: { next: 'branchDone', step: 'executeImplementation', type: 'step' },
    lintA: { next: 'lintB', step: 'runLint', type: 'step' },
    lintB: { next: 'agentN', step: 'runLint', type: 'step' },
    shellN: { command: 'true', image: 'alpine', type: 'shell' },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
});
const linker = buildTraceLinker(spec);

let n = 0;
const trace = (over: Partial<AgentTraceRecord>): AgentTraceRecord => ({
  agentKey: 'implementer',
  attempt: 1,
  costUsd: null,
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 1,
  error: null,
  id: `t${n++}`,
  inputJson: null,
  inputTokens: null,
  model: null,
  nodeId: 'executeImplementation',
  otelSpanId: null,
  otelTraceId: null,
  outputJson: null,
  outputTokens: null,
  recordingId: null,
  seq: 0,
  specNodeId: null,
  stepAttempt: null,
  toolName: null,
  trimmed: false,
  type: 'activity_event',
  ...over,
});
const recorded = (recordingId: string, specNodeId: string, nodeId = 'executeImplementation') =>
  trace({ nodeId, recordingId, specNodeId, stepAttempt: 1 });

describe('buildTraceLinker', () => {
  it('maps every dispatching node kind to its activity and keeps colliding nodes', () => {
    expect(linker.candidatesByActivity.get('runLint')).toEqual(['lintA', 'lintB']);
    expect(linker.candidatesByActivity.get('runAgentNode')).toEqual(['agentN']);
    expect(linker.candidatesByActivity.get('runShellStep')).toEqual(['shellN']);
    expect(linker.candidatesByActivity.get('executeImplementation')).toEqual(['impl']);
  });

  it('is empty without a spec', () => {
    expect(buildTraceLinker(null).specNodeIds.size).toBe(0);
  });
});

describe('specNodeIdOfRecording', () => {
  it('reads the spec key off a branch-prefixed id', () => {
    expect(specNodeIdOfRecording('fan[0]/impl', linker)).toBe('impl');
    expect(specNodeIdOfRecording('fan[0]/inner[1]/impl', linker)).toBe('impl');
    expect(specNodeIdOfRecording('lintA', linker)).toBe('lintA');
  });

  it('prefers the longest spec key when ids themselves contain a slash', () => {
    const l = buildTraceLinker(
      parseWorkflowSpec({
        entry: 'a/b',
        name: 's',
        nodes: { 'a/b': done, b: done },
        schemaVersion: SPEC_SCHEMA_VERSION,
      })
    );
    expect(specNodeIdOfRecording('fan[0]/a/b', l)).toBe('a/b');
  });
});

describe('attributeTrace', () => {
  it('is exact, with its branch, for a recorded trace', () => {
    expect(attributeTrace(recorded('fan[1]/impl', 'impl'), linker)).toMatchObject({
      ambiguous: false,
      branch: 'fan[1]',
      candidates: ['impl'],
      exact: true,
      recordingId: 'fan[1]/impl',
    });
  });

  it('names every candidate for an old trace and flags a collision as ambiguous', () => {
    expect(attributeTrace(trace({ nodeId: 'runLint' }), linker)).toMatchObject({
      ambiguous: true,
      candidates: ['lintA', 'lintB'],
      exact: false,
    });
    expect(attributeTrace(trace({ nodeId: 'runAgentNode' }), linker).ambiguous).toBe(false);
  });

  it('has no candidates for an activity no node runs', () => {
    expect(attributeTrace(trace({ nodeId: 'finalizeWorkflowRun' }), linker).candidates).toEqual([]);
  });
});

describe('traceMatchesSelection', () => {
  const branches = [
    recorded('fan[0]/impl', 'impl'),
    recorded('fan[1]/impl', 'impl'),
    recorded('fan[1]/inner[0]/impl', 'impl'),
  ];

  it('shows exactly one node when two nodes share a step (recorded traces)', () => {
    const a = recorded('lintA', 'lintA', 'runLint');
    const b = recorded('lintB', 'lintB', 'runLint');
    expect(traceMatchesSelection(a, 'lintA', linker)).toBe(true);
    expect(traceMatchesSelection(b, 'lintA', linker)).toBe(false);
    expect(traceMatchesSelection(b, 'lintB', linker)).toBe(true);
  });

  it('selecting a spec node shows every branch of it', () => {
    expect(branches.map((t) => traceMatchesSelection(t, 'impl', linker))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('selecting a fan-out node shows everything that ran inside it', () => {
    expect(branches.every((t) => traceMatchesSelection(t, 'fan', linker))).toBe(true);
    expect(traceMatchesSelection(recorded('lintA', 'lintA', 'runLint'), 'fan', linker)).toBe(false);
  });

  it('selecting a branch recording id shows only that branch', () => {
    expect(branches.map((t) => traceMatchesSelection(t, 'fan[0]/impl', linker))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("selecting a nested fan-out's recording id shows its branches and no others", () => {
    const nested = branches[2] as AgentTraceRecord;
    expect(traceMatchesSelection(nested, 'fan[1]/inner', linker)).toBe(true);
    expect(traceMatchesSelection(branches[1] as AgentTraceRecord, 'fan[1]/inner', linker)).toBe(
      false
    );
    expect(recordingMatchesSelection('fan[2]/inner[0]/impl', 'fan[1]/inner', linker)).toBe(false);
  });

  describe('old traces without a recorded node', () => {
    it('shows an ambiguous trace under every candidate instead of picking the last', () => {
      const old = trace({ nodeId: 'runLint' });
      expect(traceMatchesSelection(old, 'lintA', linker)).toBe(true);
      expect(traceMatchesSelection(old, 'lintB', linker)).toBe(true);
      expect(traceMatchesSelection(old, 'agentN', linker)).toBe(false);
    });

    it('cannot place an old trace in a branch, so a branch selection still lists it', () => {
      const old = trace({ nodeId: 'executeImplementation' });
      expect(traceMatchesSelection(old, 'fan[1]/impl', linker)).toBe(true);
    });

    it('does not match a fan-out node, which dispatches nothing', () => {
      expect(traceMatchesSelection(trace({ nodeId: 'executeImplementation' }), 'fan', linker)).toBe(
        false
      );
    });
  });
});

describe('ids containing a slash', () => {
  const slashLinker = buildTraceLinker(
    parseWorkflowSpec({
      entry: 'a/fan',
      name: 'slashes',
      nodes: {
        'a/fan': { join: 'done', over: { literal: [1] }, subgraph: 'b/impl', type: 'fanOut' },
        'b/impl': { next: 'done', step: 'executeImplementation', type: 'step' },
        done,
      },
      schemaVersion: SPEC_SCHEMA_VERSION,
    })
  );

  it('selecting a fan-out whose id has a slash still shows its branches', () => {
    const t = recorded('a/fan[0]/b/impl', 'b/impl');
    expect(traceMatchesSelection(t, 'a/fan', slashLinker)).toBe(true);
    expect(traceMatchesSelection(t, 'b/impl', slashLinker)).toBe(true);
    expect(traceMatchesSelection(t, 'a/fan[1]/b/impl', slashLinker)).toBe(false);
  });
});

describe('traceBelongsToStep', () => {
  it('matches one execution exactly and respects the interpreter attempt', () => {
    const t = trace({
      nodeId: 'runLint',
      recordingId: 'lintA',
      specNodeId: 'lintA',
      stepAttempt: 2,
    });
    expect(traceBelongsToStep(t, { attempt: 2, nodeId: 'lintA' }, linker)).toBe(true);
    expect(traceBelongsToStep(t, { attempt: 1, nodeId: 'lintA' }, linker)).toBe(false);
    expect(traceBelongsToStep(t, { attempt: 2, nodeId: 'lintB' }, linker)).toBe(false);
  });

  it('keeps sibling branches apart', () => {
    const t = recorded('fan[0]/impl', 'impl');
    expect(traceBelongsToStep(t, { attempt: 1, nodeId: 'fan[0]/impl' }, linker)).toBe(true);
    expect(traceBelongsToStep(t, { attempt: 1, nodeId: 'fan[1]/impl' }, linker)).toBe(false);
  });

  it('falls back to the activity name for an old trace', () => {
    expect(
      traceBelongsToStep(trace({ nodeId: 'runLint' }), { attempt: 1, nodeId: 'lintB' }, linker)
    ).toBe(true);
  });
});
