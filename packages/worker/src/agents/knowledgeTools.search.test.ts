import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/knowledgeBaseSearch.js', () => ({ searchRunKnowledge: search }));

import { buildKnowledgeTools, SEARCH_KNOWLEDGE_OUTPUT_SCHEMA } from './knowledgeTools.js';

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue({ injectionDropped: 0, mode: 'text', results: [] });
});
describe('searchKnowledge snapshot binding', () => {
  it('captures a copy of the scope before tool execution, not from model input or a later run', async () => {
    const ids = ['pin-a'];
    const tools = buildKnowledgeTools(undefined, { snapshotIds: ids });
    ids[0] = 'pin-another-run';
    await tools.searchKnowledge.execute?.(
      { limit: 2, query: 'parser', snapshotIds: ['pin-another-run'] } as never,
      {} as never
    );
    expect(search).toHaveBeenCalledWith('parser', { limit: 2, snapshotIds: ['pin-a'] });
  });
  it('searches no KBs without a bound scope', async () => {
    const tools = buildKnowledgeTools();
    await tools.searchKnowledge.execute?.({ query: 'parser' }, {} as never);
    expect(search).toHaveBeenCalledWith('parser', { limit: undefined, snapshotIds: [] });
  });
  it('accepts both legacy governed results and additive KB metadata', () => {
    const legacy = {
      citation: 'knowledge:item:v1',
      content: 'Text',
      id: 'item',
      title: 'Item',
      trustLabel: 'REVIEWED',
      type: 'FACT',
      version: 1,
    };
    expect(
      SEARCH_KNOWLEDGE_OUTPUT_SCHEMA.safeParse({ mode: 'text', results: [legacy] }).success
    ).toBe(true);
    expect(
      SEARCH_KNOWLEDGE_OUTPUT_SCHEMA.safeParse({
        injectionDropped: 1,
        mode: 'semantic',
        results: [
          {
            ...legacy,
            heading: null,
            path: 'guide.md',
            snapshotId: 'pin-a',
            sourceKind: 'knowledge_base',
          },
        ],
      }).success
    ).toBe(true);
  });
});
