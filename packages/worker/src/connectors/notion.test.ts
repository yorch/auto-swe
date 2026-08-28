import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendNotionBlocks, createNotionPage, readNotionPage } from './notion.js';

describe('notion connector', () => {
  const connection = { apiToken: 'secret-test' };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads a page and its blocks', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: 'page-1',
          object: 'page',
          properties: {},
          url: 'https://notion.so/page-1',
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({ results: [{ type: 'paragraph' }] }),
        ok: true,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await readNotionPage(connection, 'page-1');
    expect(result.page.id).toBe('page-1');
    expect(result.blocks).toEqual([{ type: 'paragraph' }]);
  });

  it('appends blocks to a page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ results: [] }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await appendNotionBlocks(connection, 'page-1', [
      { paragraph: { rich_text: [{ text: { content: 'hello' } }] }, type: 'paragraph' },
    ]);
    expect(result.pageId).toBe('page-1');
    expect(result.appended).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a page under a parent page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ id: 'new-page', object: 'page', url: 'https://notion.so/new-page' }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createNotionPage(connection, { pageId: 'parent-1', title: 'Draft' });
    expect(result.pageId).toBe('new-page');
    expect(result.url).toBe('https://notion.so/new-page');
  });

  it('throws on authentication failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(readNotionPage(connection, 'page-1')).rejects.toThrow('authentication failed');
  });
});
