/**
 * Link translation for the published documentation site.
 *
 * The markdown under `docs/` is authored to be read as files in a checkout, so
 * every cross-reference in it is filesystem-relative: `./agents.md`,
 * `../AGENTS.md`, `./history/PLAN.md`. Left raw, each one 404s once the file is
 * served as a URL.
 *
 * The dashboard solves the same problem differently — see
 * `packages/web/src/lib/docLinks.ts`, which degrades anything it cannot serve to
 * plain grey text, because an operator inside the product has no business being
 * bounced out to GitHub. A public site has the opposite obligation: the reader
 * is already on the open web, so a link we do not publish should still go
 * somewhere useful. Here an unpublished target resolves to its file on GitHub
 * instead of dying.
 *
 * The algorithm is deliberately one rule rather than a table of special cases:
 *
 *   1. Leave anything that is not a relative path alone (absolute URLs,
 *      protocol-relative, `mailto:`, bare `#anchor`).
 *   2. Resolve the href against the *source file's* directory to get a
 *      repo-relative path.
 *   3. If that path is published, emit its site URL.
 *   4. Otherwise emit its GitHub URL.
 *
 * Adding a page to the site is therefore an entry in the route map and nothing
 * else; no rule in here needs to learn about it.
 */

/** Schemes and shapes that are already a valid URL for a browser. */
const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Splits `path#fragment?query` into its parts. Only the fragment is carried
 * through to the rewritten href — a query string on a relative file link is
 * meaningless in a checkout and never appears in this tree.
 */
function splitFragment(href) {
  const hash = href.indexOf('#');
  if (hash === -1) {
    return { fragment: '', path: href };
  }
  return { fragment: href.slice(hash), path: href.slice(0, hash) };
}

/**
 * Resolves `href` relative to the directory holding `sourcePath`, both
 * repo-relative, and returns a normalised repo-relative path.
 *
 * Hand-rolled rather than `node:path` so the result is always POSIX and always
 * repo-relative: `path.resolve` would produce an absolute filesystem path, and
 * on Windows a backslash-separated one, neither of which can index the route
 * map. `..` that escapes the repo root collapses to the root, which is the
 * closest thing to a correct answer for a link that was already broken.
 */
export function resolveRepoPath(sourcePath, href) {
  const base = sourcePath.split('/').slice(0, -1);
  const segments = href.startsWith('/') ? href.slice(1).split('/') : [...base, ...href.split('/')];

  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Rewrites one markdown href.
 *
 * @param {string} href As authored in the markdown.
 * @param {object} opts
 * @param {string} opts.sourcePath Repo-relative path of the file containing the link.
 * @param {Map<string, string>} opts.routes Repo-relative path -> published site URL.
 * @param {string} opts.repoUrl GitHub repo URL, no trailing slash.
 * @param {string} opts.ref Branch or tag the GitHub fallback links point at.
 * @returns {string} The href to emit.
 */
export function rewriteLink(href, { ref, repoUrl, routes, sourcePath }) {
  if (href === '' || href.startsWith('#') || ABSOLUTE_RE.test(href)) {
    return href;
  }

  const { fragment, path } = splitFragment(href);
  if (path === '') {
    return href;
  }

  const repoPath = resolveRepoPath(sourcePath, path);
  const published = routes.get(repoPath);
  if (published) {
    return `${published}${fragment}`;
  }

  // A trailing slash in the source means the author meant a directory, and
  // GitHub browses directories under `/tree/` rather than `/blob/`.
  const kind = path.endsWith('/') ? 'tree' : 'blob';
  return `${repoUrl}/${kind}/${ref}/${repoPath}${fragment}`;
}

/**
 * Applies {@link rewriteLink} to every inline link and reference definition in a
 * markdown document, skipping fenced code blocks.
 *
 * Fences are skipped because a link-shaped string inside one is sample text, not
 * navigation — rewriting it would silently corrupt an example. Nothing in this
 * tree does that today; the guard is here so that the first doc that does is not
 * broken by a script nobody thought to re-read.
 */
export function rewriteMarkdownLinks(markdown, opts) {
  // Inline `[text](href)` and `[text](href "title")`, plus bare autolinks are
  // left alone by the leading `](`. Hrefs containing balanced parentheses are
  // not supported, and none exist in this tree.
  const inline = /\]\(\s*(<[^>]*>|[^\s)]+)(\s+["'][^"']*["'])?\s*\)/g;
  // Reference definitions: `[label]: href "optional title"` at line start.
  const reference = /^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)/gm;

  const rewriteOne = (raw) => {
    const bare = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    const next = rewriteLink(bare, opts);
    return next === bare ? raw : next;
  };

  return mapOutsideFences(markdown, (chunk) =>
    chunk
      .replace(inline, (_match, href, title) => `](${rewriteOne(href)}${title ?? ''})`)
      .replace(reference, (_match, prefix, href) => `${prefix}${rewriteOne(href)}`)
  );
}

/**
 * Runs `fn` over the parts of `markdown` that are not inside a fenced code
 * block, leaving the fences and their contents byte-identical.
 *
 * Tracks the opening fence's exact marker so that a fence nested in a longer
 * fence (a ``` block shown inside a ```` block, which the workflow docs do) does
 * not close its parent early.
 */
function mapOutsideFences(markdown, fn) {
  const lines = markdown.split('\n');
  const out = [];
  let buffer = [];
  let fence = null;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(fn(buffer.join('\n')));
      buffer = [];
    }
  };

  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (marker) {
        flush();
        fence = marker;
        out.push(line);
        continue;
      }
      buffer.push(line);
      continue;
    }
    out.push(line);
    // A closing fence is the same character, at least as long, and carries no
    // info string — anything else is content.
    if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  }

  flush();
  return out.join('\n');
}
