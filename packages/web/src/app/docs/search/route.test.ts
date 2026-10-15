import { buildSearchIndex, MAX_QUERY_CHARS, MAX_RESULTS } from '@auto-swe/shared/lib/docSearch';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/docs', () => ({ loadDocSearchIndex: load }));

import { dynamic, GET } from './route';

const INDEX = buildSearchIndex([
  {
    content: '# Agents\n\n## Skills\n\nA skill is a prompt fragment with `<b>raw</b>` markup.\n',
    slug: 'agents',
    title: 'Agents',
  },
  {
    content: Array.from({ length: 50 }, (_, i) => `## S${i}\n\nneedle ${i}\n`).join('\n'),
    slug: 'many',
    title: 'Many',
  },
]);

const get = (qs: string) => GET(new NextRequest(`http://localhost:3000/docs/search${qs}`));

beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue(INDEX);
});

describe('GET /docs/search', () => {
  it('renders per request, never at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('returns highlight segments, an anchor and a slug for a match', async () => {
    const res = await get('?q=skills');
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Record<string, unknown>[] };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      anchor: 'skills',
      heading: [{ match: true, text: 'Skills' }],
      slug: 'agents',
    });
    expect(Array.isArray(results[0]?.snippet)).toBe(true);
  });

  it('stems the query', async () => {
    const res = await get('?q=skill');
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
  });

  it('returns segments of text, never HTML', async () => {
    const res = await get('?q=raw');
    expect(res.headers.get('content-type')).toContain('application/json');
    const { results } = (await res.json()) as {
      results: { snippet: { text: string; match: boolean }[] }[];
    };
    const snippet = results[0]?.snippet ?? [];
    // The markup in the doc is plain text; only the matched word is flagged.
    expect(snippet.map((s) => s.text).join('')).toContain('<b>raw</b>');
    expect(snippet.filter((s) => s.match).map((s) => s.text)).toEqual(['raw']);
  });

  it('caps the results at MAX_RESULTS', async () => {
    const res = await get('?q=needle');
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(MAX_RESULTS);
  });

  it('answers no results, without touching the index, for a missing, empty or blank q', async () => {
    for (const qs of ['', '?q=', '?q=%20%20%20']) {
      const res = await get(qs);
      expect(res.status, qs).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('trims q and cuts it to MAX_QUERY_CHARS', async () => {
    const trimmed = await get('?q=%20%20skills%20%20');
    expect(((await trimmed.json()) as { results: unknown[] }).results).toHaveLength(1);
    // The first 100 characters decide: a term past the cap is not searched.
    const long = await get(`?q=${'x'.repeat(MAX_QUERY_CHARS)}%20skills`);
    expect(await long.json()).toEqual({ results: [] });
    const huge = await get(`?q=${'x'.repeat(100_000)}`);
    expect(huge.status).toBe(200);
  });

  it('fails with a fixed message and 500 when the index cannot be built', async () => {
    load.mockRejectedValue(new Error('ENOENT /secret/path'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get('?q=skills');
    expect(logged).toHaveBeenCalledWith('[docs/search] index build failed', expect.any(Error));
    logged.mockRestore();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('ENOENT');
    expect(text).toContain('unavailable');
  });

  it('does not cache an empty answer, and keeps a real one private', async () => {
    expect((await get('?q=')).headers.get('cache-control')).toBe('no-store');
    expect((await get('?q=skills')).headers.get('cache-control')).toContain('private');
  });
});
