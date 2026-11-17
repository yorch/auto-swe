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

    const result = await readNotionPage(connection, '0123456789abcdef0123456789abcdef');
    expect(result.page.id).toBe('page-1');
    expect(result.blocks).toEqual([{ type: 'paragraph' }]);
  });

  it('appends blocks to a page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ results: [] }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await appendNotionBlocks(connection, '0123456789abcdef0123456789abcdef', [
      { paragraph: { rich_text: [{ text: { content: 'hello' } }] }, type: 'paragraph' },
    ]);
    expect(result.pageId).toBe('0123456789abcdef0123456789abcdef');
    expect(result.appended).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a page under a parent page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ id: 'new-page', object: 'page', url: 'https://notion.so/new-page' }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createNotionPage(connection, {
      pageId: '0123456789abcdef0123456789abcdef',
      title: 'Draft',
    });
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

    await expect(readNotionPage(connection, '0123456789abcdef0123456789abcdef')).rejects.toThrow(
      'authentication failed'
    );
  });

  it.each([
    ['a path traversal', '../users'],
    ['a short id', 'abc123'],
    ['a url', 'https://notion.so/x'],
  ])('refuses %s as a page id before any request, in every function', async (_n, bad) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(readNotionPage(connection, bad)).rejects.toMatchObject({ type: 'NOT_SENT' });
    await expect(appendNotionBlocks(connection, bad, [])).rejects.toMatchObject({
      type: 'NOT_SENT',
    });
    await expect(createNotionPage(connection, { pageId: bad })).rejects.toMatchObject({
      type: 'NOT_SENT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a dashed id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ results: [] }), ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await appendNotionBlocks(connection, '01234567-89ab-cdef-0123-456789abcdef', []);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not check the parent page id when a database is named', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ id: 'n', object: 'page', url: 'u' }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await createNotionPage(connection, { databaseId: 'db-1', pageId: 'not an id' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
