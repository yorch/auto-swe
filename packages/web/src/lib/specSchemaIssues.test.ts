import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { schemaIssues } from './specSchemaIssues';

const specWith = (a: Record<string, unknown>): WorkflowSpec =>
  ({
    entry: 'a',
    name: 'x',
    nodes: { a, end: { status: 'SUCCESS', type: 'terminate' } },
    schemaVersion: 1,
  }) as unknown as WorkflowSpec;

describe('schemaIssues', () => {
  it('reports nothing for a valid spec', () => {
    expect(schemaIssues(specWith({ next: 'end', step: 'build', type: 'step' }))).toEqual([]);
  });

  it('names the node, the field and the offending value for an unknown node type', () => {
    const issues = schemaIssues(specWith({ next: 'end', type: 'bogus' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'SCHEMA',
      field: 'type',
      nodeId: 'a',
      severity: 'error',
    });
    expect(issues[0]?.message).toContain(`node 'a' has unknown type "bogus"`);
  });

  it('reports a node with no type at all, on the same node and field', () => {
    const issues = schemaIssues(specWith({ next: 'end' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'SCHEMA', field: 'type', nodeId: 'a' });
    expect(issues[0]?.message).toContain(`node 'a' has no type`);
  });

  it.each([
    ['a number', 5, `node 'a' has a non-text type`],
    ['null', null, `node 'a' has a non-text type`],
    ['an object', {}, `node 'a' has a non-text type`],
  ])('says a present but non-text type is not text, for %s', (_name, type, expected) => {
    const issues = schemaIssues(specWith({ next: 'end', type }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'SCHEMA', field: 'type', nodeId: 'a' });
    expect(issues[0]?.message).toContain(expected);
    expect(issues[0]?.message).not.toContain('no type');
  });

  it('says no type only when the type key is absent', () => {
    const issues = schemaIssues(specWith({ next: 'end' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain(`node 'a' has no type`);
    expect(issues[0]?.message).not.toContain('non-text');
  });

  it('does not reword an ordinary field error', () => {
    const issues = schemaIssues(specWith({ agentRef: '', next: 'end', type: 'agent' }));
    expect(issues[0]).toMatchObject({ field: 'agentRef', nodeId: 'a' });
    expect(issues[0]?.message).not.toMatch(/unknown type|no type/);
  });
});
