import { describe, expect, it } from 'vitest';
import { plainText } from './plainText.js';

const TLD_LIST =
  'com|org|net|io|dev|app|co|ai|info|biz|xyz|me|us|uk|de|fr|ru|cn|jp|in|br|nl|es|it|ca|au|ch|se|no|fi|pl|ly|sh|cc|tv|to|gg|top|site|online|cloud|tech|link|click|zip|mov';

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

  describe('hostile spellings', () => {
    it('removes a bare domain behind a leading dot, dash or underscore', () => {
      for (const lead of ['.', '-', '_', '..', '.-']) {
        const out = one(`visit ${lead}evil.com/login now`);
        expect(out).not.toMatch(/evil/);
        expect(out).toContain('visit');
        expect(out).toContain('now');
      }
    });

    it('sees through invisible and default-ignorable code points inside a scheme', () => {
      const ignorable = [
        '\u034f',
        '\u115f',
        '\u1160',
        '\u3164',
        '\uffa0',
        '\u180b',
        '\u180f',
        '\ufe0f',
        '\u{e0001}',
        '\u{e0068}',
        '\u{e007f}',
        '\u{e0100}',
        '\u{e01ef}',
      ];
      for (const c of ignorable) {
        expect(one(`go http${c}s://evil.example/p ok`)).toBe('go ok');
        expect(one(`go evil${c}.com ok`)).toBe('go ok');
      }
    });

    it('turns ideographic and half-width full stops into dots before removing a domain', () => {
      for (const dot of ['\u3002', '\uff0e', '\uff61']) {
        expect(one(`see evil${dot}com now`)).toBe('see now');
      }
    });

    it('is one pass: marks inside a URL, scheme or host cannot be reassembled afterwards', () => {
      for (const x of [
        'h`ttps://evil.example/p',
        'java*script:x',
        'evil.c*om',
        'ww*w.evil.com',
        'ht~tps://evil.example',
        'ht#tps://evil.example',
      ]) {
        const once = one(x);
        expect(once).not.toMatch(/:\/\/|www\.|javascript:|evil/i);
        expect(one(once)).toBe(once);
      }
    });

    it('removes a scheme-less `://` tail and a bare @host', () => {
      expect(one('a foo://bar.example/x b')).toBe('a b');
      expect(one('ping @evil.org now')).not.toMatch(/evil/);
      expect(one('_https://evil.example/x')).not.toContain('://');
    });

    it('does not widen on a second call when it cut with an ellipsis', () => {
      const first = plainText('word '.repeat(200), { max: 50 });
      expect(first.endsWith('…')).toBe(true);
      expect(plainText(first, { max: 50 })).toBe(first);
    });

    it('is idempotent and leaves nothing link-like, over random hostile strings', () => {
      const alphabet = [
        'http',
        'https',
        'ftp',
        'javascript:',
        '://',
        'www.',
        '.',
        '.',
        '*',
        '`',
        '_',
        '[',
        '](',
        ')',
        '<',
        '>',
        '\u200d',
        '\u034f',
        '\u{e0068}',
        '\ufe0f',
        '\u3164',
        'evil.com',
        '.evil.com',
        '@',
        ' ',
        ' ',
        'a',
        'x.io',
        '\u3002',
        '#',
        '~',
        '!',
        '\n',
      ];
      let seed = 0x9e3779b9;
      const rand = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
        return (seed >>> 0) / 2 ** 32;
      };
      const tlds = new RegExp(`[\\p{L}\\p{N}_-]+\\.(?:${TLD_LIST})(?![\\p{L}\\p{N}_])`, 'iu');
      for (let i = 0; i < 25000; i += 1) {
        let x = '';
        const n = 1 + Math.floor(rand() * 14);
        for (let j = 0; j < n; j += 1) {
          x += alphabet[Math.floor(rand() * alphabet.length)];
        }
        for (const multiline of [false, true]) {
          const o = { max: 300, multiline };
          const out = plainText(x, o);
          expect(plainText(out, o), JSON.stringify(x)).toBe(out);
          expect(out, JSON.stringify(x)).not.toMatch(/:\/\/|www\./i);
          expect(out, JSON.stringify(x)).not.toMatch(/@[\p{L}\p{N}-]+\.\p{L}{2,}/u);
          expect(out, JSON.stringify(x)).not.toMatch(/[<>]/);
          expect(out, JSON.stringify(x)).not.toMatch(tlds);
        }
      }
    });
  });
});
