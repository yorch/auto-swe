import { describe, expect, it } from 'vitest';
import { nodeTitlesOf } from './nodeTitles';

describe('nodeTitlesOf', () => {
  it('maps titled nodes and ignores the rest', () => {
    const titles = nodeTitlesOf({
      nodes: {
        implement: { title: ' Implement the change ', type: 'agent' },
        tests: { type: 'x' },
      },
    });
    expect(titles.get('implement')).toBe('Implement the change');
    expect(titles.has('tests')).toBe(false);
  });

  it('tolerates a missing or malformed spec', () => {
    expect(nodeTitlesOf(null).size).toBe(0);
    expect(nodeTitlesOf({ nodes: 5 }).size).toBe(0);
  });
});
