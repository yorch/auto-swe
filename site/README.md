# Public documentation site

The living docs, rendered for the open web and published to GitHub Pages at
<https://yorch.github.io/auto-swe/>.

This workspace owns no documentation. Everything it publishes is copied in from elsewhere in the
repository at build time, so there is exactly one copy of every sentence and nothing to keep in
sync by hand.

## Working on it

```bash
yarn dev:site      # http://localhost:4321/auto-swe/ — syncs docs/, then watches
yarn workspace @auto-swe/site build     # production build into site/dist
yarn workspace @auto-swe/site sync      # copy step alone, without starting Astro
```

The dev server serves under `/auto-swe/` because that is the path GitHub Pages serves the repo
from, and a base path that only exists in production is a base path nobody tests.

## What gets published

| Source | Lands at |
|---|---|
| `docs/*.md`, top level only | `/docs/<name>/` |
| `docs/README.md` | `/docs/` |
| Root `README.md` | `/introduction/` |
| `packages/cli/README.md` | `/reference/cli/` |
| `src/content/docs/index.mdx` | `/` — the one hand-authored page |

`docs/history/` and `docs/redesign/` are deliberately absent, matching the dashboard. Frozen docs
shown to a reader with no way to know they are frozen read as current behaviour.

## Editing

**Edit the source, never the copy.** `src/content/docs/docs/`, `src/content/docs/reference/`, and
`src/content/docs/introduction.md` are generated, gitignored, and deleted and rewritten on every
sync. Only `src/content/docs/index.mdx` is authored here.

Adding a doc to `docs/` is enough to publish it, but it must also be placed in `SIDEBAR` in
[`scripts/manifest.mjs`](./scripts/manifest.mjs). The build fails if it is not — an unplaced doc
still builds and still resolves by URL, so without that check nothing would notice that no reader
can reach it.

## How it fits together

| File | Does |
|---|---|
| [`scripts/manifest.mjs`](./scripts/manifest.mjs) | The single answer to "is this file on the site, and where?" — routes, sidebar, base path, GitHub fallback ref |
| [`scripts/syncDocs.mjs`](./scripts/syncDocs.mjs) | Copies each source in, derives frontmatter from its H1 and lead paragraph, points "Edit this page" at the true source |
| [`scripts/docLinks.mjs`](./scripts/docLinks.mjs) | Rewrites every filesystem-relative link: published targets become site URLs, everything else becomes a GitHub URL |
| [`astro.config.mjs`](./astro.config.mjs) | Starlight and mermaid configuration; builds the sidebar from the manifest |

The link policy is the opposite of the dashboard's, deliberately. `packages/web/src/lib/docLinks.ts`
greys out a link it cannot serve; this sends it to GitHub. An operator inside the product should not
be thrown out to a source tree, and a reader already on the open web should not hit a dead end.

## Deployment

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds and deploys on every push to
`main` that touches `docs/`, either published README, or this workspace.

One manual step is needed the first time, and this workflow deliberately cannot do it: in the
repository's **Settings → Pages**, set the source to **GitHub Actions**. Automating it would mean
granting `pages: write` to the job that installs dependencies and runs project code, which is the
one job that should not hold it.

## Limitations

- **Search is client-side and built at deploy time.** Pagefind indexes the rendered HTML, so a
  page is findable only after a deploy, and the index ships to the reader.
- **Diagrams render in the browser.** A reader with JavaScript disabled sees the diagram source
  rather than the diagram. Build-time rendering was not taken on: it needs a headless Chromium in
  CI and produces a single-theme image that cannot follow the reader's light/dark toggle.
- **Wide diagrams scroll inside their own frame** rather than scaling to the column. The widest
  flowchart here is 2049px, which the prose column would scale to an effective 5px type size.
- **The `docs/` set is not versioned.** The site publishes the current `main`, with no archive of
  what the docs said at an earlier release.
