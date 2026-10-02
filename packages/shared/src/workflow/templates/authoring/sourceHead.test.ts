import { describe, expect, it } from 'vitest';
import { sourceHead } from './sourceHead.js';
import { expectWellFormed } from './testUtil.js';

describe('sourceHead', () => {
  const nodes = sourceHead({
    next: 'draft',
    provider: 'document',
    read: { pageId: { from: 'request.payload.sourcePageId' } },
  });

  it('resolves the workspace, then reads the source, then hands over', () => {
    expect(Object.keys(nodes).sort()).toEqual(['readSource', 'resolveWorkspace']);
    expect(nodes.resolveWorkspace).toMatchObject({
      config: { workspaceProvider: 'document' },
      inputs: { connectionId: { from: 'request.payload.connectionId' } },
      next: 'readSource',
      step: 'resolveWorkspace',
    });
    expect(nodes.readSource).toMatchObject({
      config: {},
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        pageId: { from: 'request.payload.sourcePageId' },
      },
      next: 'draft',
      step: 'readSource',
    });
    expectWellFormed(nodes, 'resolveWorkspace', ['draft']);
  });

  it('can send resolveWorkspace somewhere else first', () => {
    const branching = sourceHead({
      afterResolve: 'checkSource',
      next: 'draft',
      provider: 'record',
      read: { ticketId: { from: 'request.payload.ticketId' } },
    });
    expect(branching.resolveWorkspace).toMatchObject({
      config: { workspaceProvider: 'record' },
      next: 'checkSource',
    });
  });

  it('shares no inputs object between calls', () => {
    const read = { pageId: { from: 'p' } };
    const a = sourceHead({ next: 'n', provider: 'document', read });
    expect((a.readSource as unknown as { inputs: { pageId: object } }).inputs.pageId).not.toBe(
      read.pageId
    );
  });
});
