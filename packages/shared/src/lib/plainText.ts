/**
 * Plain text from model-written (or otherwise untrusted) prose, for places a person reads it as if
 * the platform had said it: the plan preview's summary, a generated workflow's name and
 * description, the router's reasons.
 *
 * What a model writes there can be shaped by an injected ticket or template description, and the
 * reader is about to make an approval decision on it. So it is reduced to words:
 *
 * - the text is NFKC-normalised first (full-width `＜` and `ｈｔｔｐ` become the plain forms the
 *   rules below match);
 * - control characters (C0 except newline when `multiline`, DEL, C1), zero-width and bidi
 *   formatting characters (U+200B-200F, U+2028-2029, U+202A-202E, U+2060-2064, U+2066-2069, U+FEFF)
 *   are dropped: they hide text or reorder what is displayed;
 * - HTML tags, markdown images and links (the label survives, the target does not), autolinks,
 *   URLs, `mailto:` addresses and bare domains on a common top-level domain are removed, so the
 *   text cannot carry a clickable or copyable destination;
 * - markdown emphasis and heading marks are dropped, whitespace is collapsed and the result is cut
 *   at a code point boundary, with an ellipsis, to `max` UTF-16 units.
 *
 * Bare-domain removal is deliberately narrow (a list of common TLDs): `index.ts` must survive in
 * a plan that names a file, so a domain on an unusual TLD can pass. The text is shown as text,
 * never as markup, so this is a second line behind that, not the only one.
 *
 * Pure and I/O-free.
 */

const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const TLDS =
  'com|org|net|io|dev|app|co|ai|info|biz|xyz|me|us|uk|de|fr|ru|cn|jp|in|br|nl|es|it|ca|au|ch|se|no|fi|pl|ly|sh|cc|tv|to|gg|top|site|online|cloud|tech|link|click|zip|mov';

const BARE_DOMAIN = new RegExp(
  `(?:^|(?<=[^\\w@.-]))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.){1,8}(?:${TLDS})\\b(?::\\d+)?(?:/\\S*)?`,
  'gi'
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

/** Reduce `input` to bounded plain text. Non-strings become the empty string. */
export function plainText(input: unknown, options: PlainTextOptions): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Bounded before any pattern runs: the patterns are linear, but a half-megabyte string is
  // still no reason to scan all of it for a result of a few hundred characters.
  let t = input
    .slice(0, options.max * 4 + 64)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n');
  t = stripInvisible(t.replace(/\t/g, ' '));
  // Tags, including an unterminated one at the end of the text.
  t = t.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, '');
  // Images first, so no `!` is left in front of a removed link.
  t = t.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');
  t = t.replace(/\b(?:https?|ftp|file|data|javascript|vbscript):\/*\S*/gi, '');
  t = t.replace(/\bmailto:\S*/gi, '');
  t = t.replace(/\bwww\.\S+/gi, '');
  t = t.replace(/[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi, '');
  t = t.replace(BARE_DOMAIN, '');
  // Emphasis, code, heading, quote and strikethrough marks. Underscores stay: identifiers use them.
  t = t.replace(/[`*#>~]+/g, '').replace(/(^|\s)!+(?=\s|$)/gm, '$1');
  if (options.multiline) {
    t = t
      .split('\n')
      .map((line) => line.replace(/[ \u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    t = t.replace(/\s+/g, ' ').trim();
  }
  return cut(t, options.max);
}
