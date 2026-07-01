import { describe, expect, it } from 'vitest';
import { extractFigmaRefs, normalizeFigmaNodeId } from './figmaDesign.js';

describe('normalizeFigmaNodeId', () => {
  it('converts the URL/anchor dash form to the API colon form', () => {
    expect(normalizeFigmaNodeId('1-23')).toBe('1:23');
  });

  it('decodes percent-encoded colons', () => {
    expect(normalizeFigmaNodeId('1%3A23')).toBe('1:23');
  });

  it('leaves an already-colon id unchanged', () => {
    expect(normalizeFigmaNodeId('42:7')).toBe('42:7');
  });
});

describe('extractFigmaRefs', () => {
  it('returns [] for empty/nullish input', () => {
    expect(extractFigmaRefs('')).toEqual([]);
    expect(extractFigmaRefs(null)).toEqual([]);
    expect(extractFigmaRefs(undefined)).toEqual([]);
    expect(extractFigmaRefs('no links here')).toEqual([]);
  });

  it('parses a /file/ URL with a node-id', () => {
    const refs = extractFigmaRefs(
      'See https://www.figma.com/file/abc123/My-Design?node-id=1-23 for the spec'
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].fileKey).toBe('abc123');
    expect(refs[0].nodeIds).toEqual(['1:23']);
  });

  it('parses a /design/ URL with a percent-encoded node-id', () => {
    const refs = extractFigmaRefs('https://figma.com/design/XyZ9/Flow?node-id=10%3A5&t=foo');
    expect(refs).toHaveLength(1);
    expect(refs[0].fileKey).toBe('XyZ9');
    expect(refs[0].nodeIds).toEqual(['10:5']);
  });

  it('handles a whole-file URL with no node-id', () => {
    const refs = extractFigmaRefs('https://www.figma.com/file/KEY/Whole-File');
    expect(refs).toHaveLength(1);
    expect(refs[0].fileKey).toBe('KEY');
    expect(refs[0].nodeIds).toEqual([]);
  });

  it('deduplicates by file key, merging node ids', () => {
    const refs = extractFigmaRefs(
      [
        'https://www.figma.com/file/SAME/A?node-id=1-1',
        'https://www.figma.com/file/SAME/B?node-id=2-2',
        'https://www.figma.com/file/OTHER/C?node-id=3-3',
      ].join('\n')
    );
    expect(refs).toHaveLength(2);
    const same = refs.find((r) => r.fileKey === 'SAME');
    expect(same?.nodeIds).toEqual(['1:1', '2:2']);
  });

  it('does not duplicate the same node id repeated for one file', () => {
    const refs = extractFigmaRefs(
      'https://www.figma.com/file/K/A?node-id=1-1 https://www.figma.com/file/K/A?node-id=1-1'
    );
    expect(refs[0].nodeIds).toEqual(['1:1']);
  });

  it('ignores non-figma URLs', () => {
    expect(extractFigmaRefs('https://example.com/file/abc?node-id=1-1')).toEqual([]);
  });
});
