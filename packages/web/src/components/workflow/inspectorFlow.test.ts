import { describe, expect, it } from 'vitest';
import { parseResetVisits } from './inspectorFlow';

describe('parseResetVisits', () => {
  const ids = ['fetchLogs', 'fix', 'review'];

  it('splits on commas and whitespace, keeps order and drops repeats', () => {
    expect(parseResetVisits('fetchLogs, fix  fetchLogs', ids)).toEqual({
      ids: ['fetchLogs', 'fix'],
    });
  });

  it('reads an empty draft as clearing the field', () => {
    expect(parseResetVisits('  , ', ids)).toEqual({ ids: undefined });
  });

  it('names every id that is not a node', () => {
    expect(parseResetVisits('fix, nope, gone', ids)).toEqual({
      error: 'Not a node of this workflow: nope, gone',
    });
  });

  it('refuses more ids than the schema allows', () => {
    const many = Array.from({ length: 21 }, (_, i) => `n${i}`);
    expect(parseResetVisits(many.join(','), many)).toEqual({ error: 'At most 20 nodes' });
  });
});
