# Public documentation site

The living docs, rendered for the open web and published to GitHub Pages at
<https://yorch.github.io/auto-swe/>.

This workspace owns almost no documentation. The docs are copied in from elsewhere in the
repository at build time, and the use-case section is generated from the built-in workflow
templates, so there is exactly one copy of every sentence and nothing to keep in sync by hand.

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
| Built-in workflow templates + [`scripts/useCases.mjs`](./scripts/useCases.mjs) | `/use-cases/` and `/use-cases/<template>/` |
| `src/content/docs/index.mdx` | `/` — the one hand-authored page |

`docs/history/` and `docs/redesign/` are deliberately absent, matching the dashboard. Frozen docs
shown to a reader with no way to know they are frozen read as current behaviour.

## Editing

**Edit the source, never the copy.** `src/content/docs/docs/`, `src/content/docs/reference/`,
`src/content/docs/use-cases/`, `src/content/docs/introduction.md`, and `src/data/` are generated,
gitignored, and deleted and rewritten on every sync. Only `src/content/docs/index.mdx` is authored
here.

Adding a doc to `docs/` is enough to publish it, but it must also be placed in `SIDEBAR` in
[`scripts/manifest.mjs`](./scripts/manifest.mjs). The build fails if it is not — an unplaced doc
still builds and still resolves by URL, so without that check nothing would notice that no reader
can reach it.

### Use cases

Each use-case page is drawn from a template in `BUILTIN_TEMPLATES`: its diagram, the places a
person acts, the systems it waits on, and the agents it calls are all read from the spec, using the
same `nodeEdges` the workflow validator uses. Only what a spec cannot say — who the workflow is
for, the problem in plain words, and how far it is proven — is written by hand, in
[`scripts/useCases.mjs`](./scripts/useCases.mjs).

**Adding a built-in template fails this build until it has an entry there**, and removing one fails
it until the entry goes. That is deliberate: a template that ships without a public page, or a page
for a workflow nobody can run, is exactly the drift the check exists to stop. The maturity wording
is the other thing to keep honest — it restates `docs/product-overview.md` §8, so when that section
changes, `MATURITY` changes with it.

The index ends with **workflows you could build** — `WORKFLOW_IDEAS` in the same file. These have
no spec, so nothing about them is generated, and the page prints them under a heading saying none
ship. The one thing a test does check is that every node type, step, template, or agent an idea
names in code formatting exists, so an idea cannot recommend a building block nobody can use. An
idea that becomes a built-in template moves to `USE_CASES`.

Because the templates are TypeScript, `sync` runs under `tsx`, not bare `node`.

## The design

The site borrows the vernacular of a railway signal box, because a run behaves like a train on
signalled track: it advances section by section, and at a gate it is held at a signal until a person
clears it. The page is the enamel of a signal-box wall — a cool grey-green, deliberately not the
warm cream that generated docs sites open on. The hero is the control panel mounted on that wall,
the one dark object on a light page. Its lamps are the only saturated colour anywhere.

**Amber is still the gate**: held, waiting for a person. It appears wherever a person is involved —
the held signal in the hero, the gate nodes in the generated diagrams, the people listed against
each use case, the current page on the sidebar rail, a doc's Limitations heading. Steel is the
machine half, and in the diagrams marks a run waiting on another system rather than on a person.

The hero is the one bold element, and it is interactive on purpose. A run advances along the track
of a real template and halts at its signal, and then **the visitor clears it** — merges the pull
request, approves the reply, signs off. Clearing the signal is the one thing on the page only a
person can do, which is also the one thing the product never does for you. The three routes are the
built-in `default-engineering`, `zendesk-ticket-reply`, and `four-eyes` templates, simplified for a
panel: bookkeeping is folded into the station it serves, but no step or gate is invented, and the
timeouts are the specs' own.

Type is Overpass, which descends from Highway Gothic, the lettering of road and transit signage:
wayfinding type, for a page about where a run goes and where it stops. One family carries display
and text by weight alone. Overpass Mono sets code and nothing else; a monospaced micro-label is the
reflex on a developer site, and it says nothing true when the thing it labels is not code.

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

There is exactly one non-user-triggered animation on the site: the hero's run advances to its first
signal on load and stops there. `prefers-reduced-motion` places it at the signal immediately.

The landing page is MDX, so it renders inside Starlight's `.sl-markdown-content`. Its root carries
`not-content`, the opt-out Starlight's own markdown styles honour, and every prose rule in
`custom.css` honours it too. A new prose rule that leaves it off repaints the panel's light text in
page ink.

Every text and background pair is checked against WCAG AA. Two values exist only because of it:
`--ink-faint` is darker than it looks like it wants to be (5.22:1 on the enamel), and `--gate-text`
is a darker gate for running text (5.45:1, where the signal value measures 3.55 and is fine for a
mark but not for words).

## How it fits together

| File | Does |
|---|---|
| [`scripts/manifest.mjs`](./scripts/manifest.mjs) | The single answer to "is this file on the site, and where?" — routes, sidebar, base path, GitHub fallback ref |
| [`scripts/syncDocs.mjs`](./scripts/syncDocs.mjs) | Copies each source in, derives frontmatter from its H1 and lead paragraph, points "Edit this page" at the true source |
| [`scripts/docLinks.mjs`](./scripts/docLinks.mjs) | Rewrites every filesystem-relative link: published targets become site URLs, everything else becomes a GitHub URL |
| [`scripts/useCases.mjs`](./scripts/useCases.mjs) | The use-case catalogue: group, plain-words summary, and maturity per built-in template; the use-case sidebar |
| [`scripts/useCasePages.mjs`](./scripts/useCasePages.mjs) | Joins the catalogue to `BUILTIN_TEMPLATES`, fails on any mismatch, and renders the pages and the landing page's data file |
| [`scripts/templateGraph.mjs`](./scripts/templateGraph.mjs) | Draws a workflow spec as a mermaid flowchart and summarises who has to act in it |
| [`src/scripts/mermaidZoom.js`](./src/scripts/mermaidZoom.js) | Wraps each rendered diagram in a figure and adds the full-screen pan-and-zoom viewer |
| [`src/styles/tokens.css`](./src/styles/tokens.css) | Colour, type, and scale, for both themes. Dark is designed, not inverted |
| [`src/styles/custom.css`](./src/styles/custom.css) | Spends the tokens: Starlight variable mapping, then chrome and content |
| [`src/components/Landing.astro`](./src/components/Landing.astro) | The landing page. The only hand-authored page on the site |
| [`src/components/SignalPanel.astro`](./src/components/SignalPanel.astro) | The hero: the signal panel, its three routes, and the script that runs them |
| [`src/components/SiteFooter.astro`](./src/components/SiteFooter.astro) | Starlight's footer plus the colophon: author, license, source, and the Astro and Starlight credit |
| [`src/components/ProductFrames.astro`](./src/components/ProductFrames.astro) | Real dashboard screens from `src/assets/screens/`, captured from a fresh local install. Retake them when those pages change; nothing flags a stale one |
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
  not worth an observer per diagram.
- **The hero's routes are hand-simplified, not generated.** The use-case pages draw each template
  in full from its spec; the panel shows three of them as a short line of stations, written in
  `SignalPanel.astro`. A change to those three templates' steps or timeouts must be carried there
  by hand, and nothing fails if it is not.
- **Use-case maturity is a statement, not a measurement.** Whether a template has been exercised
  end to end is written in `useCases.mjs` from the product overview; no test establishes it.
- **The `docs/` set is not versioned.** The site publishes the current `main`, with no archive of
  what the docs said at an earlier release.
- **There is no `typecheck` script here, and adding one is not a small fix.** `astro check` needs
  the TypeScript compiler's programmatic API, which the native TypeScript 7 compiler this repo runs
  does not expose. Making it work means pinning a second, older TypeScript for this workspace
  alone. That buys very little: the only TypeScript here is `src/content.config.ts`, and
  `astro build` imports it, so a broken one already fails the build and CI.
