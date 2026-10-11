import { describe, expect, it } from 'vitest';
import {
  buildSearchIndex,
  highlight,
  indexDoc,
  MAX_RESULTS,
  searchDocs,
  tokenize,
} from './docSearch';
import { extractToc } from './docToc';

const DOC = `# Agents

Lead paragraph about **agents** and [skills](./skills.md).

## Skills

A skill is a prompt fragment. See [the guide](https://example.com/secret-url).

\`\`\`ts
const hiddenInFence = 'zebracode';
\`\`\`

| Name | Role |
| ---- | ---- |
| implementer | writes code |

### Tools

Tools are executable. Use \`readFile\` to read.

## Skills

Second skills section.
`;

describe('indexDoc', () => {
  const sections = indexDoc(DOC);

  it('anchors every heading section with the id extractToc gives it', () => {
    const toc = extractToc(DOC);
    expect(sections.filter((s) => s.anchor).map((s) => s.anchor)).toEqual(toc.map((t) => t.id));
    expect(sections.map((s) => s.anchor)).toEqual([null, 'skills', 'tools', 'skills-1']);
  });

  it('keeps the lead before the first heading as an unanchored section', () => {
    expect(sections[0]).toMatchObject({ anchor: null, heading: null });
    expect(sections[0]?.text).toBe('Lead paragraph about agents and skills.');
  });

  it('strips code fences, link targets and table syntax', () => {
    const text = sections.map((s) => s.text).join(' ');
    expect(text).not.toContain('zebracode');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
    expect(text).not.toContain('**');
    expect(text).toContain('the guide');
    expect(text).toContain('implementer writes code');
  });

  it('keeps inline code words, which readers search for', () => {
    expect(sections[2]?.text).toBe('Tools are executable. Use readFile to read.');
  });

  it('stays in step when a heading is nested in a blockquote', () => {
    const md = '## One\n\ntext\n\n> ## Quoted\n\n## Two\n\nbody\n';
    const toc = extractToc(md);
    const anchors = indexDoc(md).map((s) => s.anchor);
    expect(anchors).toEqual(['one', 'two']);
    expect(toc.map((t) => t.id)).toEqual(['one', 'quoted', 'two']);
  });
});

const INDEX = buildSearchIndex([
  {
    content: '# Agents\n\nIntro.\n\n## Skills\n\nSkills shape reasoning. Budget is unrelated.\n',
    slug: 'agents',
    title: 'Agents',
  },
  {
    content: '# Budgets\n\n## Limits\n\nThe budget caps tokens for a skill-heavy run.\n',
    slug: 'budgets',
    title: 'Budgets',
  },
  {
    content:
      '# Evals\n\n## Scoring\n\nA budget of tokens and a skill appear here.\n\n## Budget\n\nCaps.\n',
    slug: 'evals',
    title: 'Evals',
  },
]);

describe('searchDocs', () => {
  it('ranks title over heading over body', () => {
    const r = searchDocs(INDEX, 'budget');
    // Budgets (title+body), Evals "Budget" heading, then body-only matches
    expect(r.map((x) => `${x.slug}#${x.anchor}`)).toEqual([
      'budgets#limits',
      'evals#budget',
      'agents#skills',
      'evals#scoring',
    ]);
  });

  it('requires every term to match (AND), across title, heading and body', () => {
    const r = searchDocs(INDEX, 'budget skill');
    expect(r.map((x) => `${x.slug}#${x.anchor}`)).toEqual([
      'budgets#limits',
      'agents#skills',
      'evals#scoring',
    ]);
    expect(searchDocs(INDEX, 'budget zebra')).toEqual([]);
  });

  it('is case-insensitive and ignores repeated terms and extra whitespace', () => {
    expect(searchDocs(INDEX, '  BUDGET   budget ')).toEqual(searchDocs(INDEX, 'budget'));
  });

  it('returns nothing for a blank query or no match', () => {
    expect(searchDocs(INDEX, '   ')).toEqual([]);
    expect(searchDocs(INDEX, 'nonexistentterm')).toEqual([]);
  });

  it('bounds the result count', () => {
    const many = buildSearchIndex([
      {
        content: Array.from({ length: 50 }, (_, i) => `## S${i}\n\nneedle ${i}\n`).join('\n'),
        slug: 'many',
        title: 'Many',
      },
    ]);
    expect(searchDocs(many, 'needle')).toHaveLength(MAX_RESULTS);
    expect(searchDocs(many, 'needle', 3)).toHaveLength(3);
  });

  it('returns highlighted segments for title, heading and snippet', () => {
    const [first] = searchDocs(INDEX, 'budget');
    expect(first?.title).toEqual([
      { match: true, text: 'Budget' },
      { match: false, text: 's' },
    ]);
    expect(first?.snippet.some((s) => s.match && s.text.toLowerCase() === 'budget')).toBe(true);
    const lead = searchDocs(INDEX, 'intro')[0];
    expect(lead?.heading).toBeNull();
  });

  it('windows a long section around the first match with ellipses', () => {
    const long = `${'filler word '.repeat(60)}needle ${'trailing word '.repeat(60)}`;
    const idx = buildSearchIndex([{ content: `## A\n\n${long}\n`, slug: 'x', title: 'X' }]);
    const [r] = searchDocs(idx, 'needle');
    const text = r?.snippet.map((s) => s.text).join('') ?? '';
    expect(text.length).toBeLessThan(220);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(r?.snippet.some((s) => s.match)).toBe(true);
  });
});

describe('highlight', () => {
  it('never produces markup: html in the text stays literal text', () => {
    const segs = highlight('<img src=x onerror=alert(1)> script', ['script']);
    expect(segs.map((s) => s.text).join('')).toBe('<img src=x onerror=alert(1)> script');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['script']);
  });

  it('treats regex metacharacters in a term literally', () => {
    expect(highlight('a (b) c', ['(b)'])).toEqual([
      { match: false, text: 'a ' },
      { match: true, text: '(b)' },
      { match: false, text: ' c' },
    ]);
    expect(() => highlight('x', ['[', '*', '\\'])).not.toThrow();
  });

  it('matches case-insensitively but keeps the original casing', () => {
    expect(highlight('Skill skill', ['SKILL']).map((s) => s.text)).toEqual(['Skill', ' ', 'skill']);
  });

  it('returns no segments for empty text and one plain run without terms', () => {
    expect(highlight('', ['a'])).toEqual([]);
    expect(highlight('abc', [])).toEqual([{ match: false, text: 'abc' }]);
  });
});

describe('tokenize', () => {
  it('lowercases, splits on whitespace and de-duplicates', () => {
    expect(tokenize(' Foo  bar FOO ')).toEqual(['foo', 'bar']);
  });
});
