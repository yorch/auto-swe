import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';

export type DocMeta = {
  slug: string;
  title: string;
  description: string;
};

export type Doc = DocMeta & {
  content: string;
};

const DOCS_DIR = path.resolve(process.cwd(), '../../docs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

const TITLE_OVERRIDES: Record<string, { title: string; description: string }> = {
  'configurable-workflows': {
    description: 'Roadmap for the configurable-workflow engine',
    title: 'Configurable Workflows',
  },
  'data-and-infra': {
    description: 'Embedding pipeline, executor images, security review',
    title: 'Data & Infra',
  },
  'gateway-and-auth': {
    description: 'JWT auth, RBAC, Team API, Slack OAuth, full API spec',
    title: 'Gateway & Auth',
  },
  'mvp-architecture': {
    description: 'Core architecture, component design, data flow',
    title: 'MVP Architecture',
  },
  'mvp-implementation': {
    description: 'Build guide with project structure and build order',
    title: 'MVP Implementation',
  },
  README: { description: 'Index of design documents', title: 'Overview' },
  wireframes: {
    description: 'Web dashboard wireframes and page layouts',
    title: 'Wireframes',
  },
  'workflow-and-activities': {
    description: 'Review network, CI fix loop, memory commit',
    title: 'Workflows & Activities',
  },
};

function deriveMeta(slug: string, raw: string): DocMeta {
  const override = TITLE_OVERRIDES[slug];
  if (override) return { slug, ...override };

  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const firstPara = raw.match(/^(?!#|>|\s*$).+$/m)?.[0]?.trim() ?? '';
  const description = firstPara.replace(/[*_`]/g, '').slice(0, 140);

  return { description, slug, title };
}

export const listDocs = cache(async (): Promise<DocMeta[]> => {
  const entries = await readdir(DOCS_DIR);
  const docs = await Promise.all(
    entries
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, slug: name.replace(/\.md$/, '') }))
      .filter(({ slug }) => SLUG_RE.test(slug))
      .map(async ({ name, slug }) => {
        const override = TITLE_OVERRIDES[slug];
        if (override) return { slug, ...override };
        const raw = await readFile(path.join(DOCS_DIR, name), 'utf8');
        return deriveMeta(slug, raw);
      })
  );
  return docs.sort((a, b) => a.title.localeCompare(b.title));
});

export const getDoc = cache(async (slug: string): Promise<Doc | null> => {
  if (!SLUG_RE.test(slug)) return null;
  try {
    const content = await readFile(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
    return { ...deriveMeta(slug, content), content };
  } catch {
    return null;
  }
});
