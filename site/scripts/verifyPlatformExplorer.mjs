#!/usr/bin/env node
/** Dependency-free check of controlled build output, not a general-purpose HTML parser. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PLATFORM_EXPLORER, siteUrl } from './manifest.mjs';

export function assertExplorerPublication({ landing, docs, explorer }) {
  const href = siteUrl(PLATFORM_EXPLORER.slug);
  for (const [name, html] of Object.entries({ docs, landing })) {
    const links = [...html.matchAll(/<a\b[^>]*\shref=(["'])(.*?)\1[^>]*>/g)];
    if (!links.some((link) => link[2] === href)) {
      throw new Error(
        `${name}: missing explorer link at ${href}; check Pages/Starlight base handling`
      );
    }
  }
  const snapshot = explorer.match(
    /<template\b[^>]*\bid=["']platform-data["'][^>]*>([\s\S]*?)<\/template>/
  );
  if (!snapshot) {
    throw new Error('Missing inert explorer snapshot');
  }
  // The exporter uses Unicode escapes for markup and only these entities for braces.
  const data = JSON.parse(snapshot[1].replaceAll('&#123;', '{').replaceAll('&#125;', '}'));
  if (data.meta.url !== href) {
    throw new Error(`Explorer snapshot URL does not match ${href}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [landing, docs, explorer] = await Promise.all(
    ['index.html', 'docs/architecture/index.html', `${PLATFORM_EXPLORER.slug}/index.html`].map(
      (path) => readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8')
    )
  );
  assertExplorerPublication({ docs, explorer, landing });
  console.log(
    'Platform explorer publication verified: rendered home/sidebar links and generated HTML'
  );
}
