import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from './csv.js';

describe('csvCell', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('plain')).toBe('plain');
  });

  it.each(['=SUM(A1)', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'defuses text that starts like a formula: %j',
    (text) => {
      expect(csvCell(text).replace(/^"/, '')).toMatch(/^'/);
    }
  );

  it('defuses before quoting, so a quoted formula is still defused', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('leaves a formula character that is not first alone', () => {
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('writes numbers and booleans as they are, negative numbers included', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(true)).toBe('true');
  });

  it('is empty for null and undefined, and JSON for structured values', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('csvRow', () => {
  it('joins the cells and ends the line', () => {
    expect(csvRow(['a', 1, null, '=x'])).toBe("a,1,,'=x\n");
  });
});
