import { beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/knowledgeBaseSearch.js', () => ({ searchRunKnowledge: search }));

import {
  bindKnowledgeSearch,
  buildKnowledgeTools,
  SEARCH_KNOWLEDGE_OUTPUT_SCHEMA,
} from './knowledgeTools.js';

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
    expect(search).toHaveBeenCalledWith('parser', {
      includeGoverned: false,
      limit: 2,
      snapshotIds: ['pin-a'],
    });
  });
  it('searches governed knowledge without KBs only with an explicit grant', async () => {
    const tools = buildKnowledgeTools(undefined, { includeGoverned: true });
    await tools.searchKnowledge.execute?.({ query: 'parser' }, {} as never);
    expect(search).toHaveBeenCalledWith('parser', {
      includeGoverned: true,
      limit: undefined,
      snapshotIds: [],
    });
  });
  it('refuses search without pinned snapshots or an explicit governed grant', async () => {
    const tools = buildKnowledgeTools();
    await expect(tools.searchKnowledge.execute?.({ query: 'parser' }, {} as never)).rejects.toThrow(
      'Knowledge search is unavailable'
    );
    expect(search).not.toHaveBeenCalled();
  });
  it('defaults to KB-only results and describes only that binding', async () => {
    search.mockImplementation(async (_query, options) => ({
      mode: 'text',
      results: [
        {
          citation: 'kb:acme/reference@abcdef0 guide.md',
          content: 'Parser reference',
          id: 'chunk-a',
          sourceKind: options.includeGoverned ? 'governed' : 'knowledge_base',
          title: 'Parser',
          trustLabel: 'UNTRUSTED_THIRD_PARTY_REFERENCE',
          type: 'REFERENCE',
          version: 0,
        },
      ],
    }));
    const tools = buildKnowledgeTools(undefined, { snapshotIds: ['pin-a'] });
    const result = await tools.searchKnowledge.execute?.(
      { includeGoverned: true, query: 'parser' } as never,
      {} as never
    );
    expect(result).toMatchObject({ results: [{ sourceKind: 'knowledge_base' }] });
    expect(search).toHaveBeenCalledWith('parser', {
      includeGoverned: false,
      limit: undefined,
      snapshotIds: ['pin-a'],
    });
    expect(tools.searchKnowledge.description).toContain('references only');
    expect(tools.searchKnowledge.description).not.toContain('governed');
  });
  it('describes merged search only when explicitly granted', () => {
    const tools = buildKnowledgeTools(undefined, { includeGoverned: true, snapshotIds: ['pin-a'] });
    expect(tools.searchKnowledge.description).toContain(
      'pinned knowledge base references and explicitly granted governed knowledge'
    );
  });
  it('does not bind without pins or a governed grant', () => {
    expect(bindKnowledgeSearch([])).toBeUndefined();
  });
  it.each([false, true])(
    'binds governed access only when explicitly granted: %s',
    async (includeGoverned) => {
      const ids = ['pin-a'];
      const binding = bindKnowledgeSearch(ids, includeGoverned);
      ids[0] = 'other-run';
      await binding?.execute({ query: 'parser', snapshotIds: ['other-run'] });
      expect(search).toHaveBeenCalledWith('parser', {
        includeGoverned,
        limit: undefined,
        snapshotIds: ['pin-a'],
      });
    }
  );
  it('rejects invalid model input before searching', () => {
    const binding = bindKnowledgeSearch(['pin-a']);
    expect(() => binding?.execute({ limit: 11, query: '' })).toThrow();
    expect(search).not.toHaveBeenCalled();
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
