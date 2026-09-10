// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import { BASE, REPO_URL, SIDEBAR } from './scripts/manifest.mjs';

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
      mermaidConfig: {
        // Draw at natural size. Mermaid's default scales a diagram down until
        // it fits its container, which for the widest flowchart here means 16px
        // labels rendered at an effective 5.4px. `custom.css` bounds and scrolls
        // the block that holds it instead.
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
      },
    }),
    starlight({
      credits: false,
      customCss: ['./src/styles/custom.css'],
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
  ],
  site: 'https://yorch.github.io',
});
