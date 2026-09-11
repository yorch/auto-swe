import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGithubLogin,
  fetchGithubLogin,
  storeGithubLogin,
  syncGithubLoginForAccount,
} from './githubIdentity.js';

const API = 'https://api.github.com';

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

/**
 * Minimal Prisma stand-in. `clearGithubLogin` runs its two writes in a
 * transaction, so the stub has to honour the array form — forgetting the
 * repoAccess delete is exactly what would let a cleared login keep its cached
 * access.
 */
function prismaWith(update: (args: unknown) => Promise<unknown>): PrismaClient {
  return {
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
    repoAccess: { deleteMany: async () => ({ count: 0 }) },
    user: { update },
  } as unknown as PrismaClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchGithubLogin', () => {
  it('returns the login from the authenticated user', async () => {
    const spy = mockFetch(() => json({ id: 42, login: 'octocat' }));
    await expect(fetchGithubLogin('tok', API)).resolves.toBe('octocat');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('tolerates a GHE base URL with a trailing slash', async () => {
    // The configured apiUrl is operator-entered, so it may or may not end in a
    // slash; a doubled one would 404 and silently lose the login.
    const spy = mockFetch(() => json({ login: 'octocat' }));
    await fetchGithubLogin('tok', 'https://ghe.example.com/api/v3/');
    expect(spy.mock.calls[0][0]).toBe('https://ghe.example.com/api/v3/user');
  });

  it('returns null rather than throwing when GitHub refuses', async () => {
    // This runs on the sign-in path; a throw here would break signing in.
    mockFetch(() => json({ message: 'Bad credentials' }, 401));
    await expect(fetchGithubLogin('tok', API)).resolves.toBeNull();
  });

  it('returns null when the request itself fails', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNRESET')));
    await expect(fetchGithubLogin('tok', API)).resolves.toBeNull();
  });

  it('lower-cases the login', async () => {
    // GitHub logins are case-insensitive but the unique index is byte-exact, so
    // storing them as returned would let two platform users hold what GitHub
    // considers one identity.
    mockFetch(() => json({ login: 'OctoCat' }));
    await expect(fetchGithubLogin('tok', API)).resolves.toBe('octocat');
  });

  it('treats a missing or empty login as no login', async () => {
    mockFetch(() => json({ id: 42 }));
    await expect(fetchGithubLogin('tok', API)).resolves.toBeNull();
    mockFetch(() => json({ login: '' }));
    await expect(fetchGithubLogin('tok', API)).resolves.toBeNull();
  });
});

describe('storeGithubLogin', () => {
  it('writes the login to the named user', async () => {
    const update = vi.fn().mockResolvedValue({});
    await expect(storeGithubLogin(prismaWith(update), 'user-1', 'octocat')).resolves.toEqual({
      login: 'octocat',
    });
    expect(update).toHaveBeenCalledWith({
      data: { githubLogin: 'octocat' },
      where: { id: 'user-1' },
    });
  });

  it('refuses to move a login already held by another user, and clears the old one', async () => {
    // Stealing it would transfer that user's repository access to this one —
    // the precise thing the unique index exists to stop. Clearing matters just
    // as much: keeping the previous login would leave this user authenticating
    // as the account they just linked while the platform resolved their
    // repository permissions as the previous one. That is fail-closed for the
    // other user and fail-OPEN for this one.
    const update = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({});
    await expect(storeGithubLogin(prismaWith(update), 'user-2', 'octocat')).resolves.toEqual({
      login: null,
      reason: 'claimed-by-another-user',
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      data: { githubLogin: null },
      where: { id: 'user-2' },
    });
  });

  it('clears a login outright', async () => {
    const update = vi.fn().mockResolvedValue({});
    await clearGithubLogin(prismaWith(update), 'user-1');
    expect(update).toHaveBeenCalledWith({
      data: { githubLogin: null },
      where: { id: 'user-1' },
    });
  });

  it('propagates errors that are not a uniqueness collision', async () => {
    // A dead connection must not read as "this login is taken".
    const update = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }));
    await expect(storeGithubLogin(prismaWith(update), 'user-3', 'octocat')).rejects.toThrow('down');
  });
});

describe('syncGithubLoginForAccount', () => {
  it('resolves and stores in one step', async () => {
    mockFetch(() => json({ login: 'octocat' }));
    const update = vi.fn().mockResolvedValue({});
    await expect(
      syncGithubLoginForAccount(prismaWith(update), {
        accessToken: 'tok',
        apiUrl: API,
        userId: 'user-1',
      })
    ).resolves.toEqual({ login: 'octocat' });
  });

  it('does not call GitHub when the account stored no token', async () => {
    const spy = mockFetch(() => json({ login: 'octocat' }));
    const update = vi.fn();
    await expect(
      syncGithubLoginForAccount(prismaWith(update), {
        accessToken: null,
        apiUrl: API,
        userId: 'user-1',
      })
    ).resolves.toEqual({ login: null, reason: 'fetch-failed' });
    expect(spy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not write when GitHub returns no login', async () => {
    mockFetch(() => json({ message: 'Bad credentials' }, 401));
    const update = vi.fn();
    await expect(
      syncGithubLoginForAccount(prismaWith(update), {
        accessToken: 'tok',
        apiUrl: API,
        userId: 'user-1',
      })
    ).resolves.toEqual({ login: null, reason: 'no-login' });
    expect(update).not.toHaveBeenCalled();
  });
});
