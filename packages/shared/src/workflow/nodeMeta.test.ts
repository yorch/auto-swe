import { describe, expect, it } from 'vitest';
import {
  findInvalidPresentation,
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

  describe('reading is tolerant: a bad value degrades to absent, it never fails the parse', () => {
    const step = { step: 'runLint', type: 'step' };
    const parsed = (extra: Record<string, unknown>) =>
      parseWorkflowSpec(
        base(
          {
            done: { status: 'SUCCESS', type: 'terminate' },
            s: { ...step, next: 'done', ...extra },
          },
          's'
        )
      ).nodes.s as { group?: string; title?: string };

    it.each([
      ['an over-long title', { title: 't'.repeat(MAX_NODE_TITLE_LENGTH + 1) }],
      ['an over-long group', { group: 'g'.repeat(MAX_NODE_GROUP_LENGTH + 1) }],
      ['an empty group', { group: '' }],
      ['a blank title', { title: '   ' }],
      ['a numeric group', { group: 7 }],
      ['an object title', { title: { en: 'x' } }],
      ['a null group', { group: null }],
      ['an array title', { title: ['x'] }],
    ])('%s parses, and the field is absent', (_what, extra) => {
      const node = parsed(extra);
      expect(node.group).toBeUndefined();
      expect(node.title).toBeUndefined();
      expect(JSON.stringify(node)).not.toMatch(/"(group|title)"/);
    });

    it('keeps a valid value, trimmed, so "ci" and "ci " are one group', () => {
      expect(parsed({ group: ' ci ', title: ' Build ' })).toMatchObject({
        group: 'ci',
        title: 'Build',
      });
      const edge = 'g'.repeat(MAX_NODE_GROUP_LENGTH);
      expect(parsed({ group: edge }).group).toBe(edge);
    });

    it('never costs a node its other fields', () => {
      expect(parsed({ group: 9, next: 'done' })).toMatchObject({ next: 'done', step: 'runLint' });
    });

    it('leaves a human node title strictly required', () => {
      expect(
        NodeSchema.safeParse({
          onApprove: 'e',
          onReject: 'e',
          onTimeout: 'e',
          timeout: '1h',
          title: '',
          type: 'humanApproval',
        }).success
      ).toBe(false);
    });
  });

  describe('findInvalidPresentation: the authoring-side limits', () => {
    const raw = (n: Record<string, unknown>) => ({
      nodes: { a: { step: 'x', type: 'step', ...n } },
    });

    it('accepts good values and absence', () => {
      expect(findInvalidPresentation(raw({}))).toEqual([]);
      expect(findInvalidPresentation(raw({ group: 'ci', title: 'T' }))).toEqual([]);
      expect(findInvalidPresentation(raw({ group: 'g'.repeat(MAX_NODE_GROUP_LENGTH) }))).toEqual(
        []
      );
    });

    it.each([
      ['an over-long title', { title: 't'.repeat(MAX_NODE_TITLE_LENGTH + 1) }, 'title'],
      ['an over-long group', { group: 'g'.repeat(MAX_NODE_GROUP_LENGTH + 1) }, 'group'],
      ['an empty group', { group: '' }, 'group'],
      ['a blank title', { title: '  ' }, 'title'],
      ['a non-string group', { group: 3 }, 'group'],
      ['a null title', { title: null }, 'title'],
    ])('rejects %s', (_what, extra, field) => {
      const issues = findInvalidPresentation(raw(extra));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(`'a'.${field}`);
    });

    it('does not judge a human node title (the schema owns it) but does judge its group', () => {
      const human = { nodes: { h: { title: 'x'.repeat(150), type: 'humanApproval' } } };
      expect(findInvalidPresentation(human)).toEqual([]);
      expect(
        findInvalidPresentation({ nodes: { h: { group: '', type: 'humanApproval' } } })
      ).toHaveLength(1);
    });

    it('is quiet on input that is not a spec', () => {
      expect(findInvalidPresentation(null)).toEqual([]);
      expect(findInvalidPresentation({ nodes: 'x' })).toEqual([]);
    });
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
