import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHubSpotRecord,
  fetchHubSpotRecord,
  searchHubSpotRecords,
  updateHubSpotRecord,
} from './hubspot.js';

const TOKEN = 'pat-na1-secret';
const conn = { apiToken: TOKEN };
const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

const record = {
  archived: false,
  createdAt: '2024-01-01T00:00:00Z',
  id: '101',
  properties: { email: 'a@b.com' },
  updatedAt: '2024-01-02T00:00:00Z',
};

describe('hubspot connector', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json(record));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('fetches a record with bearer auth, no redirects, on the fixed host', async () => {
    const out = await fetchHubSpotRecord(conn, {
      objectId: '101',
      objectType: 'contacts',
      properties: ['email', 'firstname'],
    });
    expect(out).toEqual(record);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.hubapi.com/crm/v3/objects/contacts/101?properties=email,firstname'
    );
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('creates a record, turning null into the empty string', async () => {
    await createHubSpotRecord(conn, {
      objectType: 'deals',
      properties: { amount: 5, dealname: 'x', nope: null, vip: true },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/deals');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      properties: { amount: 5, dealname: 'x', nope: '', vip: true },
    });
  });

  it('updates a record with PATCH', async () => {
    await updateHubSpotRecord(conn, {
      objectId: '7',
      objectType: '2-1234',
      properties: { a: 'b' },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/2-1234/7');
    expect(init.method).toBe('PATCH');
  });

  it('searches with filters, limit and paging', async () => {
    fetchMock.mockResolvedValue(
      json({ paging: { next: { after: '20' } }, results: [record], total: 41 })
    );
    const out = await searchHubSpotRecords(conn, {
      filterGroups: [{ filters: [{ operator: 'EQ', propertyName: 'email', value: 'a@b.com' }] }],
      limit: 20,
      objectType: 'contacts',
      query: 'bob',
    });
    expect(out).toEqual({ nextAfter: '20', results: [record], total: 41 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    expect(JSON.parse(init.body)).toMatchObject({ limit: 20, query: 'bob' });
  });

  describe('validation refuses before sending', () => {
    it.each([
      ['empty type', { objectId: '1', objectType: '' }],
      ['traversal type', { objectId: '1', objectType: '../x' }],
      ['slash type', { objectId: '1', objectType: 'contacts/1' }],
      ['query type', { objectId: '1', objectType: 'contacts?x' }],
      ['digit start type', { objectId: '1', objectType: '1abc' }],
      ['non-numeric id', { objectId: 'abc', objectType: 'contacts' }],
      ['traversal id', { objectId: '1/../2', objectType: 'contacts' }],
      ['long id', { objectId: '1'.repeat(33), objectType: 'contacts' }],
    ])('fetch: %s', async (_n, input) => {
      await expect(fetchHubSpotRecord(conn, input)).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses bad property names, values and filters', async () => {
      const bad = [
        () =>
          fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts', properties: ['a b'] }),
        () => createHubSpotRecord(conn, { objectType: 'contacts', properties: {} }),
        () => createHubSpotRecord(conn, { objectType: 'contacts', properties: { 'a/b': 'x' } }),
        () =>
          createHubSpotRecord(conn, {
            objectType: 'contacts',
            properties: { a: { x: 1 } as never },
          }),
        () =>
          updateHubSpotRecord(conn, {
            objectId: 'x',
            objectType: 'contacts',
            properties: { a: 'b' },
          }),
        () => searchHubSpotRecords(conn, { limit: 101, objectType: 'contacts' }),
        () => searchHubSpotRecords(conn, { limit: 0, objectType: 'contacts' }),
        () =>
          searchHubSpotRecords(conn, {
            filterGroups: [{ filters: [{ operator: 'DROP', propertyName: 'a' }] }],
            objectType: 'contacts',
          }),
        () => searchHubSpotRecords(conn, { after: '../x', objectType: 'contacts' }),
      ];
      for (const run of bad) {
        await expect(run()).rejects.toMatchObject({ type: 'NOT_SENT' });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a connection with no token', async () => {
      await expect(
        fetchHubSpotRecord({ apiToken: null }, { objectId: '1', objectType: 'contacts' })
      ).rejects.toMatchObject({ type: 'NOT_SENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it.each([
      [400, false],
      [401, false],
      [404, false],
      [409, false],
      [429, true],
      [500, true],
      [502, true],
    ])('maps %i (retryable: %s) without the body or token', async (status, retryable) => {
      fetchMock.mockResolvedValue(json({ message: `bad ${TOKEN}` }, status));
      const err = await fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts' }).catch(
        (e) => e
      );
      expect(err.nonRetryable).toBe(!retryable);
      expect(err.message).toBe(`HubSpot GET /crm/v3/objects/contacts/1 failed (${status})`);
      expect(err.message).not.toContain(TOKEN);
    });

    it('refuses a response over the size cap', async () => {
      fetchMock.mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1)));
      await expect(
        fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts' })
      ).rejects.toMatchObject({ nonRetryable: true });
    });

    it('words a transport error without the token', async () => {
      fetchMock.mockRejectedValue(new TypeError(`boom ${TOKEN}`));
      const err = await fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts' }).catch(
        (e) => e
      );
      expect(err.message).not.toContain(TOKEN);
      expect(err.nonRetryable).toBe(false);
      expect(JSON.stringify(err.cause)).not.toContain(TOKEN);
      expect(String(err.cause?.stack ?? '')).not.toContain(TOKEN);
    });

    it('treats a name-resolution failure in the cause chain as not sent and retryable', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.hubapi.com'), {
            code: 'ENOTFOUND',
          }),
        })
      );
      const err = await fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts' }).catch(
        (e) => e
      );
      expect(err.type).toBe('NOT_SENT');
      expect(err.nonRetryable).toBe(false);
    });

    it('treats a 429 as not sent and retryable', async () => {
      fetchMock.mockResolvedValue(json({}, 429));
      const err = await fetchHubSpotRecord(conn, { objectId: '1', objectType: 'contacts' }).catch(
        (e) => e
      );
      expect(err.type).toBe('NOT_SENT');
      expect(err.nonRetryable).toBe(false);
    });

    it('refuses a token that is not a valid header value without echoing it', async () => {
      const bad = 'pat\nsecret';
      const err = await fetchHubSpotRecord(
        { apiToken: bad },
        { objectId: '1', objectType: 'contacts' }
      ).catch((e) => e);
      expect(err.type).toBe('NOT_SENT');
      expect(err.message).not.toContain('secret');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes the caller signal to the request', async () => {
      const ctl = new AbortController();
      await fetchHubSpotRecord(
        conn,
        { objectId: '1', objectType: 'contacts' },
        { signal: ctl.signal }
      );
      ctl.abort();
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    });
  });
});
