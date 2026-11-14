import { afterEach, describe, expect, it, vi } from 'vitest';

// The guarded fetch is the seam: every request must go through it, so it is
// replaced with a recorder whose behaviour each test sets via `stub`.
const guarded = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock('./guardedDispatcher.js', () => ({ createGuardedFetch: guarded.create }));

import {
  fetchOwnRepoPermission,
  fetchRepoPermission,
  permissionMeets,
} from './githubPermission.js';

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
  guarded.create.mockReturnValue(spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  guarded.create.mockReset();
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

describe('fetchOwnRepoPermission', () => {
  const OWN = {
    apiUrl: 'https://ghe.corp/api/v3/',
    organizationName: 'acme',
    repoName: 'payments',
    token: 'user-tok',
  };

  it("asks for the repository itself with the user's token", async () => {
    const spy = stub(() => reply({ permissions: { admin: false, pull: true, push: true } }));
    await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({ ok: true, permission: 'write' });
    expect(spy.mock.calls[0][0]).toBe('https://ghe.corp/api/v3/repos/acme/payments');
    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer user-tok');
  });

  it('exposes the oauth scopes header only when GitHub sent one', async () => {
    stub(() =>
      reply({ permissions: { pull: true, push: true } }, { headers: { 'x-oauth-scopes': 'repo' } })
    );
    await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({
      oauthScopes: 'repo',
      ok: true,
      permission: 'write',
    });
    stub(() => reply({ permissions: { pull: true, push: true } }));
    const bare = await fetchOwnRepoPermission(OWN);
    expect(bare).not.toHaveProperty('oauthScopes');
  });

  it('never exposes the scopes header from the collaborator lookup', async () => {
    stub(() => reply({ permission: 'write' }, { headers: { 'x-oauth-scopes': 'repo' } }));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({ ok: true, permission: 'write' });
  });

  it('maps the permission flags to levels, strongest first', async () => {
    for (const [permissions, expected] of [
      [{ admin: true, pull: true, push: true }, 'admin'],
      [{ maintain: true, pull: true }, 'write'],
      [{ push: true }, 'write'],
      [{ triage: true }, 'read'],
      [{ pull: true }, 'read'],
      [{ admin: false, pull: false, push: false }, 'none'],
    ] as const) {
      stub(() => reply({ permissions }));
      await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({
        ok: true,
        permission: expected,
      });
    }
  });

  it('does not read a missing permissions object as none', async () => {
    // GitHub omits `permissions` for an unauthenticated view; that is not an
    // answer about the user.
    stub(() => reply({ full_name: 'acme/payments' }));
    await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });

  it('shares the failure taxonomy with the collaborator lookup', async () => {
    stub(() => reply({}, { status: 404 }));
    await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({
      failure: 'repo-not-found',
      ok: false,
    });
    stub(() => reply({}, { status: 401 }));
    await expect(fetchOwnRepoPermission(OWN)).resolves.toEqual({
      failure: 'credential-rejected',
      ok: false,
    });
  });
});

describe('the request is SSRF-guarded', () => {
  it('uses the guarded fetch and never the global one', async () => {
    const globalSpy = vi.fn();
    vi.stubGlobal('fetch', globalSpy);
    const spy = stub(() => reply({ permission: 'read' }));
    await fetchRepoPermission(QUERY);
    expect(guarded.create).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it('allows a private address for a GHE host only', async () => {
    stub(() => reply({ permission: 'read' }));
    await fetchRepoPermission({ ...QUERY, apiUrl: 'https://ghe.corp/api/v3' });
    expect(guarded.create).toHaveBeenLastCalledWith({ allowPrivate: true });
    await fetchOwnRepoPermission({ ...QUERY, apiUrl: 'https://ghe.corp/api/v3' });
    expect(guarded.create).toHaveBeenLastCalledWith({ allowPrivate: true });
    await fetchRepoPermission(QUERY);
    expect(guarded.create).toHaveBeenLastCalledWith({ allowPrivate: false });
  });

  it('follows a same-origin redirect and keeps the token', async () => {
    const spy = stub((url) =>
      url.endsWith('/repos/acme/payments')
        ? new Response(null, {
            headers: { location: 'https://api.github.com/repositories/42' },
            status: 301,
          })
        : reply({ permissions: { admin: true } })
    );
    await expect(fetchOwnRepoPermission(QUERY)).resolves.toEqual({
      ok: true,
      permission: 'admin',
    });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'https://api.github.com/repos/acme/payments',
      'https://api.github.com/repositories/42',
    ]);
    const second = spy.mock.calls[1][1]?.headers as Record<string, string>;
    expect(second.Authorization).toBe('Bearer tok');
    expect(spy.mock.calls[1][1]?.redirect).toBe('manual');
  });

  it('refuses a redirect to another origin: the answer would not be the API’s', async () => {
    const spy = stub((url) =>
      url.startsWith('https://api.github.com')
        ? new Response(null, { headers: { location: 'https://elsewhere.example/x' }, status: 302 })
        : reply({ permissions: { admin: true } })
    );
    await expect(fetchOwnRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.github.com/repos/acme/payments',
    ]);
  });

  it('refuses a redirect to a non-http scheme as unavailable', async () => {
    stub(() => new Response(null, { headers: { location: 'file:///etc/passwd' }, status: 302 }));
    await expect(fetchOwnRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });

  it('reports a redirect loop as unavailable without throwing', async () => {
    stub(
      () =>
        new Response(null, { headers: { location: 'https://api.github.com/loop' }, status: 301 })
    );
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });

  it('reports a guard block as unavailable without leaking its text', async () => {
    stub(() => Promise.reject(new Error('refused: 10.0.0.5 internal secret-token')));
    const result = await fetchRepoPermission(QUERY);
    expect(result).toEqual({ failure: 'unavailable', ok: false });
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });

  it('logs a guard refusal by class name only, so the operator can tell it from an outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blocked = Object.assign(new Error('refused: 10.0.0.5 secret-token'), {
      name: 'SsrfBlockedError',
    });
    stub(() => Promise.reject(new TypeError('fetch failed', { cause: blocked })));
    await expect(fetchRepoPermission(QUERY)).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('SsrfBlockedError');
    expect(line).not.toContain('10.0.0.5');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('api.github.com');
    warn.mockRestore();
  });

  it('does not log an ordinary network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stub(() => Promise.reject(new TypeError('fetch failed')));
    await fetchRepoPermission(QUERY);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
