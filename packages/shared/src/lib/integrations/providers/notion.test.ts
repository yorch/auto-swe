import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedKnowledgeBaseConfig } from '../registry.js';
import { NotionKnowledgeBaseProvider } from './notion.js';

const config: ResolvedKnowledgeBaseConfig = {
  apiToken: 'secret_test_token',
  baseUrl: null,
  email: null,
  enabled: true,
  maxPages: 5,
  provider: 'notion',
  spaces: [],
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    json: async () => body,
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NotionKnowledgeBaseProvider — request shape', () => {
  it('sends Bearer auth, Notion-Version header, and a JSON body on search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    await provider.searchPages('quarterly report', []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret_test_token');
    expect(init.headers['Notion-Version']).toBe('2022-06-28');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.query).toBe('quarterly report');
    expect(body.filter).toEqual({ property: 'object', value: 'page' });
    expect(body.page_size).toBe(5);
  });

  it('sends an empty auth header segment when apiToken is null (never throws building the request)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider({ ...config, apiToken: null });
    await provider.searchPages('q', []);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer ');
  });

  it('fetchPage issues parallel GET requests for the page and its block children', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'page-1',
          object: 'page',
          properties: { title: { title: [{ plain_text: 'My Page' }] } },
          url: 'https://notion.so/page-1',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    await provider.fetchPage('page-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pageCall = fetchMock.mock.calls[0];
    const blocksCall = fetchMock.mock.calls[1];
    expect(pageCall[0]).toBe('https://api.notion.com/v1/pages/page-1');
    expect(pageCall[1].method).toBe('GET');
    expect(blocksCall[0]).toBe('https://api.notion.com/v1/blocks/page-1/children');
    expect(blocksCall[1].method).toBe('GET');
  });
});

describe('NotionKnowledgeBaseProvider.fetchPage — response mapping', () => {
  it('maps a "title" property page + block children into bodyText/title/url/id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'abc-123',
          object: 'page',
          properties: { title: { title: [{ plain_text: 'Design Doc' }] } },
          url: 'https://notion.so/abc-123',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { paragraph: { rich_text: [{ plain_text: 'First paragraph.' }] }, type: 'paragraph' },
            { heading_1: { rich_text: [{ plain_text: 'A Heading' }] }, type: 'heading_1' },
          ],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const page = await provider.fetchPage('abc-123');

    expect(page).toEqual({
      bodyText: 'First paragraph.\nA Heading',
      id: 'abc-123',
      title: 'Design Doc',
      url: 'https://notion.so/abc-123',
    });
  });

  it('falls back to the "Name" property when "title" is absent (database-page shape)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'db-page-1',
          object: 'page',
          properties: { Name: { title: [{ plain_text: 'Database Row Title' }] } },
          url: 'https://notion.so/db-page-1',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const page = await provider.fetchPage('db-page-1');

    expect(page?.title).toBe('Database Row Title');
    expect(page?.bodyText).toBe('');
  });

  it('returns null (never throws) on a 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }, false, 404));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const page = await provider.fetchPage('missing-page');

    expect(page).toBeNull();
  });

  it('returns null (never throws) on a non-404 API error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, false, 500));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const page = await provider.fetchPage('page-1');

    expect(page).toBeNull();
  });

  it('returns null (never throws) when fetch itself rejects (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const page = await provider.fetchPage('page-1');

    expect(page).toBeNull();
  });
});

describe('NotionKnowledgeBaseProvider.searchPages', () => {
  it('maps results to KnowledgePage[] with empty bodyText (search does not fetch bodies)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: 'p1',
            object: 'page',
            properties: { title: { title: [{ plain_text: 'Page One' }] } },
            url: 'https://notion.so/p1',
          },
          {
            id: 'p2',
            object: 'page',
            properties: { title: { title: [{ plain_text: 'Page Two' }] } },
            url: 'https://notion.so/p2',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.searchPages('q', []);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({
      bodyText: '',
      id: 'p1',
      title: 'Page One',
      url: 'https://notion.so/p1',
    });
    expect(pages[1].title).toBe('Page Two');
  });

  it('truncates results to maxPages (pagination cap)', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      object: 'page',
      properties: { title: { title: [{ plain_text: `Page ${i}` }] } },
      url: `https://notion.so/p${i}`,
    }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }));
    vi.stubGlobal('fetch', fetchMock);

    // config.maxPages is 5.
    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.searchPages('q', []);

    expect(pages).toHaveLength(5);
  });

  it('opts.maxPages overrides config.maxPages', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      object: 'page',
      properties: {},
      url: `https://notion.so/p${i}`,
    }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.searchPages('q', [], { maxPages: 2 });

    expect(pages).toHaveLength(2);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).page_size).toBe(2);
  });

  it('filters to pages whose parent database matches the requested spaces, ignoring dashes', async () => {
    const results = [
      {
        id: 'in-space',
        object: 'page',
        parent: { database_id: 'aaaa-bbbb-cccc', type: 'database_id' },
        properties: {},
        url: 'https://notion.so/in-space',
      },
      {
        id: 'other-space',
        object: 'page',
        parent: { database_id: 'zzzz-yyyy-xxxx', type: 'database_id' },
        properties: {},
        url: 'https://notion.so/other-space',
      },
      {
        id: 'no-parent-database',
        object: 'page',
        parent: { page_id: 'some-page', type: 'page_id' },
        properties: {},
        url: 'https://notion.so/no-parent-database',
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    // Space id given without dashes; page's database_id has dashes — must still match.
    const pages = await provider.searchPages('q', ['aaaabbbbcccc']);

    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('in-space');
  });

  it('returns an empty array (never throws) on an API error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'rate limited' }, false, 429));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.searchPages('q', []);

    expect(pages).toEqual([]);
  });

  it('returns an empty array (never throws) when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.searchPages('q', []);

    expect(pages).toEqual([]);
  });
});

describe('NotionKnowledgeBaseProvider.fetchLinkedPages', () => {
  it('fetches each linked page and drops ones that resolve to null', async () => {
    const fetchMock = vi
      .fn()
      // page 1: found
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'linked-1',
          object: 'page',
          properties: { title: { title: [{ plain_text: 'Linked One' }] } },
          url: 'https://notion.so/linked-1',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      // page 2: 404 -> null, filtered out
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, false, 404))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const pages = await provider.fetchLinkedPages(['linked-1', 'missing']);

    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('linked-1');
  });

  it('caps the number of ids fetched at maxPages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    // config.maxPages is 5; ask for 8 ids.
    const provider = new NotionKnowledgeBaseProvider(config);
    await provider.fetchLinkedPages(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    // 5 ids kept, each issuing 2 requests (page + blocks) = 10 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe('NotionKnowledgeBaseProvider.createPage', () => {
  it('creates a page under an explicit parentPageId and returns id/url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'new-page', url: 'https://notion.so/new-page' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    const created = await provider.createPage({
      bodyText: 'body text',
      parentPageId: 'parent-1',
      spaceKey: 'ignored',
      title: 'New Page',
    });

    expect(created).toEqual({ id: 'new-page', url: 'https://notion.so/new-page' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.parent).toEqual({ page_id: 'parent-1', type: 'page_id' });
    expect(body.properties.title.title[0].text.content).toBe('New Page');
    expect(body.properties.Name.title[0].text.content).toBe('New Page');
  });

  it('falls back to the first configured space as a database parent when no parentPageId is given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'new-page', url: 'https://notion.so/new-page' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider({ ...config, spaces: ['db-1', 'db-2'] });
    await provider.createPage({ bodyText: 'body', spaceKey: 'ignored', title: 'T' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.parent).toEqual({ database_id: 'db-1', type: 'database_id' });
  });

  it('returns null without calling fetch when there is neither a parentPageId nor a configured space', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider({ ...config, spaces: [] });
    const created = await provider.createPage({
      bodyText: 'body',
      spaceKey: 'ignored',
      title: 'T',
    });

    expect(created).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncates bodyText to 2000 characters in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'new-page', url: 'https://notion.so/new-page' }));
    vi.stubGlobal('fetch', fetchMock);

    const longBody = 'x'.repeat(3000);
    const provider = new NotionKnowledgeBaseProvider({ ...config, spaces: ['db-1'] });
    await provider.createPage({ bodyText: longBody, spaceKey: 'ignored', title: 'T' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.children[0].paragraph.rich_text[0].text.content).toHaveLength(2000);
  });

  it('returns null (never throws) on an API error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'denied' }, false, 403));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider({ ...config, spaces: ['db-1'] });
    const created = await provider.createPage({
      bodyText: 'body',
      spaceKey: 'ignored',
      title: 'T',
    });

    expect(created).toBeNull();
  });
});

describe('NotionKnowledgeBaseProvider.updatePageWithPrLink', () => {
  it('PATCHes the block children with a bold PR title and a linked PR URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    await provider.updatePageWithPrLink('page-1', 'https://github.com/org/repo/pull/1', 'Fix bug');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/blocks/page-1/children');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    const richText = body.children[0].paragraph.rich_text;
    expect(richText[0].annotations).toEqual({ bold: true });
    expect(richText[0].text.content).toBe('Fix bug: ');
    expect(richText[1].text.content).toBe('https://github.com/org/repo/pull/1');
    expect(richText[1].text.link).toEqual({ url: 'https://github.com/org/repo/pull/1' });
  });

  it('swallows errors — never throws to the caller (advisory update)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new NotionKnowledgeBaseProvider(config);
    await expect(
      provider.updatePageWithPrLink('page-1', 'https://x', 'title')
    ).resolves.toBeUndefined();
  });
});
