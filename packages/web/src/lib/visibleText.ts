/**
 * Make invisible and direction-changing characters in repository-derived text
 * VISIBLE. The gateway deliberately stores skill text and descriptions as they
 * are, bidi overrides and zero-width characters included, so what a reviewer
 * reads is exactly what an agent will be given; hiding them (or dropping them)
 * would let `\u202e` reorder a diff line or a name on screen while the stored
 * text says something else. Mirrors the CLI's visible mode.
 *
 * Every repo-derived string the dashboard renders — names, descriptions, paths,
 * folders, diff lines, full text — goes through here and is rendered as plain
 * text (never as HTML).
 */

// Every control (Cc) and format (Cf) character, the line and paragraph separators and
// every Default_Ignorable_Code_Point: soft hyphen, variation selectors, the Hangul
// fillers, the combining grapheme joiner, Unicode tag characters (U+E0000-E007F, which a
// model reads and a reviewer does not), the bidi controls and zero-width characters. The
// `u` flag matches whole code points, so an astral character gets one marker. A text body
// keeps newline and tab, which are layout.
const HIDDEN = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]';
// An emoji must render as one. Left alone: a variation selector right after a pictograph or
// emoji-presentation character (but not after (c), (r) or TM), the selector of a keycap (a
// digit, # or * then U+20E3), and a joiner between two pictographs (a skin tone modifier or a
// variation selector may sit before it). Everything else is marked, and tag characters always.
const EMOJI_OK =
  '(?!(?:(?<=[0-9#*])\\uFE0F(?=\\u20E3)|(?<=[\\p{Emoji_Presentation}\\p{Extended_Pictographic}])(?<![\\u00A9\\u00AE\\u2122])[\\uFE0E\\uFE0F]))(?!(?<=\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic}))';
const INVISIBLE = new RegExp(`(?![\\n\\t])${EMOJI_OK}${HIDDEN}`, 'gu');
const INVISIBLE_OR_LAYOUT = new RegExp(`${EMOJI_OK}${HIDDEN}`, 'gu');

const marker = (c: string) =>
  `⟨U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}⟩`;

/**
 * `⟨U+202E⟩` for each hidden character. A one-line string (a name, a path) has
 * its newlines and tabs shown too; pass `{ multiline: true }` for a text body
 * whose line breaks and tabs are real layout.
 */
export function visibleText(s: string, opts: { multiline?: boolean } = {}): string {
  return s.replace(opts.multiline ? INVISIBLE : INVISIBLE_OR_LAYOUT, marker);
}

/** Null-tolerant form for optional fields. */
export const visibleOrNull = (s: string | null | undefined): string | null =>
  s == null ? null : visibleText(s);
