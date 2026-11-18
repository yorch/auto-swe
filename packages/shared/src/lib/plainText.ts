/**
 * Plain text from model-written (or otherwise untrusted) prose, for places a person reads it as if
 * the platform had said it: the plan preview's summary, a generated workflow's name and
 * description, the router's reasons.
 *
 * What a model writes there can be shaped by an injected ticket or template description, and the
 * reader is about to make an approval decision on it. So it is reduced to words. One normalisation
 * pass runs these steps in this order, and the whole pass repeats until the text stops changing
 * (at most 5 passes; text that still changes is dropped, not returned):
 *
 * 1. NFKC (full-width `＜` and `ｈｔｔｐ` become the plain forms the rules match; the ellipsis the
 *    cut appends is kept as it is, so a second call does not widen it), then ideographic and
 *    half-width full stops become `.`;
 * 2. control characters (C0 except newline when `multiline`, DEL, C1), zero-width, bidi and other
 *    default-ignorable code points (combining grapheme joiner, Hangul and half-width fillers,
 *    Mongolian free variation selectors, variation selectors, the Unicode tag block) are dropped:
 *    they hide text, reorder it or smuggle it past a pattern;
 * 3. markdown emphasis, code, heading and strikethrough marks (`*`, backtick, `#`, `~`) are
 *    dropped BEFORE any link or URL rule, so `h*ttps://` cannot be reassembled into a URL
 *    afterwards (underscores stay: identifiers use them);
 * 4. HTML tags, markdown images and links (the label survives, the target does not), autolinks,
 *    URLs and any `scheme://`, `mailto:` addresses, `www.` hosts, email addresses (also a bare
 *    `@host.tld`) and bare domains on a common top-level domain are removed, wherever they sit in
 *    a word (a leading `.`, `-` or `_` does not hide one);
 * 5. whitespace is collapsed.
 *
 * The result is then cut at a code point boundary, with an ellipsis, to `max` UTF-16 units. The cut
 * belongs to the same fixed point: the pass-and-cut pair repeats until the output stops changing,
 * so `plainText(plainText(x)) === plainText(x)`.
 *
 * Bare-domain removal is deliberately narrow (a list of common TLDs): `index.ts` must survive in
 * a plan that names a file, so a domain on an unusual TLD can pass. The text is shown as text,
 * never as markup, so this is a second line behind that, not the only one.
 *
 * Pure and I/O-free.
 */

// Built from parts: a literal class holding a joiner, a variation selector or the combining
// grapheme joiner next to other characters reads to the linter as a misleading sequence, but here
// each is a code point to delete on its own.
const INVISIBLE = new RegExp(
  [
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160]',
    '[\\u180b-\\u180f\\u200b-\\u200c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e]',
    '[\\u2060-\\u2064\\u2066-\\u2069\\u3164\\ufeff\\uffa0]',
    '\\u034f',
    '\\u200d',
    '[\\ufe00-\\ufe0f]',
    '[\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}]',
  ].join('|'),
  'gu'
);

const TLDS =
  'com|org|net|io|dev|app|co|ai|info|biz|xyz|me|us|uk|de|fr|ru|cn|jp|in|br|nl|es|it|ca|au|ch|se|no|fi|pl|ly|sh|cc|tv|to|gg|top|site|online|cloud|tech|link|click|zip|mov';

/** No look-behind: a leading `.`, `-` or `_` must not keep a domain from matching. */
const BARE_DOMAIN = new RegExp(
  `(?:[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_-]{0,61}[\\p{L}\\p{N}_])?\\.){1,8}(?:${TLDS})\\b(?::\\d+)?(?:/\\S*)?`,
  'giu'
);

/** `text` without control, zero-width and bidi formatting characters. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

export interface PlainTextOptions {
  /** Longest result, in UTF-16 units (ellipsis included). */
  max: number;
  /** Keep line breaks (at most one blank line); default collapses everything to one line. */
  multiline?: boolean;
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = Math.max(0, max - 1);
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}

const CUT_MARK = '…';
const MAX_PASSES = 5;

/** One normalisation pass (steps 1-5 of the module comment). */
function normalise(text: string, multiline: boolean): string {
  // NFKC would turn the cut's ellipsis into three dots, so it is kept out of the normalised parts.
  let t = text
    .split(CUT_MARK)
    .map((part) => part.normalize('NFKC'))
    .join(CUT_MARK)
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ');
  t = stripInvisible(t);
  t = t.replace(/[`*#~]+/g, '');
  // Tags, including an unterminated one at the end of the text.
  t = t.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, '');
  // Images first, so no `!` is left in front of a removed link.
  t = t.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');
  t = t.replace(/(?:https?|ftp|file|data|javascript|vbscript):\/*\S*/gi, '');
  t = t.replace(/[\w+.-]*:\/\/\S*/g, '');
  t = t.replace(/mailto:\S*/gi, '');
  t = t.replace(/www\.\S*/gi, '');
  t = t.replace(/[\w.+-]*@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/giu, '');
  t = t.replace(BARE_DOMAIN, '');
  t = t.replace(/(^|\s)!+(?=\s|$)/gm, '$1');
  if (multiline) {
    return t
      .split('\n')
      .map((line) => line.replace(/[ \u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Reduce `input` to bounded plain text. Non-strings become the empty string. */
export function plainText(input: unknown, options: PlainTextOptions): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Bounded before any pattern runs: the patterns are linear, but a half-megabyte string is
  // still no reason to scan all of it for a result of a few hundred characters.
  let t = input.slice(0, options.max * 4 + 64);
  const multiline = options.multiline === true;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = cut(normalise(t, multiline), options.max);
    if (next === t) {
      return t;
    }
    t = next;
  }
  // Still changing after the bound: nothing safe to show.
  return '';
}
