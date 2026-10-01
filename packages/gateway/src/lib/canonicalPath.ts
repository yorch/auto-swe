/**
 * Whether a request target's path is already in the form URL resolution
 * produces — no `.`/`..` segments, encoded or not, and no `\` separators.
 *
 * Fastify routes on the raw path, but a handler that resolves the URL before
 * dispatching (better-auth's does) can serve a different path than the one
 * that matched. A per-route policy — a stricter rate limit, an allow-list —
 * then applies to one path while another is served, so a handler like that
 * must refuse a path it would rewrite.
 */
export function isCanonicalRequestPath(rawUrl: string): boolean {
  const query = rawUrl.indexOf('?');
  const path = query === -1 ? rawUrl : rawUrl.slice(0, query);
  try {
    return new URL(path, 'http://canonical.invalid').pathname === path;
  } catch {
    return false;
  }
}
