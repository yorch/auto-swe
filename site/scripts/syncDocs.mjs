#!/usr/bin/env node
/**
 * Copies the repository's markdown into the site's content collection.
 *
 * `docs/` is the single source of truth and stays that way. It is read by two
 * consumers that render it very differently — the dashboard at `/docs`, and this
 * site — and neither one owns it. Nothing here writes back, and the output
 * directory is generated, gitignored, and rebuilt from scratch on every run, so
 * there is no second copy anyone can edit by mistake and no drift to reconcile.
 *
 * Per file it does four things: derives Starlight frontmatter from the doc's own
 * H1 and opening paragraph, strips that H1 (Starlight renders the title itself,
 * and a page with two of them reads as a mistake), rewrites every relative link
 * for its new URL, and points "Edit this page" at the real source file rather
 * than the generated copy.
 *
 * It also generates the use-case section from the built-in workflow templates (see
 * `useCasePages.mjs`), and the data file the landing page draws its use-case rows
 * from. Those templates are TypeScript, which is why this script runs under `tsx`.
 *
 * Run: `yarn workspace @auto-swe/site sync` (implied by `dev` and `build`).
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteMarkdownLinks } from './docLinks.mjs';
import {
  DOCS_DIR,
  DOCS_INDEX,
  DOCS_ROUTE_PREFIX,
  EXTERNAL_PAGES,
  REPO_REF,
  REPO_URL,
  SIDEBAR,
  siteUrl,
} from './manifest.mjs';
import { writePlatformExplorer } from './platformExplorer.mjs';
import {
  describeUseCases,
  renderUseCaseIndex,
  renderUseCasePage,
  USE_CASE_ROUTE_PREFIX,
} from './useCasePages.mjs';

const SITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(SITE_ROOT, '..');
const OUT_ROOT = join(SITE_ROOT, 'src/content/docs');
/** Generated and gitignored: what the landing page needs about each use case. */
const USE_CASE_DATA = join(SITE_ROOT, 'src/data/useCases.json');

/**
 * Filenames under `docs/` that become pages. Mirrors the dashboard's rule so
 * the two surfaces publish exactly the same set: top-level `.md` only, so
 * `history/` and `redesign/` are excluded by having no entry rather than by a
 * rule someone has to remember.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Frontmatter description length. Long enough to be a useful search-result
 * snippet, short enough that Google does not truncate it mid-thought.
 */
const DESCRIPTION_MAX = 160;

/** Strips inline markdown so a heading or lead sentence can be used as plain text. */
function toPlainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncates at a word boundary, because a description cut mid-word is worse
 * than a slightly shorter one.
 */
function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, '')}…`;
}

/** A block that is structure rather than prose, and so cannot be the lead. */
function isProse(block) {
  if (block === '') {
    return false;
  }
  // Headings, tables, fences, HTML, and thematic breaks (`---`, `***`, `___`).
  if (/^(#|\||```|~~~|<|-{3,}$|\*{3,}$|_{3,}$)/.test(block)) {
    return false;
  }
  // A line that is only badges — every docs page in this repo that opens with
  // one puts the real summary in the paragraph beneath it.
  if (/^\[!\[/.test(block)) {
    return false;
  }
  // Needs enough words to be a sentence rather than a label or a stray marker.
  return toPlainText(block).split(' ').length >= 5;
}

/**
 * Pulls the title and lead paragraph out of a doc, and returns the body with
 * the H1 removed.
 *
 * Blockquotes count as prose, with their markers stripped. Several docs here
 * open with a `>` summary of the whole page, which is the best one-sentence
 * description the file contains — skipping it in favour of the first plain
 * paragraph would reach for a worse sentence further down.
 */
export function extractFrontmatter(raw) {
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? toPlainText(titleMatch[1]) : '';

  const body = titleMatch ? raw.replace(titleMatch[0], '').replace(/^\s*\n/, '') : raw;

  const lead = body
    .split(/\n\s*\n/)
    .map((block) => block.trim().replace(/^>\s?/gm, '').trim())
    .find(isProse);

  return { body, description: lead ? truncate(toPlainText(lead), DESCRIPTION_MAX) : '', title };
}

/**
 * Serialises frontmatter.
 *
 * Values go through `JSON.stringify`: every JSON string is a valid
 * double-quoted YAML scalar, which sidesteps hand-rolled escaping for the
 * colons, quotes, and backslashes that appear in these titles.
 */
function frontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== '' && value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/** Collects every page to publish, in no particular order. */
async function collectPages() {
  const entries = await readdir(join(REPO_ROOT, DOCS_DIR));
  const docs = entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, stem: name.replace(/\.md$/, '') }))
    .filter(({ stem }) => SLUG_RE.test(stem))
    .map(({ name, stem }) =>
      `${DOCS_DIR}/${name}` === DOCS_INDEX.source
        ? DOCS_INDEX
        : {
            file: `${DOCS_ROUTE_PREFIX}/${stem}.md`,
            slug: `${DOCS_ROUTE_PREFIX}/${stem}`,
            source: `${DOCS_DIR}/${name}`,
          }
    );

  return [...docs, ...EXTERNAL_PAGES];
}

/**
 * Fails when the sidebar and the published set disagree.
 *
 * Both directions are silent without this. A doc missing from the sidebar still
 * builds and still resolves by URL — it is simply absent from the navigation, so
 * no reader ever arrives at it. A sidebar entry for a deleted doc is worse:
 * Starlight renders a link that 404s.
 */
function assertSidebarCovers(pages) {
  const published = new Set(pages.map((p) => p.slug));
  const listed = SIDEBAR.flatMap((group) => group.slugs);

  const duplicates = listed.filter((slug, i) => listed.indexOf(slug) !== i);
  const missing = [...published].filter((slug) => !listed.includes(slug));
  const orphaned = listed.filter((slug) => !published.has(slug));

  const problems = [
    ...missing.map((s) => `  published but not in any sidebar group: ${s}`),
    ...orphaned.map((s) => `  in the sidebar but not published: ${s}`),
    ...duplicates.map((s) => `  listed in more than one sidebar group: ${s}`),
  ];

  if (problems.length > 0) {
    throw new Error(
      `Sidebar is out of sync with the published pages.\n${problems.join('\n')}\n\n` +
        'Fix it in site/scripts/manifest.mjs (SIDEBAR).'
    );
  }
}

/**
 * Headings that collide with an entry Starlight adds itself.
 *
 * Starlight puts an "Overview" entry, pointing at the top of the page, first in
 * every table of contents. A doc whose own section is titled "Overview" therefore
 * lists it twice, and the two entries go to different places.
 */
const RESERVED_HEADING = /^#{2,6}\s+Overview\s*$/im;

/** Throws when a published doc uses a heading Starlight reserves. */
export function assertNoReservedHeadings(source, markdown) {
  if (RESERVED_HEADING.test(markdown)) {
    throw new Error(
      `${source} has a section titled "Overview", which Starlight already adds to every ` +
        "page's table of contents. Retitle the section for what it covers."
    );
  }
}

async function main() {
  const pages = await collectPages();
  assertSidebarCovers(pages);

  const routes = new Map(pages.map((page) => [page.source, siteUrl(page.slug)]));

  // Generated output, rebuilt every run: a page left behind from a doc that was
  // since renamed or deleted would otherwise stay published forever. Derived
  // from the pages rather than hardcoded, so it cannot miss a directory that a
  // new entry in the manifest introduces — and it only ever removes what this
  // script writes, never the hand-authored `index.mdx` beside it.
  const generatedRoots = new Set(pages.map((page) => page.file.split('/')[0]));
  for (const entry of generatedRoots) {
    await rm(join(OUT_ROOT, entry), { force: true, recursive: true });
  }

  for (const page of pages) {
    const raw = await readFile(join(REPO_ROOT, page.source), 'utf8');
    const derived = extractFrontmatter(raw);
    assertNoReservedHeadings(page.source, derived.body);
    const body = rewriteMarkdownLinks(derived.body, {
      ref: REPO_REF,
      repoUrl: REPO_URL,
      routes,
      sourcePath: page.source,
    });

    const head = frontmatter({
      description: page.description ?? derived.description,
      // Points at the true source, not this generated copy — the copy is
      // gitignored, so Starlight's default would send an editor to a 404.
      editUrl: `${REPO_URL}/edit/${REPO_REF}/${page.source}`,
      title: page.title ?? derived.title,
    });

    const out = join(OUT_ROOT, page.file);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${head}${body.trimEnd()}\n`, 'utf8');
  }

  const useCaseCount = await writeUseCases();
  await writePlatformExplorer();
  console.log(
    `Synced ${pages.length} pages and ${useCaseCount} use cases into site/src/content/docs/`
  );
}

/** Writes the generated use-case section and the landing page's data file. */
async function writeUseCases() {
  const useCases = describeUseCases();
  const root = join(OUT_ROOT, USE_CASE_ROUTE_PREFIX);
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });

  await writeFile(
    join(root, 'index.md'),
    `${frontmatter({
      description:
        'Workflows that ship with auto-swe, each drawn from its template spec: engineering, ' +
        'approvals, releases, product, support, and content.',
      editUrl: `${REPO_URL}/edit/${REPO_REF}/site/scripts/useCases.mjs`,
      title: 'Use cases',
    })}${renderUseCaseIndex(useCases)}`,
    'utf8'
  );

  for (const useCase of useCases) {
    const head = frontmatter({
      description: truncate(useCase.summary, DESCRIPTION_MAX),
      editUrl: `${REPO_URL}/edit/${REPO_REF}/${useCase.source}`,
      title: useCase.title,
    });
    const body = renderUseCasePage(useCase, { ref: REPO_REF, repoUrl: REPO_URL });
    await writeFile(join(root, `${useCase.name}.md`), `${head}${body}`, 'utf8');
  }

  // The landing page is an Astro component and cannot import the TypeScript
  // templates itself, so it reads this instead of a second hand-kept list.
  const landing = useCases.map(({ facts, group, maturity, name, slug, summary, title }) => ({
    group,
    href: siteUrl(slug),
    maturity,
    name,
    people: facts.people.map(({ kind, title: label }) => ({ kind, label })),
    summary,
    title,
  }));
  await mkdir(dirname(USE_CASE_DATA), { recursive: true });
  await writeFile(USE_CASE_DATA, `${JSON.stringify(landing, null, 2)}\n`, 'utf8');

  return useCases.length;
}

// Importable for tests without running the copy.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
