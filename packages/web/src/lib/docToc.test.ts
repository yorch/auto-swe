import { describe, expect, it } from 'vitest';
import { extractToc } from './docToc';

describe('extractToc', () => {
  it('lists h2 and h3 headings with unique ids', () => {
    const toc = extractToc('# Title\n\n## Intro\n\n### Detail\n\n## Intro\n');
    expect(toc).toEqual([
      { id: 'intro', level: 2, text: 'Intro' },
      { id: 'detail', level: 3, text: 'Detail' },
      { id: 'intro-1', level: 2, text: 'Intro' },
    ]);
  });

  it('ignores headings inside code fences and strips inline markup', () => {
    const toc = extractToc('```\n## not a heading\n```\n## The `foo` [link](x) *bar*\n');
    expect(toc).toEqual([{ id: 'the-foo-link-bar', level: 2, text: 'The foo link bar' }]);
  });
});
