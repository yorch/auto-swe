/**
 * What the public site publishes, and where each page lands.
 *
 * This is the one place that answers "is this file on the site?". The sync
 * script copies from it, the link rewriter indexes it to decide whether a
 * cross-reference stays on the site or leaves for GitHub, and `astro.config.mjs`
 * builds the sidebar from it — so a doc added to `docs/` cannot quietly go
 * unlinked.
 */

/** GitHub Pages serves the repo at a subpath, so every site URL carries it. */
export const BASE = '/auto-swe';
export const REPO_URL = 'https://github.com/yorch/auto-swe';

/**
 * The ref that GitHub fallback links point at.
 *
 * `main` rather than the commit being built: those links go to files the site
 * does not publish — `AGENTS.md`, `.env.example`, frozen docs under `history/` —
 * and a reader following one wants the current file, not a snapshot of whatever
 * was deployed.
 */
export const REPO_REF = 'main';

/**
 * Top-level `docs/` is published; `history/` and `redesign/` are not.
 *
 * Same call the dashboard makes, for the same reason: `history/` is frozen by
 * convention, and frozen docs shown to a reader who has no way to know that read
 * as current behaviour. They stay one GitHub link away, which is where a reader
 * chasing design rationale should end up anyway.
 */
export const DOCS_DIR = 'docs';

/** Where the synced `docs/` tree lands, both on disk and in URLs. */
export const DOCS_ROUTE_PREFIX = 'docs';

/**
 * `docs/README.md` is the index of the living docs, so it becomes the index of
 * the docs section rather than a page named "README". Its own H1 is the bare
 * word "Documentation", which is a useless sidebar entry sitting above sixteen
 * other documentation pages.
 */
export const DOCS_INDEX = {
  description: 'Index of the living documentation — start here',
  file: `${DOCS_ROUTE_PREFIX}/index.md`,
  slug: DOCS_ROUTE_PREFIX,
  source: `${DOCS_DIR}/README.md`,
  title: 'Overview',
};

/**
 * Files published from outside `docs/`.
 *
 * Both are heavily cross-referenced from inside `docs/`, so publishing them
 * turns the two most common outbound links into ordinary in-site navigation.
 * Everything else outside `docs/` — `AGENTS.md`, the skills, `.env.example` —
 * stays a GitHub link on purpose: it is contributor material, not product
 * documentation, and a public docs site that mixes the two teaches the reader
 * the wrong thing about which is which.
 */
export const EXTERNAL_PAGES = [
  {
    description: 'What auto-swe is, the flagship flow, and how the pieces fit together',
    file: 'introduction.md',
    slug: 'introduction',
    source: 'README.md',
    title: 'Introduction',
  },
  {
    description: 'The auto-swe command line — work requests, runs, templates, tokens, bundles',
    file: 'reference/cli.md',
    slug: 'reference/cli',
    source: 'packages/cli/README.md',
    title: 'CLI reference',
  },
];

/**
 * Sidebar placement for every published page, by route slug.
 *
 * Ordered within each group as a reader should meet them, which is not
 * alphabetical: what the product is, then how it is built, then what it can do,
 * then how to run it.
 *
 * The sync script fails if a published page is missing from here, or if an entry
 * here names a page that is not published. Both are silent otherwise — an
 * unplaced doc still builds and still resolves by URL, it is simply absent from
 * the navigation, so no reader ever arrives at it.
 */
export const SIDEBAR = [
  {
    label: 'Start here',
    slugs: ['introduction', 'docs', 'docs/product-overview', 'docs/architecture', 'docs/agents'],
  },
  {
    label: 'Capabilities',
    slugs: [
      'docs/hitl-workflows',
      'docs/autonomy-policies',
      'docs/evals',
      'docs/channel-assistant',
      'docs/nl-workflow-authoring',
      'docs/figma-integration',
      'docs/repo-dependency-graph',
      'docs/repo-access-gating',
      'docs/bundles',
    ],
  },
  {
    label: 'Configuration & operations',
    slugs: [
      'docs/configuration',
      'docs/deployment',
      'docs/model-configuration',
      'docs/oauth-setup',
      'docs/github-app-setup',
      'docs/slack-app-setup',
      'reference/cli',
    ],
  },
];

/** Site URL for a route slug, with the GitHub Pages base path applied. */
export function siteUrl(slug) {
  return slug === '' ? `${BASE}/` : `${BASE}/${slug}/`;
}
