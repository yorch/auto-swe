import { describe, expect, it, vi } from 'vitest';
import { fetchGuarded, RedirectRefusedError } from './guardedFetch.js';

const redirect = (status: number, location: string) =>
  ({ body: null, headers: new Headers({ location }), status }) as unknown as Response;
const done = { body: null, headers: new Headers(), status: 200 } as unknown as Response;

describe('fetchGuarded', () => {
  it('forwards only allowlisted headers to another origin', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, '/same'))
      .mockResolvedValueOnce(redirect(302, 'https://other.example/x'))
      .mockResolvedValueOnce(done);
    await fetchGuarded(
      'https://api.example/a',
      {
        headers: {
          Accept: 'a',
          Authorization: 'Bearer t',
          Cookie: 'sid=1',
          'X-Api-Key': 'k',
          'X-Custom-Auth': 'c',
          'X-Figma-Token': 'f',
        },
      },
      { check: () => true, credentialOrigin: 'https://api.example', fetchImpl }
    );
    const headers = fetchImpl.mock.calls.map((c) => c[1].headers);
    expect(Object.keys(headers[1]).sort()).toEqual(
      ['Accept', 'Authorization', 'Cookie', 'X-Api-Key', 'X-Custom-Auth', 'X-Figma-Token'].sort()
    );
    expect(Object.keys(headers[2])).toEqual(['Accept']);
  });

  it('refuses a cross-origin hop for a write', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(307, 'https://other.example/x'));
    await expect(
      fetchGuarded(
        'https://api.example/a',
        { body: 'x', method: 'POST' },
        { check: () => true, credentialOrigin: 'https://api.example', fetchImpl }
      )
    ).rejects.toThrow(/write/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a hop the check rejects, without requesting it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(301, 'http://127.0.0.1/x'));
    await expect(
      fetchGuarded(
        'https://api.example/a',
        {},
        { check: (u) => u.hostname !== '127.0.0.1', fetchImpl }
      )
    ).rejects.toThrow(RedirectRefusedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps hops', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirect(301, '/n'));
    await expect(
      fetchGuarded('https://a.example/', {}, { check: () => true, fetchImpl, maxHops: 2 })
    ).rejects.toThrow(/too many/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps method and body on 307 and refuses to rewrite on 302', async () => {
    const ok = vi.fn().mockResolvedValueOnce(redirect(307, '/n')).mockResolvedValueOnce(done);
    await fetchGuarded(
      'https://a.example/',
      { body: 'x', method: 'POST' },
      { check: () => true, fetchImpl: ok }
    );
    expect(ok.mock.calls[1][1]).toMatchObject({ body: 'x', method: 'POST' });
    const bad = vi.fn().mockResolvedValueOnce(redirect(302, '/n'));
    await expect(
      fetchGuarded('https://a.example/', { method: 'POST' }, { check: () => true, fetchImpl: bad })
    ).rejects.toThrow(/method/);
  });
});
