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

## The design

The palette is named after what a run does rather than after a brand colour picked in the abstract.
A run advances, halts at a gate, and waits for a person, and **amber is the gate** — stopped, waiting.
It is the only accent with identity, and it appears where a person is involved: the halt in the hero,
the current page on the sidebar rail, a doc's Limitations heading. Steel is the machine half. The
surface is a cool technical paper rather than a warm cream, because this is a long document about
infrastructure that runs in a cold room.

Type is IBM Plex, all three widths: Condensed for headings, where a heavy condensed face reads as
signage and buys width back so a long technical heading can be set large; Sans for body at a
reading measure; Mono for code and nothing else. A monospaced micro-label is the reflex on a
developer site and it says nothing true when the thing it labels is not code.

Structure is used to carry meaning rather than to decorate:

- **The sidebar is a rail with stops.** The current page is a solid bar on it in the gate colour,
  the same language as a halted run, rather than a highlighted pill.
- **Limitations sections are marked.** Every capability doc ends by stating what is not built, not
  proven, or deliberately constrained, and CI fails a doc that drops it. That is an unusual promise
  for a project to make, so it gets an amber rule instead of looking like one more heading near the
  bottom of a long page.
- **One heading rule, not two.** The docs put a `---` above most section headings and the heading
  already carries a rule; the loose one is hidden, because the heading's rule belongs to a section
  and a bare horizontal rule belongs to nothing.

There is exactly one non-user-triggered animation on the site: the hero's rail draws itself down to
the gate on load and stops there. It runs once, it is short, and it says the same thing the page
says. `prefers-reduced-motion` skips it entirely.

Every text and background pair is checked against WCAG AA. Two values exist only because of it:
`--ink-faint` is darker than it looks like it wants to be (4.93:1, where the obvious lighter grey
measured 4.08), and `--gate-text` is a darker gate for running text (5.25:1, where the signal value
measures 3.74 and is fine for a mark but not for words).

## How it fits together

| File | Does |
|---|---|
| [`scripts/manifest.mjs`](./scripts/manifest.mjs) | The single answer to "is this file on the site, and where?" — routes, sidebar, base path, GitHub fallback ref |
| [`scripts/syncDocs.mjs`](./scripts/syncDocs.mjs) | Copies each source in, derives frontmatter from its H1 and lead paragraph, points "Edit this page" at the true source |
| [`scripts/docLinks.mjs`](./scripts/docLinks.mjs) | Rewrites every filesystem-relative link: published targets become site URLs, everything else becomes a GitHub URL |
| [`src/scripts/mermaidZoom.js`](./src/scripts/mermaidZoom.js) | Wraps each rendered diagram in a figure and adds the full-screen pan-and-zoom viewer |
| [`src/styles/tokens.css`](./src/styles/tokens.css) | Colour, type, and scale, for both themes. Dark is designed, not inverted |
| [`src/styles/custom.css`](./src/styles/custom.css) | Spends the tokens: Starlight variable mapping, then chrome and content |
| [`src/components/Landing.astro`](./src/components/Landing.astro) | The landing page, hero included. The only hand-authored page on the site |
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
- **A diagram is only readable in the viewer, not in the page.** These diagrams are far wider than
  a documentation column — the entity diagram is 2850px against 720px — so the copy in the page is
  an overview at roughly a quarter scale and the **Expand** control is how it is actually read.
  Tightening mermaid's layout spacing recovers 7–16% on the flowcharts and nothing on the entity
  diagram, which is not the order of magnitude that would change this.
- **The expand control is decided once, at render.** A diagram that fits its column when the page
  loads does not gain the control if the window is later made narrower. Re-checking on resize was
  not worth an observer per diagram; every diagram in this tree overflows at every viewport.
- **The `docs/` set is not versioned.** The site publishes the current `main`, with no archive of
  what the docs said at an earlier release.
- **There is no `typecheck` script here, and adding one is not a small fix.** `astro check` needs
  the TypeScript compiler's programmatic API, which the native TypeScript 7 compiler this repo runs
  does not expose. Making it work means pinning a second, older TypeScript for this workspace
  alone. That buys very little: the only TypeScript here is `src/content.config.ts`, and
  `astro build` imports it, so a broken one already fails the build and CI.
