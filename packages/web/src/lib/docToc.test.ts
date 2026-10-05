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

  it('counts setext headings, which the renderer also turns into h2', () => {
    const toc = extractToc('Setext title\n------------\n\n## Next\n');
    expect(toc).toEqual([
      { id: 'setext-title', level: 2, text: 'Setext title' },
      { id: 'next', level: 2, text: 'Next' },
    ]);
  });

  it('counts headings inside blockquotes and skips raw HTML headings', () => {
    const toc = extractToc('> ## Quoted\n\n<h2>Raw</h2>\n\n## After\n');
    expect(toc.map((entry) => entry.id)).toEqual(['quoted', 'after']);
  });
});
