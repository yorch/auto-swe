import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import {
  deleteNodeFromSpec,
  isEdgeFieldRequired,
  renameNodeInSpec,
  setSpecEdge,
  UNRESOLVED_NODE_ID,
} from './specEdits';

/**
 * The editor used to repair references through a hardcoded field list that knew
 * nothing about `onApprove` / `onReject` / `onSubmit` or a decision option's
 * `next`. Deleting a node those referenced left a dangling id behind and a
 * rename left a stale one — both of which only surface later, as a schema error
 * about a node the user never touched.
 *
 * So every case here ends at `parseWorkflowSpec`: it is the same schema the save
 * path runs, and "the spec still parses afterwards" is the actual claim these
 * edits make.
 */
const SPEC: WorkflowSpec = parseWorkflowSpec({
  description: '',
  entry: 'start',
  name: 'hitl',
  nodes: {
    approve: {
      onApprove: 'doomed',
      onReject: 'end',
      onTimeout: 'end',
      timeout: '1h',
      title: 'Approve?',
      type: 'humanApproval',
    },
    collect: {
      fields: [{ key: 'why', label: 'Why', type: 'text' }],
      onSubmit: 'doomed',
      onTimeout: 'end',
      timeout: '1h',
      title: 'Details',
      type: 'humanInput',
    },
    decide: {
      onTimeout: 'end',
      options: [
        { label: 'Ship it', next: 'doomed', value: 'ship' },
        { label: 'Hold', next: 'end', value: 'hold' },
      ],
      timeout: '1h',
      title: 'Pick one',
      type: 'humanDecision',
    },
    doomed: { next: 'end', step: 'doomedStep', type: 'step' },
    end: { status: 'SUCCESS', type: 'terminate' },
    optional: { next: 'doomed', step: 'optionalStep', type: 'step' },
    start: { next: 'approve', step: 'startStep', type: 'step' },
  },
  schemaVersion: 1,
});

const nodeAt = (spec: WorkflowSpec, id: string): SpecNode => spec.nodes[id] as SpecNode;

/** Own-key check — the bug being guarded against writes a literal indexed key. */
const ownKeys = (spec: WorkflowSpec, id: string): string[] =>
  Object.keys(nodeAt(spec, id) as unknown as Record<string, unknown>);

/** The option targets of a `humanDecision`, in order. */
const optionTargets = (spec: WorkflowSpec, id: string): string[] => {
  const node = nodeAt(spec, id);
  return node.type === 'humanDecision' ? node.options.map((o) => o.next) : [];
};

describe('deleteNodeFromSpec', () => {
  const next = deleteNodeFromSpec(SPEC, 'doomed');

  it('produces a spec that still passes the real schema', () => {
    expect(() => parseWorkflowSpec(next)).not.toThrow();
    expect(next.nodes.doomed).toBeUndefined();
  });

  it('repairs the human-edge fields the old hardcoded list never covered', () => {
    expect(next.nodes.approve).toMatchObject({ onApprove: UNRESOLVED_NODE_ID, onReject: 'end' });
    expect(next.nodes.collect).toMatchObject({ onSubmit: UNRESOLVED_NODE_ID, onTimeout: 'end' });
  });

  it('repairs an indexed decision-option edge without writing a literal key', () => {
    expect(optionTargets(next, 'decide')).toEqual([UNRESOLVED_NODE_ID, 'end']);
    expect(ownKeys(next, 'decide')).not.toContain('options[0].next');
  });

  it('clears an optional edge instead of retargeting it', () => {
    expect(next.nodes.optional).not.toHaveProperty('next');
    expect(next.nodes.optional).toMatchObject({ step: 'optionalStep', type: 'step' });
  });

  it('creates the placeholder once, as a SKIPPED terminate, and reuses it', () => {
    expect(next.nodes[UNRESOLVED_NODE_ID]).toEqual({ status: 'SKIPPED', type: 'terminate' });

    // Second delete of a node several required edges point at: still one placeholder.
    const again = deleteNodeFromSpec(next, 'end');
    expect(() => parseWorkflowSpec(again)).not.toThrow();
    expect(again.nodes[UNRESOLVED_NODE_ID]).toEqual({ status: 'SKIPPED', type: 'terminate' });
    expect(again.nodes.approve).toMatchObject({ onReject: UNRESOLVED_NODE_ID });
  });

  it('refuses to delete the entry node or an unknown id', () => {
    expect(deleteNodeFromSpec(SPEC, 'start')).toBe(SPEC);
    expect(deleteNodeFromSpec(SPEC, 'nope')).toBe(SPEC);
  });
});

describe('renameNodeInSpec', () => {
  const next = renameNodeInSpec(SPEC, 'doomed', 'renamed');

  it('moves the node and every reference, leaving no stale id', () => {
    expect(() => parseWorkflowSpec(next)).not.toThrow();
    expect(next.nodes.renamed).toBeDefined();
    expect(next.nodes.doomed).toBeUndefined();
    expect(JSON.stringify(next)).not.toContain('doomed"');
  });

  it('rewrites the human-edge fields and the indexed option edge', () => {
    expect(next.nodes.approve).toMatchObject({ onApprove: 'renamed' });
    expect(next.nodes.collect).toMatchObject({ onSubmit: 'renamed' });
    expect(optionTargets(next, 'decide')[0]).toBe('renamed');
    expect(ownKeys(next, 'decide')).not.toContain('options[0].next');
  });

  it('never needs the placeholder — a rename orphans nothing', () => {
    expect(next.nodes[UNRESOLVED_NODE_ID]).toBeUndefined();
  });

  it('follows the entry pointer and rejects a colliding or unchanged id', () => {
    expect(renameNodeInSpec(SPEC, 'start', 'begin').entry).toBe('begin');
    expect(renameNodeInSpec(SPEC, 'doomed', 'end')).toBe(SPEC);
    expect(renameNodeInSpec(SPEC, 'doomed', 'doomed')).toBe(SPEC);
  });
});

describe('isEdgeFieldRequired', () => {
  it('classifies from the schema, including the indexed option edge', () => {
    expect(isEdgeFieldRequired(nodeAt(SPEC, 'optional'), 'next')).toBe(false);
    expect(isEdgeFieldRequired(nodeAt(SPEC, 'approve'), 'onApprove')).toBe(true);
    expect(isEdgeFieldRequired(nodeAt(SPEC, 'collect'), 'onSubmit')).toBe(true);
    expect(isEdgeFieldRequired(nodeAt(SPEC, 'decide'), 'options[0].next')).toBe(true);
    expect(isEdgeFieldRequired(nodeAt(SPEC, 'decide'), 'onTimeout')).toBe(true);
  });
});

describe('setSpecEdge', () => {
  it('retargets an option edge in place rather than adding a top-level key', () => {
    const next = setSpecEdge(SPEC, 'decide', 'options[1].next', 'approve');
    expect(optionTargets(next, 'decide')).toEqual(['doomed', 'approve']);
    expect(ownKeys(next, 'decide')).not.toContain('options[1].next');
    expect(() => parseWorkflowSpec(next)).not.toThrow();
  });

  it('clears an optional edge but parks a required one on the placeholder', () => {
    expect(setSpecEdge(SPEC, 'optional', 'next', null).nodes.optional).not.toHaveProperty('next');

    const cleared = setSpecEdge(SPEC, 'approve', 'onReject', null);
    expect(cleared.nodes.approve).toMatchObject({ onReject: UNRESOLVED_NODE_ID });
    expect(cleared.nodes[UNRESOLVED_NODE_ID]).toEqual({ status: 'SKIPPED', type: 'terminate' });
    expect(() => parseWorkflowSpec(cleared)).not.toThrow();
  });

  it('ignores an unknown node', () => {
    expect(setSpecEdge(SPEC, 'nope', 'next', 'end')).toBe(SPEC);
  });
});
