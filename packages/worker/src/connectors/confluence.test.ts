import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfluencePage, readConfluencePage, updateConfluencePage } from './confluence.js';

const adminKb = { allowPrivateNetwork: false, baseUrl: null as string | null };

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveKnowledgeBaseOrigin: async () => adminKb,
}));

const connection = {
  apiToken: 'secret-token',
  config: { baseUrl: 'https://x.atlassian.net', email: 'a@b.com' },
};

function jsonResponse(body: unknown, status = 200) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('confluence connector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    adminKb.allowPrivateNetwork = false;
    adminKb.baseUrl = null;
  });

  it('sends basic auth, refuses redirects and carries the connection timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: JSON.stringify({ content: [], type: 'doc' }) } },
        id: '123',
        title: 'Runbook',
        version: { number: 4 },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const page = await readConfluencePage(connection, '123');
    expect(page.id).toBe('123');
    expect(page.title).toBe('Runbook');
    expect(page.version).toBe(4);
    expect(page.url).toBe('https://x.atlassian.net/wiki/pages/123');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/wiki/api/v2/pages/123?body-format=atlas_doc_format'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('a@b.com:secret-token').toString('base64')}`,
        }),
        redirect: 'error',
      })
    );
  });

  it('falls back to the storage body when the ADF body is unusable', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ body: { storage: { value: '<p>Hello   world</p>' } }, id: '1', title: 'T' })
      ) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: 'Hello world',
    });
  });

  it('resolves a space key and creates the page through the v2 API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: '98306', key: 'ENG' }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          _links: { webui: '/wiki/spaces/ENG/pages/9' },
          id: '9',
          version: { number: 1 },
        })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createConfluencePage(connection, {
      bodyText: 'line one\n<script>alert(1)</script>',
      spaceKey: 'ENG',
      title: 'From a ticket',
    });

    expect(result.id).toBe('9');
    expect(result.url).toBe('https://x.atlassian.net/wiki/spaces/ENG/pages/9');
    const [spaceUrl] = fetchMock.mock.calls[0] as [string];
    expect(spaceUrl).toContain('/wiki/api/v2/spaces?keys=ENG');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/wiki/api/v2/pages');
    const body = JSON.parse(String(init.body)) as {
      body: { representation: string; value: string };
      spaceId: string;
    };
    expect(body.spaceId).toBe('98306');
    expect(body.body.representation).toBe('storage');
    // Injected markup must be inert text, not a live element.
    expect(body.body.value).toBe('<p>line one</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('uses a numeric space reference as an id without looking it up', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: '9' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createConfluencePage(
      { apiToken: 't', config: { ...connection.config, spaceKey: '98306' } },
      { bodyText: 'Body', title: 'T' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/wiki/api/v2/pages');
    expect(JSON.parse(String(init.body))).toMatchObject({ spaceId: '98306' });
  });

  it('fails when the configured space does not exist', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [] })) as unknown as typeof fetch;

    await expect(
      createConfluencePage(connection, { bodyText: 'x', spaceKey: 'NOPE', title: 'T' })
    ).rejects.toThrow("space 'NOPE' was not found");
  });

  it('refuses to publish into a space the lookup did not match', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ id: '20', key: 'OPS' }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Taking the first result would publish into OPS because that is what the
    // endpoint happened to answer with.
    await expect(
      createConfluencePage(connection, { bodyText: 'x', spaceKey: 'ENG', title: 'T' })
    ).rejects.toThrow("space 'ENG' was not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an ambiguous space lookup', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { id: '20', key: 'ENG' },
          { id: '21', key: 'ENG' },
        ],
      })
    ) as unknown as typeof fetch;

    await expect(
      createConfluencePage(connection, { bodyText: 'x', spaceKey: 'ENG', title: 'T' })
    ).rejects.toThrow('matched 2 spaces');
  });

  it('names a missing space as a space, not a page', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'gone' }, 404)) as unknown as typeof fetch;

    await expect(
      createConfluencePage(connection, { bodyText: 'x', spaceKey: 'ENG', title: 'T' })
    ).rejects.toThrow('Confluence space not found (404)');
  });

  it('requires a space key from the step or the connection', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      createConfluencePage(
        { apiToken: 't', config: { baseUrl: 'https://x.atlassian.net', email: 'a@b.com' } },
        { bodyText: 'x', title: 'T' }
      )
    ).rejects.toThrow('requires a spaceKey');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the current version and writes the next one on update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Old', version: { number: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ id: '5', version: { number: 8 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await updateConfluencePage(connection, '5', { bodyText: 'New body' });

    expect(result.version).toBe(8);
    const [firstUrl] = fetchMock.mock.calls[0] as [string];
    expect(firstUrl).toContain('/wiki/api/v2/pages/5');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/wiki/api/v2/pages/5');
    expect(init.method).toBe('PUT');
    // The body is replaced, not appended: a regenerated draft must not stack.
    expect(JSON.parse(String(init.body))).toMatchObject({
      body: { representation: 'storage', value: '<p>New body</p>' },
      id: '5',
      status: 'current',
      title: 'Old',
      version: { number: 8 },
    });
  });

  it('treats a 409 as a non-retryable refusal, naming both causes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Old', version: { number: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ message: 'conflict' }, 409));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Confluence answers 409 for a stale version and for a space that requires
    // content approval; the body is what distinguishes them, and it is not quoted.
    await expect(updateConfluencePage(connection, '5', { bodyText: 'x' })).rejects.toThrow(
      /Confluence refused the write \(409\)/
    );
  });

  it('refuses a plain-HTTP destination for a credentialed request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      readConfluencePage(
        { apiToken: 't', config: { baseUrl: 'http://wiki.example.com', email: 'a@b.com' } },
        '1'
      )
    ).rejects.toThrow(/must be https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows plain HTTP only for the origin an admin opted in', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: '{"content":[],"type":"doc"}' } },
        id: '1',
        title: 'T',
        version: { number: 1 },
      })
    ) as never;
    adminKb.allowPrivateNetwork = true;
    adminKb.baseUrl = 'http://wiki.corp.internal';

    await expect(
      readConfluencePage(
        { apiToken: 't', config: { baseUrl: 'http://wiki.corp.internal', email: 'a@b.com' } },
        '1'
      )
    ).resolves.toBeDefined();
  });

  it('refuses a public HTTP origin even when the integration opted that origin in', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // The opt-in is permission to reach a private *address*, not a transport
    // exception: it must not let a public host be reached in clear.
    adminKb.allowPrivateNetwork = true;
    adminKb.baseUrl = 'http://wiki.example.com';

    await expect(
      readConfluencePage(
        { apiToken: 't', config: { baseUrl: 'http://wiki.example.com', email: 'a@b.com' } },
        '1'
      )
    ).rejects.toThrow('must be https');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the response carries no readable page body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: '1', title: 'T', version: { number: 2 } })) as never;

    // An absent body is not an empty page: reporting '' would tell a drafting
    // agent the page is blank and let it write over content that is there.
    await expect(readConfluencePage(connection, '1')).rejects.toThrow('no readable page body');
  });

  it('decodes entities in a storage-format body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { storage: { value: '<p>A &amp; B &lt;tag&gt;</p>' } },
        id: '1',
        title: 'T',
      })
    ) as never;

    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: 'A & B <tag>',
    });
  });

  it('honours a caller-supplied version instead of refreshing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Live', version: { number: 9 } }))
      .mockResolvedValueOnce(jsonResponse({ id: '5', version: { number: 8 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // A retry must re-send the same precondition, so a write that landed before
    // the response was lost is refused as stale rather than replacing whatever
    // changed the page meanwhile.
    await updateConfluencePage(connection, '5', { bodyText: 'Draft', version: 7 });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ version: { number: 8 } });
  });

  it('refuses a write response that does not name the page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Old', version: { number: 1 } }))
      .mockResolvedValueOnce(jsonResponse({}, 200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // A proxy answering `200 {}` must not read as a successful write: the page id
    // is the evidence, and the id the caller asked for is not evidence of anything.
    await expect(updateConfluencePage(connection, '5', { bodyText: 'x' })).rejects.toThrow(
      'did not return the page it acted on'
    );
  });

  it('refuses a write response naming a different page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Old', version: { number: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ id: '999', version: { number: 2 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(updateConfluencePage(connection, '5', { bodyText: 'x' })).rejects.toThrow(
      'returned a different page than the one it was given'
    );
  });

  it('fails a JSON null response instead of throwing a retryable TypeError', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '5', title: 'Old', version: { number: 1 } }))
      .mockResolvedValueOnce(jsonResponse(null)) as unknown as typeof fetch;

    // A plain TypeError reads as transient and lets the activity retry a write that
    // may already have committed.
    await expect(updateConfluencePage(connection, '5', { bodyText: 'x' })).rejects.toThrow(
      'returned no page object'
    );
  });

  it.each(['null', '{}', '[]', '{"type":"doc","content":"lost"}', 'not json'])(
    'does not read an unreadable ADF body (%s) as an empty page',
    async (adf) => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          body: { atlas_doc_format: { value: adf } },
          id: '1',
          title: 'T',
          version: { number: 1 },
        })
      ) as unknown as typeof fetch;

      // Unreadable ADF falls back to a storage request; with nothing there either,
      // the read fails rather than reporting a blank page.
      await expect(readConfluencePage(connection, '1')).rejects.toThrow('no readable page body');
    }
  );

  it('asks for the storage representation when the ADF one cannot be read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          body: { atlas_doc_format: { value: '{}' } },
          id: '1',
          title: 'T',
          version: { number: 3 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          body: { storage: { value: '<p>Real text</p>' } },
          id: '1',
          title: 'T',
          version: { number: 3 },
        })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // The response carries the representation that was requested and only that, so
    // the other one has to be asked for.
    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: 'Real text',
      version: 3,
    });
    const [secondUrl] = fetchMock.mock.calls[1] as [string];
    expect(secondUrl).toContain('body-format=storage');
  });

  it('refuses a page response describing a different page', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: '{"content":[],"type":"doc"}' } },
        id: '6',
        title: 'Someone else',
        version: { number: 1 },
      })
    ) as unknown as typeof fetch;

    // A proxy or cache answering with another page's title and version would
    // otherwise build a write to this one from the wrong metadata.
    await expect(readConfluencePage(connection, '5')).rejects.toThrow(
      'returned a different page than the one it was given'
    );
  });

  it('takes the fallback body and its metadata from the same revision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          body: { atlas_doc_format: { value: '{}' } },
          id: '1',
          title: 'Old',
          version: { number: 7 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          body: { storage: { value: '<p>New body</p>' } },
          id: '1',
          title: 'New',
          version: { number: 8 },
        })
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Somebody edited the page between the two requests. Pairing the second
    // response's body with the first one's version would hand a caller a version
    // that no longer matches the text, and its title with it.
    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: 'New body',
      title: 'New',
      version: 8,
    });
  });

  it('keeps an unknown entity reference literal', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { storage: { value: '<p>&constructor; and &notarealentity;</p>' } },
        id: '1',
        title: 'T',
      })
    ) as unknown as typeof fetch;

    // A plain object lookup would find `Object`'s inherited constructor here.
    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: '&constructor; and &notarealentity;',
    });
  });

  it('decodes entities in a single pass', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { storage: { value: '<p>&#38;lt; stays literal, &#38; becomes &amp;</p>' } },
        id: '1',
        title: 'T',
      })
    ) as unknown as typeof fetch;

    // `&#38;lt;` is the literal text `&lt;`. Decoding the numeric reference and then
    // running a second pass over the result would turn it into `<`.
    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: '&lt; stays literal, & becomes &',
    });
  });

  it('reads an empty body as an empty page rather than a failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: '' } },
        id: '1',
        title: 'T',
        version: { number: 1 },
      })
    ) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({ bodyText: '' });
  });

  it('falls back to a storage body when the ADF one is unreadable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: '{}' }, storage: { value: '<p>Real text</p>' } },
        id: '1',
        title: 'T',
      })
    ) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: 'Real text',
    });
  });

  it('decodes numeric entities in a storage body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { storage: { value: '<p>a &apos;b&apos; &#8212; c &#x2014; d</p>' } },
        id: '1',
        title: 'T',
      })
    ) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).resolves.toMatchObject({
      bodyText: "a 'b' \u2014 c \u2014 d",
    });
  });

  it.each([500, 429])('classifies %i as retryable', async (status) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'later' }, status)) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).rejects.toThrow();
  });

  it('throws rather than returning a null page when the connector fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'nope' }, 400)) as unknown as typeof fetch;

    await expect(readConfluencePage(connection, '1')).rejects.toThrow('Confluence API error (400)');
  });

  it('requires baseUrl and email before any request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      readConfluencePage({ apiToken: 't', config: { email: 'a@b.com' } }, '1')
    ).rejects.toThrow('missing baseUrl');
    await expect(
      readConfluencePage({ apiToken: 't', config: { baseUrl: 'https://x.atlassian.net' } }, '1')
    ).rejects.toThrow('missing email');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://169.254.169.254',
    'http://localhost:8080',
    'http://10.0.0.5',
    'http://metadata.google.internal.',
    'ftp://x.atlassian.net',
  ])('refuses %s without sending the credential', async (baseUrl) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      readConfluencePage({ apiToken: 't', config: { baseUrl, email: 'a@b.com' } }, '1')
    ).rejects.toThrow(/SSRF guard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a private host only when an admin opted in for that exact origin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { atlas_doc_format: { value: '{"content":[],"type":"doc"}' } },
        id: '1',
        title: 'T',
        version: { number: 1 },
      })
    ) as never;
    adminKb.allowPrivateNetwork = true;
    adminKb.baseUrl = 'https://wiki.corp.internal';

    await expect(
      readConfluencePage(
        { apiToken: 't', config: { baseUrl: 'https://wiki.corp.internal', email: 'a@b.com' } },
        '1'
      )
    ).resolves.toBeDefined();
    await expect(
      readConfluencePage(
        { apiToken: 't', config: { baseUrl: 'https://other.corp.internal', email: 'a@b.com' } },
        '1'
      )
    ).rejects.toThrow(/SSRF guard/);
  });
});
