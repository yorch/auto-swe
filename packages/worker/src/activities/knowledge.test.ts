import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), search: vi.fn() }));
vi.mock('../lib/runKnowledgeBases.js', () => ({ loadRunKnowledgeBases: mocks.load }));
vi.mock('../lib/knowledgeBaseSearch.js', () => ({ searchRunKnowledge: mocks.search }));

import { retrieveKnowledge } from './knowledge.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockImplementation(async ({ knowledgeBases }) => ({
    checkouts: [],
    snapshotIds: knowledgeBases === false ? [] : ['pin-a'],
  }));
  mocks.search.mockResolvedValue({ injectionDropped: 0, mode: 'text', results: [] });
});
describe('retrieveKnowledge KB scope', () => {
  it('loads pinned ids without credentials and returns the additive merged projection', async () => {
    const output = {
      injectionDropped: 1,
      mode: 'semantic',
      results: [{ citation: 'kb:acme/docs@abcdef0 guide.md', sourceKind: 'knowledge_base' }],
    };
    mocks.search.mockResolvedValue(output);
    expect(await retrieveKnowledge({ limit: 2, query: 'parser' })).toEqual(output);
    expect(mocks.load).toHaveBeenCalledWith({
      checkoutCredentials: false,
      knowledgeBases: undefined,
    });
    expect(mocks.search).toHaveBeenCalledWith('parser', { limit: 2, snapshotIds: ['pin-a'] });
  });
  it('honors opt-out without granting any KB snapshot ids', async () => {
    await retrieveKnowledge({ knowledgeBases: false, query: 'parser' });
    expect(mocks.load).toHaveBeenCalledWith({ checkoutCredentials: false, knowledgeBases: false });
    expect(mocks.search).toHaveBeenCalledWith('parser', { limit: undefined, snapshotIds: [] });
  });
});
