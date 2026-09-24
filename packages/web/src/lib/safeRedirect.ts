/**
 * Validate a post-sign-in `?redirect=` value and return a same-origin path, or
 * `fallback` when the value could send the browser anywhere else.
 *
 * A prefix check (`startsWith('/') && !startsWith('//')`) is not enough:
 * browsers treat `\` as `/` in special-scheme URLs, so `/\evil.com` resolves to
 * `//evil.com`, and tab/newline characters are stripped before parsing, so
 * `/\t/evil.com` does too. The value is therefore resolved against the real
 * origin and accepted only when the origin survives, and backslashes and
 * control characters — raw or percent-encoded — are rejected outright rather
 * than trusted to any one parser's normalisation.
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  origin: string,
  fallback = '/'
): string {
  if (!raw?.startsWith('/') || raw.startsWith('//')) {
    return fallback;
  }
  // Raw backslashes / control characters, and their percent-encoded forms
  // (%5C, %00-%1F, %7F) — a later decode must not be able to recreate them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\\\u0000-\u001f\u007f]/.test(raw) || /%(5c|[01][0-9a-f]|7f)/i.test(raw)) {
    return fallback;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (resolved.origin !== new URL(origin).origin) {
    return fallback;
  }
  // Validating the input is not enough: URL resolution collapses dot segments,
  // so `/.//evil.com`, `/a/..//evil.com` or `/%2e%2e//evil.com` resolve to a
  // pathname of `//evil.com` — same origin as a URL, but a protocol-relative
  // (external) target once handed to the router as a string. Check the output.
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  if (path.startsWith('//') || path.startsWith('/\\')) {
    return fallback;
  }
  return path;
}
