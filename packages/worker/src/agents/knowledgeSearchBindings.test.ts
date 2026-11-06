import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/knowledgeBaseSearch.js', () => ({ searchRunKnowledge: search }));

import { piKnowledgeTool } from './knowledgeSearchBindings.js';
import { bindKnowledgeSearch } from './knowledgeTools.js';

function toolFor(ids: string[]) {
  const binding = bindKnowledgeSearch(ids);
  if (!binding) {
    throw new Error('Expected a pinned search binding');
  }
  return piKnowledgeTool(binding);
}

beforeEach(() => vi.resetAllMocks());
describe('Pi knowledge AgentTool', () => {
  it('preserves citations and trust labels, with only query and limit exposed to the model', async () => {
    const ids = ['pin-a'];
    const tool = toolFor(ids);
    ids[0] = 'another-run';
    const result = {
      injectionDropped: 1,
      mode: 'text',
      results: [
        {
          citation: 'kb:acme/docs@abcdef0 guide.md',
          sourceKind: 'knowledge_base',
          trustLabel: 'UNTRUSTED_THIRD_PARTY_REFERENCE',
        },
      ],
    };
    search.mockResolvedValue(result);
    const output = await tool.execute('call', {
      includeGoverned: true,
      query: 'parser',
      snapshotIds: ['another-run'],
    } as never);
    expect(search).toHaveBeenCalledExactlyOnceWith('parser', {
      includeGoverned: false,
      limit: undefined,
      snapshotIds: ['pin-a'],
    });
    expect(output.content).toEqual([{ text: JSON.stringify(result), type: 'text' }]);
    expect(tool.parameters).toHaveProperty('properties.query');
    expect(tool.parameters).not.toHaveProperty('properties.snapshotIds');
    expect(tool.parameters).not.toHaveProperty('properties.includeGoverned');
  });
  it('propagates execution errors rather than returning unverified references', async () => {
    search.mockRejectedValue(new Error('unavailable'));
    const tool = toolFor(['pin-a']);
    await expect(tool.execute('call', { query: 'parser' })).rejects.toThrow('unavailable');
  });
});
