import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { CONTAINER_AUTHORING_RULE, countContainerNodes } from './containerNodes';

const spec = (nodes: Record<string, unknown>) =>
  ({ entry: 'a', name: 'x', nodes, schemaVersion: 1 }) as unknown as WorkflowSpec;

describe('countContainerNodes', () => {
  it('counts shell and containerStep nodes, and ignores other nodes and non-container steps', () => {
    expect(
      countContainerNodes(
        spec({
          a: { command: 'x', image: 'node:24-alpine', type: 'shell' },
          b: { image: 'node:24-alpine', type: 'containerStep' },
          c: { status: 'SUCCESS', type: 'terminate' },
          d: { step: 'runTests', type: 'step' },
          e: { step: 'runContainerStep', type: 'step' },
        })
      )
    ).toBe(3);
  });

  it('is zero for no spec or a spec without such nodes', () => {
    expect(countContainerNodes(null)).toBe(0);
    expect(countContainerNodes(spec({ c: { status: 'SUCCESS', type: 'terminate' } }))).toBe(0);
  });

  it('states both gates: platform lead and a team or platform admin', () => {
    expect(CONTAINER_AUTHORING_RULE).toMatch(/platform admin/);
    expect(CONTAINER_AUTHORING_RULE).toMatch(/at least a platform lead/);
    expect(CONTAINER_AUTHORING_RULE).toMatch(/global template/);
  });
});
