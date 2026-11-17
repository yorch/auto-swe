import { describe, expect, it } from 'vitest';
import { plainText } from './plainText.js';

const one = (s: unknown, max = 500) => plainText(s, { max });

describe('plainText', () => {
  it('returns the empty string for a non-string', () => {
    expect(one(undefined)).toBe('');
    expect(one(42)).toBe('');
  });

  it('keeps ordinary prose, file names and identifiers', () => {
    expect(one('Edit index.ts and scratch_notes, e.g. the README.')).toBe(
      'Edit index.ts and scratch_notes, e.g. the README.'
    );
  });

  it('drops control, zero-width and bidi characters', () => {
    expect(one('a\u200bb\u202ec\u2066d\u2069e\ufefff\u0007g\u009ch')).toBe('abcdefgh');
    expect(one('re\u202Evolt\u202C')).toBe('revolt');
  });

  it('keeps newlines only when multiline, and bounds blank lines', () => {
    expect(one('a\n\nb')).toBe('a b');
    expect(plainText('a\r\n\n\n\nb \t c', { max: 50, multiline: true })).toBe('a\n\nb c');
  });

  it('removes html tags, including an unterminated one and script bodies markers', () => {
    expect(one('hi <b>there</b> <script>x</script> <img src=x onerror=y')).toBe('hi there x');
    expect(one('a <scr\u200bipt>b')).toBe('a b');
  });

  it('keeps a markdown link label and image alt text but never the target or a stray !', () => {
    expect(one('see [the docs](https://evil.example/x) now')).toBe('see the docs now');
    expect(one('![logo](https://evil.example/p.png) done')).toBe('logo done');
    expect(one('look ![](https://evil.example/p.png)!')).toBe('look');
    expect(one('wow !https://evil.example/x')).toBe('wow');
    expect(one('[ref][1] and [x]: https://evil.example')).toBe('ref and [x]:');
  });

  it('removes URLs, mailto, www, bare domains and email addresses', () => {
    const out = one(
      'go https://a.example/p?q=1 or mailto:bob@evil.example or www.evil.example or evil.com/path or bob@evil.io, then evil.example.org:8080 end'
    );
    expect(out).not.toMatch(/evil|mailto|http|www/);
    expect(out).toContain('go');
    expect(out).toContain('end');
  });

  it('sees through full-width and mixed-case spellings', () => {
    expect(one('ＨＴＴＰＳ：／／evil.example/x ok')).not.toMatch(/evil/i);
    expect(one('HtTpS://evil.example ok')).toBe('ok');
    expect(one('＜b＞bold＜／b＞')).toBe('bold');
  });

  it('drops markdown marks', () => {
    expect(one('# **Title** `code` > quote ~~x~~')).toBe('Title code quote x');
  });

  it('cuts at the bound with an ellipsis and never splits a surrogate pair', () => {
    expect(one('abcdefghij', 5)).toBe('abcd…');
    const out = one('ab😀cd', 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out).toBe('ab…');
    expect(one('x'.repeat(2000), 500)).toHaveLength(500);
  });
});
