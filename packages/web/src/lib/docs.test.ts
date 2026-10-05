import { describe, expect, it } from 'vitest';
import { deriveDescription, orderDocs } from './docs';

describe('deriveDescription', () => {
  it('skips front matter, headings and horizontal rules', () => {
    expect(deriveDescription('---\ntitle: x\n---\n# Title\n\n---\n\nFirst paragraph.')).toBe(
      'First paragraph.'
    );
    expect(deriveDescription('# Title\n---\nText here.')).toBe('Text here.');
  });

  it('accepts blockquote text and joins the paragraph lines', () => {
    expect(deriveDescription('# T\n\n> Guidelines for any\n> agent working here.\n\nNext')).toBe(
      'Guidelines for any agent working here.'
    );
  });

  it('strips links and emphasis', () => {
    expect(deriveDescription('# T\n\nSee [the **map**](./x.md) and `code`.')).toBe(
      'See the map and code.'
    );
  });

  it('cuts long text at a word boundary with an ellipsis', () => {
    const out = deriveDescription(`# T\n\n${'word '.repeat(60)}`);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out).not.toMatch(/wor…$/);
  });

  it('returns an empty string when there is no prose', () => {
    expect(deriveDescription('# Only a heading')).toBe('');
  });
});

describe('orderDocs', () => {
  it('pins Overview, Quickstart and Product overview first, then sorts by title', () => {
    const doc = (slug: string, title: string) => ({ description: '', slug, title });
    const out = orderDocs([
      doc('agents', 'Agents'),
      doc('product-overview', 'Product overview'),
      doc('architecture', 'Architecture'),
      doc('quickstart', 'Quickstart'),
      doc('README', 'Overview'),
    ]);
    expect(out.map((d) => d.slug)).toEqual([
      'README',
      'quickstart',
      'product-overview',
      'agents',
      'architecture',
    ]);
  });
});
