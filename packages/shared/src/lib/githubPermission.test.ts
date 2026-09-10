import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoPermission, permissionMeets } from './githubPermission.js';

const QUERY = {
  apiUrl: 'https://api.github.com',
  organizationName: 'acme',
  repoName: 'payments',
  token: 'tok',
  username: 'octocat',
};

function reply(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
    ...init,
  });
}

function stub(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('permissionMeets', () => {
  it('orders the levels weakest to strongest', () => {
    expect(permissionMeets('admin', 'write')).toBe(true);
    expect(permissionMeets('write', 'write')).toBe(true);
    expect(permissionMeets('read', 'write')).toBe(false);
    expect(permissionMeets('none', 'read')).toBe(false);
    expect(permissionMeets('read', 'read')).toBe(true);
  });

  it('lets no level satisfy a requirement it does not reach', () => {
    // The gate's whole contract: `none` must never satisfy anything real.
    expect(permissionMeets('none', 'write')).toBe(false);
    expect(permissionMeets('none', 'admin')).toBe(false);
  });
});

describe('fetchRepoPermission', () => {
  it('asks the collaborator-permission endpoint for the named user', async () => {
    const spy = stub(() => reply({ permission: 'write' }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({ ok: true, permission: 'write' });
    expect(spy.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/payments/collaborators/octocat/permission'
    );
  });

  it('URL-encodes every interpolated segment', async () => {
    // Repository and org names are operator-entered and a login is third-party
    // data; none of them may escape their path segment.
    const spy = stub(() => reply({ permission: 'read' }));
    await fetchRepoPermission({
      ...QUERY,
      organizationName: 'acme/evil',
      repoName: 'a b',
      username: '../../admin',
    });
    expect(spy.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme%2Fevil/a%20b/collaborators/..%2F..%2Fadmin/permission'
    );
  });

  it('tolerates a GHE api base with a trailing slash', async () => {
    const spy = stub(() => reply({ permission: 'read' }));
    await fetchRepoPermission({ ...QUERY, apiUrl: 'https://ghe.example.com/api/v3/' });
    expect(spy.mock.calls[0][0]).toBe(
      'https://ghe.example.com/api/v3/repos/acme/payments/collaborators/octocat/permission'
    );
  });

  it('reports GitHub’s own "none" as a verdict, not a failure', async () => {
    await stub(() => reply({ permission: 'none' }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({ ok: true, permission: 'none' });
  });

  it('does not turn a 404 into a "none" verdict', async () => {
    // GitHub answers 404 both for "not a collaborator" and for "this credential
    // cannot see the repository at all". The second is an operator error about
    // the installation, not a statement about the user, so it must not be
    // recorded as a denial GitHub never issued.
    stub(() => reply({ message: 'Not Found' }, { status: 404 }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'repo-not-found',
      ok: false,
    });
  });

  it('separates a rate limit from a plain forbidden', async () => {
    // Both are 403; only the remaining-quota header tells them apart, and they
    // need different handling — one is transient, the other is not.
    stub(
      () =>
        new Response('{}', {
          headers: { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0' },
          status: 403,
        })
    );
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'rate-limited',
      ok: false,
    });

    stub(
      () =>
        new Response('{}', {
          headers: { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '4999' },
          status: 403,
        })
    );
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'credential-rejected',
      ok: false,
    });
  });

  it('maps 401 and 429 to their own failures', async () => {
    stub(() => reply({}, { status: 401 }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'credential-rejected',
      ok: false,
    });
    stub(() => reply({}, { status: 429 }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'rate-limited',
      ok: false,
    });
  });

  it('never throws when the request itself fails', async () => {
    stub(() => Promise.reject(new Error('ETIMEDOUT')));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });

  it('treats an unparseable body as unavailable', async () => {
    stub(() => new Response('not json', { status: 200 }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });

  it('refuses to coerce an unrecognised level into a verdict', async () => {
    // If GitHub ever adds a level, defaulting it to `none` would silently
    // revoke access from people who have it.
    stub(() => reply({ permission: 'maintain' }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
    stub(() => reply({}));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });
});
