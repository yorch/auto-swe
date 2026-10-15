import { buildSearchIndex } from '@auto-swe/shared/lib/docSearch';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssistantGateway, createAssistantGateway } from '../lib/assistantGateway.js';
import {
  ASSISTANT_DOCS_DIR,
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
  });
});
