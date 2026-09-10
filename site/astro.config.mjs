// @ts-check
import { readFileSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import { BASE, REPO_URL, SIDEBAR } from './scripts/manifest.mjs';

/**
 * Adds the diagram viewer to every page's bundle.
 *
 * Starlight has a slot for custom CSS but none for custom JavaScript, and the
 * two documented alternatives are worse: a `head` tag pointing at `public/`
 * skips the bundler and so never gets a content hash to bust caches with, and
 * overriding a Starlight component to carry one `<script>` tag means owning a
 * component in order to own a script. `injectScript('page')` is the hook meant
 * for exactly this.
 */
const mermaidViewer = {
  hooks: {
    'astro:config:setup': ({ injectScript }) => {
      injectScript(
        'page',
        readFileSync(new URL('./src/scripts/mermaidZoom.js', import.meta.url), 'utf8')
      );
    },
  },
  name: 'auto-swe:mermaid-viewer',
};

/**
 * The site is served from `https://yorch.github.io/auto-swe/`, so `site` and
 * `base` must both be set: Astro needs the origin to emit canonical URLs and a
 * sitemap, and the subpath to prefix every asset it links.
 */
export default defineConfig({
  base: BASE,
  integrations: [
    // Diagrams are rendered in the browser rather than baked to SVG at build
    // time. The build-time route wants a headless Chromium in CI to draw eight
    // diagrams, and it produces a single-theme SVG that cannot follow the
    // reader's light/dark toggle. Client-side rendering costs an 8 KB loader on
    // every page, defers the ~1.5 MB library to pages that actually hold a
    // diagram, and follows the theme toggle for free.
    mermaid({
      autoTheme: true,
      // The integration narrates each render to the browser console. Useful
      // while wiring it up, noise on a published site.
      enableLog: false,
      // No `themeVariables` here, deliberately. The integration spreads this
      // whole object into `mermaid.initialize()` and then overrides only
      // `theme`, so a palette tuned for light mode would survive the switch to
      // dark and leak light fills and label backgrounds into a dark diagram.
      // Per-theme tinting is done in `custom.css`, where it can be scoped.
      mermaidConfig: {
        // Tightened spacing. These diagrams are drawn once and read in a
        // documentation column, so mermaid's default gaps — sized for a canvas
        // with room to spare — buy nothing and cost width, and width is what
        // decides how far the diagram has to be scaled down to fit.
        er: { entityPadding: 10, minEntityWidth: 80 },
        flowchart: { diagramPadding: 8, nodeSpacing: 30, padding: 8, rankSpacing: 45 },
        sequence: { actorMargin: 40, boxMargin: 8, diagramMarginX: 8, diagramMarginY: 8 },
      },
    }),
    starlight({
      credits: false,
      customCss: ['./src/styles/custom.css'],
      // The splash page provides its own hero, so Starlight's is unused.
      description:
        'A durable, governed multi-agent workflow platform. Workflows are versioned JSON DAGs ' +
        'on Temporal; agents run in isolated Docker workspaces behind approval gates, security ' +
        'scanning, and cost control.',
      editLink: {
        // Every synced page overrides this with its true source path. The value
        // here only covers the hand-authored pages that live in this workspace.
        baseUrl: `${REPO_URL}/edit/main/site/`,
      },
      lastUpdated: true,
      sidebar: SIDEBAR.map((group) => ({
        items: group.slugs.map((slug) => ({ slug })),
        label: group.label,
      })),
      social: [{ href: REPO_URL, icon: 'github', label: 'GitHub' }],
      title: 'auto-swe',
    }),
    mermaidViewer,
  ],
  site: 'https://yorch.github.io',
});
