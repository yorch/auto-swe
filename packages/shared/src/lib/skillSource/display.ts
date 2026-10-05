/**
 * Text from a repository (file names, frontmatter keys) made safe to show: every
 * control (Cc) and format (Cf) character, line and paragraph separator, and every
 * Default_Ignorable_Code_Point (soft hyphen, variation selectors, the Hangul fillers,
 * Unicode tag characters, the bidirectional controls, zero-width characters) becomes
 * `?`, and the length is bounded, so a hostile name cannot carry a terminal escape,
 * hide text only a model reads, reorder what a reviewer reads or reshape a log or
 * error line. The dashboard and the CLI use the same classes.
 */
// An emoji must render as one: a variation selector after a pictograph (not (c), (r), TM), a
// keycap's selector and a joiner between two pictographs are left alone; the rest is replaced.
export const HIDDEN_CHARACTERS =
  /(?!(?:(?<=[0-9#*])\uFE0F(?=\u20E3)|(?<=[\p{Emoji_Presentation}\p{Extended_Pictographic}])(?<![\u00A9\u00AE\u2122])[\uFE0E\uFE0F]))(?!(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)\u200D(?=\p{Extended_Pictographic}))[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

export function safeDisplayPath(p: string): string {
  const clean = p.replace(HIDDEN_CHARACTERS, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
