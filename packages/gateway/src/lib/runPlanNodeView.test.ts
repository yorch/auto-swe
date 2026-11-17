import { describe, expect, it } from 'vitest';
import { describeNode, nodesFeedingImplementer } from './runPlanNodeView.js';

const CORE = new Set(['implement']);

describe('describeNode', () => {
  it('summarises inputs as source paths and never shows a literal', () => {
    const view = describeNode(
      {
        agentRef: 'planner@2',
        inputs: {
          calc: { expr: "'x'" },
          goal: { from: 'request.description' },
          secret: { literal: 'hunter2' },
        },
        storeAs: 'context.planNotes',
        type: 'agent',
      },
      true
    );
    expect(view).toEqual({
      agentRef: 'planner@2',
      feedsImplementer: true,
      inputs: [
        { from: null, hasDefault: false, key: 'calc' },
        { from: 'request.description', hasDefault: false, key: 'goal' },
        { from: null, hasDefault: false, key: 'secret' },
      ],
      writes: ['context.planNotes'],
    });
    expect(JSON.stringify(view)).not.toContain('hunter2');
  });

  it('lists a set node write targets and cleans and bounds a message', () => {
    const view = describeNode(
      {
        next: 'x',
        type: 'set',
        userMessage: `<b>${'a'.repeat(900)}</b>`,
        values: {
          'context.planNotes': { from: 'nodes.r.output' },
          'context.scratch.a': { literal: 1 },
        },
      },
      false
    );
    expect(view.agentRef).toBeNull();
    expect(view.writes).toEqual(['context.planNotes', 'context.scratch.a']);
    expect((view.message ?? '').length).toBeLessThanOrEqual(500);
    expect(view.message).not.toContain('<b>');
  });

  it('says whether an input has a fallback, and never carries the fallback value', () => {
    const view = describeNode(
      {
        inputs: {
          a: { default: 'SECRET-FALLBACK', from: 'context.ticket' },
          b: { default: 0, from: 'context.n' },
          c: { from: 'context.ticket' },
        },
        step: 'retrieveKnowledge',
        type: 'step',
      },
      false
    );
    expect(view.inputs).toEqual([
      { from: 'context.ticket', hasDefault: true, key: 'a' },
      { from: 'context.n', hasDefault: true, key: 'b' },
      { from: 'context.ticket', hasDefault: false, key: 'c' },
    ]);
    expect(JSON.stringify(view)).not.toContain('SECRET-FALLBACK');
  });

  it('omits the message when the node has none', () => {
    expect('message' in describeNode({ step: 's', type: 'step' }, false)).toBe(false);
  });
});

describe('nodesFeedingImplementer', () => {
  it('marks a node that stores the notes and the agents it reads from', () => {
    const nodes = {
      a: {
        agentRef: 'x',
        inputs: { g: { from: 'request.description' } },
        next: 'b',
        type: 'agent',
      },
      b: {
        agentRef: 'x',
        inputs: { p: { from: 'nodes.a.output' } },
        next: 'c',
        storeAs: 'context.planNotes',
        type: 'agent',
      },
      c: {
        agentRef: 'x',
        inputs: { g: { from: 'request.description' } },
        next: 'implement',
        storeAs: 'context.scratch.z',
        type: 'agent',
      },
      implement: {
        inputs: { guidance: { from: 'context.planNotes' } },
        step: 'executeImplementation',
        type: 'step',
      },
    };
    expect([...nodesFeedingImplementer(nodes, CORE)].sort()).toEqual(['a', 'b']);
  });

  it('follows a set node and a scratch path to the agent behind them', () => {
    const nodes = {
      a: { agentRef: 'x', next: 's', storeAs: 'context.scratch.draft', type: 'agent' },
      implement: { step: 'executeImplementation', type: 'step' },
      other: { agentRef: 'x', next: 's', storeAs: 'context.scratch.unrelated', type: 'agent' },
      s: {
        next: 'implement',
        type: 'set',
        values: { 'context.planNotes': { from: 'context.scratch.draft' } },
      },
    };
    expect([...nodesFeedingImplementer(nodes, CORE)].sort()).toEqual(['a', 's']);
  });

  it('marks nothing when no node writes the notes, and never marks a core node', () => {
    const nodes = {
      a: { agentRef: 'x', storeAs: 'context.scratch.q', type: 'agent' },
      implement: { inputs: { guidance: { from: 'context.planNotes' } }, step: 'e', type: 'step' },
    };
    expect(nodesFeedingImplementer(nodes, CORE).size).toBe(0);
  });
});
