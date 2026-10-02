import { describe, expect, it } from 'vitest';
import {
  MAX_NODE_GROUP_LENGTH,
  MAX_NODE_TITLE_LENGTH,
  NodeSchema,
  nodeEdges,
  parseWorkflowSpec,
  SPEC_SCHEMA_VERSION,
} from './spec.js';

const base = (nodes: Record<string, unknown>, entry: string) => ({
  description: '',
  entry,
  name: 'meta',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
});

// A spec exactly as stored before `group`/`title` existed.
const legacy = base(
  {
    ask: {
      description: 'Approve it',
      onApprove: 'done',
      onReject: 'done',
      onTimeout: 'done',
      timeout: '1h',
      title: 'Approve the change',
      type: 'humanApproval',
    },
    done: { result: {}, status: 'SUCCESS', type: 'terminate' },
    implement: { next: 'ask', step: 'executeImplementation', type: 'step' },
  },
  'implement'
);

describe('node group/title metadata', () => {
  it('parses a spec stored before the fields existed, adding no keys', () => {
    const parsed = parseWorkflowSpec(legacy);
    expect(Object.hasOwn(parsed.nodes.implement, 'group')).toBe(false);
    expect(Object.hasOwn(parsed.nodes.implement, 'title')).toBe(false);
    expect(Object.hasOwn(parsed.nodes.done, 'group')).toBe(false);
    // The only key the parse adds is the `onError` default the schema always applied.
    expect(JSON.parse(JSON.stringify(parsed.nodes))).toEqual({
      ...legacy.nodes,
      implement: { ...(legacy.nodes.implement as object), onError: 'fail' },
    });
  });

  const TYPES: Array<[string, Record<string, unknown>]> = [
    ['step', { step: 'runLint', type: 'step' }],
    ['agent', { agentRef: 'reviewer', type: 'agent' }],
    ['mcp', { connectionRef: 'c', tool: 't', type: 'mcp' }],
    ['eval', { scorers: [{ kind: 'pii' }], target: { literal: 1 }, type: 'eval' }],
    ['set', { type: 'set', values: { 'context.a': { literal: 1 } } }],
    ['cond', { expr: 'a == 1', onFalse: 'end', onTrue: 'end', type: 'cond' }],
    ['signal', { name: 's', onReceive: 'end', onTimeout: 'end', timeout: '1h', type: 'signal' }],
    ['terminate', { status: 'SUCCESS', type: 'terminate' }],
    ['fanOut', { join: 'end', over: { literal: [] }, subgraph: 'end', type: 'fanOut' }],
    ['shell', { command: 'ls', image: 'node:24-alpine', type: 'shell' }],
    ['containerStep', { image: 'img', type: 'containerStep' }],
  ];

  it.each(TYPES)('accepts group and title on a %s node', (_name, node) => {
    const parsed = NodeSchema.parse({ ...node, group: 'review loop', title: 'A short title' });
    expect(parsed).toMatchObject({ group: 'review loop', title: 'A short title' });
  });

  const HUMAN: Array<[string, Record<string, unknown>]> = [
    [
      'humanApproval',
      { onApprove: 'e', onReject: 'e', onTimeout: 'e', timeout: '1h', type: 'humanApproval' },
    ],
    [
      'humanDecision',
      {
        onTimeout: 'e',
        options: [
          { label: 'a', next: 'e', value: 'a' },
          { label: 'b', next: 'e', value: 'b' },
        ],
        timeout: '1h',
        type: 'humanDecision',
      },
    ],
    [
      'humanInput',
      {
        fields: [{ key: 'k', label: 'L', type: 'text' }],
        onSubmit: 'e',
        onTimeout: 'e',
        timeout: '1h',
        type: 'humanInput',
      },
    ],
    [
      'humanReview',
      {
        contentFrom: 'context.x',
        onSubmit: 'e',
        onTimeout: 'e',
        timeout: '1h',
        type: 'humanReview',
      },
    ],
  ];

  it.each(HUMAN)('keeps the inbox title REQUIRED on %s and adds only group', (_name, node) => {
    expect(NodeSchema.safeParse(node).success).toBe(false); // no title
    const ok = NodeSchema.parse({ ...node, group: 'approval', title: 'Approve the thing' });
    expect(ok).toMatchObject({ group: 'approval', title: 'Approve the thing' });
    // Their title keeps its own, longer bound.
    expect(
      NodeSchema.safeParse({ ...node, title: 't'.repeat(MAX_NODE_TITLE_LENGTH + 1) }).success
    ).toBe(true);
  });

  it('bounds group and title, and refuses empty strings', () => {
    const step = { step: 'runLint', type: 'step' };
    expect(
      NodeSchema.safeParse({ ...step, group: 'g'.repeat(MAX_NODE_GROUP_LENGTH) }).success
    ).toBe(true);
    expect(
      NodeSchema.safeParse({ ...step, group: 'g'.repeat(MAX_NODE_GROUP_LENGTH + 1) }).success
    ).toBe(false);
    expect(
      NodeSchema.safeParse({ ...step, title: 't'.repeat(MAX_NODE_TITLE_LENGTH + 1) }).success
    ).toBe(false);
    expect(NodeSchema.safeParse({ ...step, group: '' }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...step, title: '' }).success).toBe(false);
  });

  it('does not touch the edges of a node that carries them', () => {
    const node = NodeSchema.parse({
      expr: 'a == 1',
      group: 'g',
      onFalse: 'x',
      onTrue: 'y',
      title: 'T',
      type: 'cond',
    });
    expect(nodeEdges(node)).toEqual([
      ['onTrue', 'y'],
      ['onFalse', 'x'],
    ]);
  });
});
