import { describe, expect, it } from 'vitest';
import { resolveKnowledgeBaseSet } from './knowledgeBaseResolution.js';

const link = (knowledgeBaseId: string) => ({ knowledgeBaseId });
describe('resolveKnowledgeBaseSet', () => {
  it('returns empty results for no links and does not mutate inputs', () => {
    expect(resolveKnowledgeBaseSet({ cap: 4 })).toEqual({
      dropped: [],
      refusedExclusions: [],
      selected: [],
    });
    const teamLinks = Object.freeze([Object.freeze(link('a'))]);
    expect(resolveKnowledgeBaseSet({ cap: 4, teamLinks }).selected).toHaveLength(1);
  });
  it('adds across every level and orders by specificity', () => {
    const result = resolveKnowledgeBaseSet({
      cap: 4,
      repoLinks: [link('b')],
      runOverrides: { add: [link('d')] },
      teamLinks: [link('a')],
      templateLinks: [link('c')],
    });
    expect(result.selected.map((x) => [x.knowledgeBaseId, x.source])).toEqual([
      ['d', 'RUN'],
      ['c', 'TEMPLATE'],
      ['b', 'REPO'],
      ['a', 'TEAM'],
    ]);
  });
  it('dedupes with the most specific ref and mount while mandatory sticks', () => {
    const result = resolveKnowledgeBaseSet({
      cap: 4,
      repoLinks: [{ ...link('a'), mountName: 'new', ref: 'new' }],
      teamLinks: [{ ...link('a'), mandatory: true, mountName: 'old', ref: 'old' }],
    });
    expect(result.selected).toEqual([
      { knowledgeBaseId: 'a', mandatory: true, mountName: 'new', ref: 'new', source: 'REPO' },
    ]);
    expect(
      resolveKnowledgeBaseSet({
        cap: 4,
        runOverrides: { add: [link('a')] },
        teamLinks: [{ ...link('a'), ref: 'old' }],
      }).selected[0].ref
    ).toBeNull();
  });
  it('excludes inherited entries at template and run levels, allowing a run to re-add', () => {
    const base = {
      cap: 4,
      teamLinks: [link('a'), link('b')],
      templateLinks: [{ ...link('a'), exclude: true }],
    };
    expect(
      resolveKnowledgeBaseSet({ ...base, runOverrides: { exclude: ['b', 'missing'] } }).selected
    ).toEqual([]);
    expect(
      resolveKnowledgeBaseSet({
        ...base,
        runOverrides: { add: [link('a')], exclude: ['b'] },
      }).selected.map((x) => x.knowledgeBaseId)
    ).toEqual(['a']);
  });
  it('refuses mandatory exclusions, once per id, even with a more specific override', () => {
    const result = resolveKnowledgeBaseSet({
      cap: 4,
      runOverrides: { add: [{ ...link('a'), ref: 'pin' }], exclude: ['a', 'a'] },
      teamLinks: [{ ...link('a'), mandatory: true }],
      templateLinks: [{ ...link('a'), exclude: true }],
    });
    expect(result.refusedExclusions).toEqual(['a']);
    expect(result.selected[0]).toMatchObject({ mandatory: true, ref: 'pin', source: 'RUN' });
  });
  it('caps mandatory first, then specificity, with stable id ties and a full dropped list', () => {
    const result = resolveKnowledgeBaseSet({
      cap: 2,
      repoLinks: [link('c')],
      runOverrides: { add: [link('e'), link('d')] },
      teamLinks: [{ ...link('z'), mandatory: true }, link('b')],
    });
    expect(result.selected.map((x) => x.knowledgeBaseId)).toEqual(['z', 'd']);
    expect(result.dropped.map((x) => x.knowledgeBaseId)).toEqual(['e', 'c', 'b']);
    expect(resolveKnowledgeBaseSet({ cap: 0, teamLinks: [link('a')] }).dropped).toHaveLength(1);
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid cap %s', (cap) => {
    expect(() => resolveKnowledgeBaseSet({ cap })).toThrow(RangeError);
  });
});
