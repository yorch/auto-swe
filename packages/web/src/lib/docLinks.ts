/**
 * Rewriting relative Markdown links for the in-app docs surface.
 *
 * The living docs are written to be read as files in a checkout, where
 * `[agents.md](./agents.md)` resolves against the filesystem. `/docs/[slug]`
 * renders those same files as pages, and there the href resolves against the
 * *URL* — `./agents.md` from `/docs/architecture` becomes `/docs/agents.md`,
 * which the route rejects (`dynamicParams = false`, and the slug pattern has no
 * dot). Every cross-doc link was a 404.
 *
 * Only the top level of `docs/` is served. `docs/history/` is frozen by
 * convention and deliberately not published to product users, and links out to
 * `../AGENTS.md` leave the docs tree entirely. Those cannot become working
 * hrefs here, so they render as plain text rather than as links that lie.
 */

/** Slugs the `/docs/[slug]` route will serve. Mirrors `SLUG_RE` in `docs.ts`. */
export const DOC_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export type DocLinkResolution =
  /** An href to render as-is: external, in-app, or a bare anchor. */
  | { kind: 'href'; href: string }
  /** A doc page on this surface. */
  | { kind: 'doc'; href: string }
  /**
   * A repository file the dashboard does not serve. Render the link text as
   * plain text — a dead link is worse than no link.
   */
  | { kind: 'unserved'; reason: string };

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Allow only http, https, and mailto URLs to be rendered as live links. */
export function isSafeExternalUrl(href: string): boolean {
  for (const scheme of SAFE_EXTERNAL_SCHEMES) {
    if (href.toLowerCase().startsWith(scheme)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a `./x/y.md`-style href against the directory of the doc containing
 * it, without touching the filesystem. Returns null if it escapes `docs/`.
 */
function resolveWithinDocs(href: string): string | null {
  // Doc pages are flat, so every link is relative to `docs/` itself.
  const segments: string[] = [];
  for (const part of href.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      // One `..` from `docs/` leaves the tree. There is nowhere above to serve.
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/**
 * Decide what a Markdown href should become on the docs surface.
 *
 * @param href       the raw href from the Markdown source
 * @param servedSlugs slugs `/docs/[slug]` will actually render
 */
export function resolveDocLink(href: string, servedSlugs: ReadonlySet<string>): DocLinkResolution {
  if (!href) {
    return { href, kind: 'href' };
  }

  // Safe absolute URLs (http, https, mailto) are passed through.
  // Protocol-relative links and other schemes (e.g. javascript:) are treated
  // as unserved to prevent XSS via crafted Markdown links.
  if (isSafeExternalUrl(href)) {
    return { href, kind: 'href' };
  }

  // A bare anchor stays on the page.
  if (href.startsWith('#')) {
    return { href, kind: 'href' };
  }

  const [path, ...rest] = href.split('#');
  const anchor = rest.length > 0 ? `#${rest.join('#')}` : '';

  // Root-relative links are dashboard routes (`/studio/models`), already valid.
  // Protocol-relative `//host` links are not considered safe because they inherit
  // the page's scheme and can point anywhere.
  if (path.startsWith('/') && !path.startsWith('//')) {
    return { href, kind: 'href' };
  }

  if (!/\.md$/i.test(path)) {
    // A relative non-Markdown asset (`./slack-app-manifest.json`, `./redesign/`)
    // is not copied into the app's public tree, so it has no working URL.
    return { kind: 'unserved', reason: 'not a Markdown document' };
  }

  const resolved = resolveWithinDocs(path);
  if (resolved === null) {
    return { kind: 'unserved', reason: 'outside the docs directory' };
  }

  const slug = resolved.replace(/\.md$/i, '');

  if (slug.includes('/')) {
    // `history/evals-rfc`, `redesign/README` — a subdirectory. Only the top
    // level is served, and `history/` is frozen on purpose.
    return { kind: 'unserved', reason: 'not published to the dashboard' };
  }

  if (!DOC_SLUG_RE.test(slug) || !servedSlugs.has(slug)) {
    return { kind: 'unserved', reason: 'no such doc page' };
  }

  return { href: `/docs/${slug}${anchor}`, kind: 'doc' };
}
