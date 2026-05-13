import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type DocMeta = {
  slug: string;
  title: string;
  description: string;
};

export type Doc = DocMeta & {
  content: string;
};

const DOCS_DIR = path.resolve(process.cwd(), '../../docs');

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

  const headingMatch = raw.match(/^#\s+(.+)$/m);
  const title = headingMatch?.[1]?.trim() ?? slug;

  const firstPara = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('>'));
  const description = firstPara ? firstPara.replace(/[*_`]/g, '').slice(0, 140) : '';

  return { description, slug, title };
}

export async function listDocs(): Promise<DocMeta[]> {
  const entries = await readdir(DOCS_DIR);
  const docs = await Promise.all(
    entries
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        const slug = name.replace(/\.md$/, '');
        const raw = await readFile(path.join(DOCS_DIR, name), 'utf8');
        return deriveMeta(slug, raw);
      })
  );
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getDoc(slug: string): Promise<Doc | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  try {
    const content = await readFile(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
    return { ...deriveMeta(slug, content), content };
  } catch {
    return null;
  }
}
