/**
 * Text from a repository (file names, frontmatter keys) made safe to show:
 * control characters become `?` and the length is bounded, so a hostile name
 * cannot carry a terminal escape or reshape a log or error line.
 */
export function safeDisplayPath(p: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = p.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
