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

// Bidi/zero-width/format characters, plus every control character except what
// `multiline` keeps (newline, and tab, which are layout in a text body).
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const INVISIBLE_OR_LAYOUT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

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
