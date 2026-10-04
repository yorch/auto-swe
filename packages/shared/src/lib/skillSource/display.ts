/**
 * Text from a repository (file names, frontmatter keys) made safe to show:
 * control characters, the bidirectional overrides (U+202A-202E, U+2066-2069,
 * U+200E/F) and zero-width characters (U+200B-200D, U+2060-2064, U+FEFF) become
 * `?` and the length is bounded, so a hostile name cannot carry a terminal
 * escape, reorder what a reviewer reads or reshape a log or error line.
 */
export function safeDisplayPath(p: string): string {
  const clean = p.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    '?'
  );
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
