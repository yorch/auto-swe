import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSearchIndex, indexDoc, type SearchSection } from '@auto-swe/shared/lib/docSearch';
import { extractToc } from '@auto-swe/shared/lib/docToc';
import { collectWorkflowInventory, stepCategoryOrder } from '@auto-swe/shared/workflow/inventory';
import { listAllSteps } from '@auto-swe/shared/workflow/stepRegistry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssistantGateway, createAssistantGateway } from '../lib/assistantGateway.js';
import {
  INVENTORY_STEP_CATEGORIES,
  type InventoryAnswer,
  nodeTypeDocLink,
  stepCategoryDocLink,
} from './assistantInventory.js';
import {
  ASSISTANT_DOCS_DIR,
  clipSection,
  createAssistantTools,
  findDocSections,
  resetAssistantDocIndex,
  summarizeToolResult,
} from './assistantTools.js';

type Exec = (input: unknown) => Promise<unknown>;
const run = (tool: unknown, input: unknown = {}) => (tool as { execute: Exec }).execute(input);

function gateway(): AssistantGateway & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn().mockResolvedValue({ body: { data: [] }, status: 200 }) };
}

beforeEach(() => {
  resetAssistantDocIndex();
});

describe('searchDocs', () => {
  it('answers a configuration question from the shipped docs with a /docs link to cite', async () => {
    const tools = createAssistantTools({ gateway: gateway(), pageContext: null });
    const { results } = (await run(tools.searchDocs, { query: 'github app webhook' })) as {
      results: { link: string; text: string; doc: string }[];
    };
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.link).toMatch(/^\/docs\/[A-Za-z0-9-]+(#[a-z0-9-]+)?$/);
      expect(r.text.length).toBeLessThanOrEqual(1501);
    }
    expect(results.some((r) => /github/i.test(r.text + r.doc))).toBe(true);
    // Builds the index over every shipped doc, which takes seconds on a loaded CI runner.
  }, 60_000);

  it('reads the docs from the repository root, never history', () => {
    expect(ASSISTANT_DOCS_DIR.replace(/\\/g, '/')).toMatch(/\/docs\/$/);
    expect(ASSISTANT_DOCS_DIR).not.toContain('history');
  });
});

describe('clipSection', () => {
  const ROWS = Array.from(
    { length: 40 },
    (_, i) =>
      `| \`step${i}\` | ${i === 31 ? 'opens the pull request' : 'does a thing'} | ${'filler '.repeat(8)}|`
  );
  const MD = [
    '## Steps',
    '',
    'The steps a node can name.',
    '',
    '| Step | Description | Notes |',
    '|---|---|---|',
    ...ROWS,
    '',
    'A closing remark.',
    '',
  ].join('\n');
  const section = indexDoc(MD)[0] as SearchSection;

  it('keeps the lead, the header and the rows that match the query, within the cap', () => {
    expect(section.text.length).toBeGreaterThan(1500);
    const out = clipSection(section, 'pull request', 1500);
    expect(out.text.length).toBeLessThanOrEqual(1500);
    expect(out.text.startsWith('The steps a node can name.')).toBe(true);
    expect(out.text).toContain('| Step | Description | Notes |\n| --- | --- | --- |');
    expect(out.text).toContain('| step31 | opens the pull request |');
    // Filled with the remaining rows in order after the match.
    expect(out.text).toContain('| step0 | does a thing |');
    expect(out.rowsOmitted).toBeGreaterThan(0);
    expect(out.text).toContain(`(${out.rowsOmitted} more rows at the link)`);
    // Rows keep their table order.
    expect(out.text.indexOf('step0 ')).toBeLessThan(out.text.indexOf('step31'));
  });

  it('cuts prose without a table exactly as before', () => {
    const prose = indexDoc(`## Long\n\n${'word '.repeat(600)}\n`)[0] as SearchSection;
    const out = clipSection(prose, 'word', 1500);
    expect(out).toEqual({ text: `${prose.text.slice(0, 1500).trimEnd()}…` });
  });

  it('cuts a section that is long because of its prose as prose, using the whole budget', () => {
    const md = `## Long\n\n${'lead words '.repeat(200)}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    const long = indexDoc(md)[0] as SearchSection;
    const out = clipSection(long, 'lead', 1500);
    expect(out).toEqual({ text: `${long.text.slice(0, 1500).trimEnd()}…` });
    expect(out.text.length).toBeGreaterThan(1450);
  });

  it('falls back to the text when no header or row fits, rather than returning nothing', () => {
    const md = `## Wide\n\n| a | b |\n|---|---|\n| ${'x'.repeat(2000)} | y |\n`;
    const wide = indexDoc(md)[0] as SearchSection;
    const out = clipSection(wide, 'x', 1500);
    expect(out.text.length).toBeGreaterThan(1400);
    expect(out.text.length).toBeLessThanOrEqual(1501);
    expect(out.rowsOmitted).toBeUndefined();
  });

  it('gives what the rows leave to the prose after the table, cut with an ellipsis', () => {
    const rows = Array.from({ length: 22 }, (_, i) => `| r${i} | a \\| b ${'cell '.repeat(8)}|`);
    const md = [
      '## T',
      '',
      '| Name | Value |',
      '|---|---|',
      ...rows,
      '',
      `Afterword ${'tail '.repeat(100)}`,
      '',
    ].join('\n');
    const t = indexDoc(md)[0] as SearchSection;
    expect(t.text.length).toBeGreaterThan(1500);
    const out = clipSection(t, 'value', 1500);
    expect(out.rowsOmitted).toBeUndefined();
    expect(out.text.length).toBeLessThanOrEqual(1500);
    expect(out.text).toContain('| r21 | a \\| b ');
    expect(out.text).toContain('Afterword tail');
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('returns a table section that fits untouched', () => {
    const small = indexDoc('## T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')[0] as SearchSection;
    expect(clipSection(small, 'a', 1500)).toEqual({ text: small.text });
  });
});

describe('workflowInventory', () => {
  const INVENTORY = collectWorkflowInventory();
  const tools = createAssistantTools({ gateway: gateway(), pageContext: null });
  const ask = async (input: object) =>
    (await run(tools.workflowInventory, input)) as InventoryAnswer;

  it('lists every registered step, internal ones flagged, with the templates using each', async () => {
    const out = await ask({ kind: 'steps' });
    const steps = listAllSteps();
    expect(out.steps?.map((s) => s.name).sort()).toEqual(steps.map((s) => s.name).sort());
    expect(out.totals.steps).toBe(steps.length);
    expect(out.totals.internalSteps).toBe(steps.filter((s) => s.internal).length);
    for (const step of steps) {
      expect(out.steps?.find((s) => s.name === step.name)?.internal).toBe(!!step.internal);
    }
    expect(out.doc).toBe('/docs/workflow-inventory#registered-steps');
    expect(JSON.stringify(out).length).toBeLessThan(40_000);
  });

  it('narrows steps to one category', async () => {
    const out = await ask({ category: 'vcs', kind: 'steps' });
    expect(out.steps?.length).toBeGreaterThan(0);
    expect(out.steps?.every((s) => s.category === 'vcs')).toBe(true);
    expect(out.doc).toBe('/docs/workflow-inventory#version-control-steps');
  });

  it('answers which built-in templates use a step, as the inventory counts them', async () => {
    const out = await ask({ kind: 'lookup', name: 'createOrUpdatePullRequest' });
    const users = INVENTORY.templates
      .filter((t) => t.steps.includes('createOrUpdatePullRequest'))
      .map((t) => t.name);
    expect(users.length).toBeGreaterThan(0);
    expect(out.steps).toHaveLength(1);
    expect(out.steps?.[0]?.templates).toEqual(users);
    expect(out.note).toBeUndefined();
  });

  it('lists node types and templates with doc links', async () => {
    const types = await ask({ kind: 'nodeTypes' });
    expect(types.nodeTypes?.find((t) => t.type === 'humanApproval')?.doc).toBe(
      '/docs/workflow-nodes#humanapproval'
    );
    const templates = await ask({ kind: 'templates' });
    expect(templates.templates?.map((t) => t.name)).toEqual(INVENTORY.templates.map((t) => t.name));
    expect(templates.totals.templates).toBe(INVENTORY.templates.length);
  });

  it('says so instead of inventing a match', async () => {
    const out = await ask({ kind: 'lookup', name: 'noSuchThingAnywhere' });
    expect(out.nodeTypes).toEqual([]);
    expect(out.steps).toEqual([]);
    expect(out.templates).toEqual([]);
    expect(out.note).toMatch(/No node type, registered step or built-in template/);
  });

  it('says how many partial matches there were when it shows only the first few', async () => {
    const out = await ask({ kind: 'lookup', name: 'e' });
    const total = INVENTORY.steps.filter((s) => s.name.toLowerCase().includes('e')).length;
    expect(total).toBeGreaterThan(10);
    expect(out.steps).toHaveLength(10);
    expect(out.note).toContain(`steps: first 10 of ${total}`);
  });

  it('treats an empty name or category as unset', async () => {
    const schema = (
      tools.workflowInventory as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).inputSchema;
    expect(schema.safeParse({ category: '', kind: 'steps', name: '' }).success).toBe(true);
    expect((await ask({ category: '', kind: 'steps' })).steps).toHaveLength(INVENTORY.steps.length);
    expect((await ask({ kind: 'lookup', name: '' })).note).toBe('A lookup needs a name.');
  });

  it('hands out copies, never the cached inventory', async () => {
    const first = await ask({ kind: 'lookup', name: 'runReviewNetwork' });
    first.steps?.[0]?.templates.push('mutated');
    const again = await ask({ kind: 'lookup', name: 'runReviewNetwork' });
    expect(again.steps?.[0]?.templates).not.toContain('mutated');
  });

  it('falls back to names containing the text when nothing matches exactly', async () => {
    const out = await ask({ kind: 'lookup', name: 'human' });
    expect(out.nodeTypes?.map((t) => t.type)).toContain('humanApproval');
    expect(out.note).toMatch(/contain/);
  });

  it('links only to headings the docs have', () => {
    const toc = (file: string) =>
      new Set(
        extractToc(readFileSync(path.join(ASSISTANT_DOCS_DIR, file), 'utf8')).map((t) => t.id)
      );
    const nodes = toc('workflow-nodes.md');
    const inventory = toc('workflow-inventory.md');
    for (const { type } of INVENTORY.nodeTypes) {
      expect(nodes).toContain(nodeTypeDocLink(type).split('#')[1]);
    }
    for (const category of INVENTORY_STEP_CATEGORIES) {
      expect(inventory).toContain(stepCategoryDocLink(category).split('#')[1]);
    }
    for (const anchor of ['node-types', 'registered-steps', 'built-in-templates']) {
      expect(inventory).toContain(anchor);
    }
  });

  it('offers every step category the registry has', () => {
    expect([...INVENTORY_STEP_CATEGORIES].sort()).toEqual(stepCategoryOrder().sort());
  });
});

describe('findDocSections', () => {
  const index = buildSearchIndex([
    {
      content: '# Integrations\n\n## GitHub\n\nPaste the token.\n',
      slug: 'integrations',
      title: 'x',
    },
    { content: '# Budgets\n\n## Tiers\n\nTiers cap tokens.\n', slug: 'budgets', title: 'y' },
  ]);

  it('matches every term when it can', () => {
    expect(findDocSections(index, 'github token', 5).map((r) => r.doc.slug)).toEqual([
      'integrations',
    ]);
  });

  it('falls back to the longer words of a sentence that matches nothing whole', () => {
    const hits = findDocSections(index, 'how do I paste a github token here please', 5);
    expect(hits[0]?.doc.slug).toBe('integrations');
  });
});

describe('getPageContext', () => {
  it('names the route that reads the entity on the page', async () => {
    const tools = createAssistantTools({
      gateway: gateway(),
      pageContext: { entityId: 'run-1', entityType: 'run', route: '/runs/run-1' },
    });
    expect(await run(tools.getPageContext)).toEqual({
      apiPath: '/api/v1/workflow-runs/run-1',
      entityId: 'run-1',
      entityType: 'run',
      route: '/runs/run-1',
    });
  });

  it('says so when the panel sent no page', async () => {
    const tools = createAssistantTools({ gateway: gateway(), pageContext: null });
    expect(await run(tools.getPageContext)).toMatchObject({ apiPath: null, route: null });
  });
});

describe('callApi and describeApi', () => {
  it('reads through the gateway with a GET', async () => {
    const gw = gateway();
    const tools = createAssistantTools({ gateway: gw, pageContext: null });
    const out = await run(tools.callApi, {
      path: '/api/v1/workflow-runs',
      query: { status: 'FAILED' },
    });
    expect(gw.get).toHaveBeenCalledWith('/api/v1/workflow-runs', { status: 'FAILED' });
    expect(out).toEqual({ body: { data: [] }, status: 200 });
  });

  it('answers 400 for a path outside the API instead of sending it', async () => {
    const fetchImpl = vi.fn();
    const tools = createAssistantTools({
      gateway: createAssistantGateway('asst_x', {
        baseUrl: 'http://gateway:8080',
        fetchImpl: fetchImpl as never,
      }),
      pageContext: null,
    });
    expect(await run(tools.callApi, { path: '/api/v1/../../admin' })).toMatchObject({
      status: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cuts a large response to fit the context', async () => {
    const gw = gateway();
    gw.get.mockResolvedValue({ body: { data: 'x'.repeat(50_000) }, status: 200 });
    const tools = createAssistantTools({ gateway: gw, pageContext: null });
    const out = (await run(tools.callApi, { path: '/api/v1/workflow-runs' })) as {
      body: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(20_001);
  });

  it('asks the catalog route for matching routes', async () => {
    const gw = gateway();
    gw.get.mockResolvedValue({ body: { routes: [{ method: 'GET', path: '/x' }] }, status: 200 });
    const tools = createAssistantTools({ gateway: gw, pageContext: null });
    expect(await run(tools.describeApi, { query: 'runs' })).toEqual({
      routes: [{ method: 'GET', path: '/x' }],
    });
    expect(gw.get).toHaveBeenCalledWith('/api/v1/assistant/api-catalog', {
      limit: '10',
      q: 'runs',
    });
  });
});

describe('summarizeToolResult', () => {
  it('gives a short account of each tool', () => {
    expect(summarizeToolResult('searchDocs', { results: [1, 2] })).toBe('2 doc sections');
    expect(summarizeToolResult('callApi', { status: 403 })).toBe('HTTP 403');
    expect(summarizeToolResult('describeApi', { routes: [1] })).toBe('1 route');
    expect(summarizeToolResult('workflowInventory', { steps: [1, 2], templates: [3] })).toBe(
      '3 inventory rows'
    );
  });
});
