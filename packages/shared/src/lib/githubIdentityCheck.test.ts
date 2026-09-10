import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import { fetchGithubUserId, verifyGithubLoginOwnership } from './githubIdentityCheck.js';

const API = 'https://api.github.com';

function stub(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
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

const findFirst = vi.fn();
const update = vi.fn();
const deleteMany = vi.fn();

function prisma(): PrismaClient {
  return {
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
    account: { findFirst },
    repoAccess: { deleteMany },
    user: { update },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 0 });
  findFirst.mockResolvedValue({ accountId: '4242' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchGithubUserId', () => {
  it('returns the numeric id as a string, matching how better-auth stores it', async () => {
    const spy = stub(() => json({ id: 4242, login: 'octocat' }));
    await expect(fetchGithubUserId('octocat', API, 'tok')).resolves.toBe('4242');
    expect(spy.mock.calls[0][0]).toBe('https://api.github.com/users/octocat');
  });

  it('URL-encodes the login', async () => {
    // The login is third-party data and must not escape its path segment.
    const spy = stub(() => json({ id: 1 }));
    await fetchGithubUserId('../../admin', API, 'tok');
    expect(spy.mock.calls[0][0]).toBe('https://api.github.com/users/..%2F..%2Fadmin');
  });

  it('tolerates a GHE api base with a trailing slash', async () => {
    const spy = stub(() => json({ id: 1 }));
    await fetchGithubUserId('octocat', 'https://ghe.example.com/api/v3/', 'tok');
    expect(spy.mock.calls[0][0]).toBe('https://ghe.example.com/api/v3/users/octocat');
  });

  it('returns null rather than throwing on any failure', async () => {
    stub(() => json({ message: 'Not Found' }, 404));
    await expect(fetchGithubUserId('gone', API, 'tok')).resolves.toBeNull();
    stub(() => Promise.reject(new Error('ETIMEDOUT')));
    await expect(fetchGithubUserId('octocat', API, 'tok')).resolves.toBeNull();
    stub(() => new Response('not json', { status: 200 }));
    await expect(fetchGithubUserId('octocat', API, 'tok')).resolves.toBeNull();
    stub(() => json({ login: 'octocat' }));
    await expect(fetchGithubUserId('octocat', API, 'tok')).resolves.toBeNull();
  });
});

describe('verifyGithubLoginOwnership', () => {
  const args = { apiUrl: API, login: 'octocat', token: 'tok', userId: 'user-1' };

  it('accepts a login that still resolves to the same account', async () => {
    stub(() => json({ id: 4242 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({ status: 'ok' });
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a plain rename, because the account id is unchanged', async () => {
    // GitHub redirects an old username to the same account, so a rename alone
    // is harmless and must not revoke anyone. Only re-registration is dangerous.
    stub(() => json({ id: 4242, login: 'octocat-renamed' }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({ status: 'ok' });
    expect(update).not.toHaveBeenCalled();
  });

  it('clears a login that now belongs to a different account', async () => {
    // The attack this exists for: the user renames, GitHub releases the old
    // name, someone else registers it, and the projection starts recording that
    // person's repository access as this user's.
    stub(() => json({ id: 9999 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({
      clearedLogin: 'octocat',
      status: 'reassigned',
    });
    expect(update).toHaveBeenCalledWith({
      data: { githubLogin: null },
      where: { id: 'user-1' },
    });
  });

  it('also drops the cached access the stolen login was backing', async () => {
    // Listing enforcement reads `repo_access` by user id, never through the
    // login, so clearing the login alone leaves the impostor's recorded
    // permissions serving this user for up to the staleness window — three days
    // by default. Detecting the takeover and then doing nothing about it.
    stub(() => json({ id: 9999 }));
    await verifyGithubLoginOwnership(prisma(), args);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('clears a login with no linked GitHub account behind it', async () => {
    // The unlink case. A login left behind backs repository access with nothing
    // standing behind it.
    findFirst.mockResolvedValue(null);
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toMatchObject({
      status: 'reassigned',
    });
    expect(update).toHaveBeenCalled();
  });

  it('changes nothing when GitHub cannot be asked', async () => {
    // An outage is not evidence that a name changed hands. Clearing on one
    // would revoke every unlucky user's access for a reason GitHub never gave —
    // the same rule the permission projection follows.
    stub(() => json({ message: 'Bad credentials' }, 401));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toMatchObject({
      status: 'unverifiable',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('compares as strings, so a numeric id is not mistaken for a mismatch', async () => {
    // GitHub returns a JSON number; better-auth stores a string. A loose
    // comparison here would clear every login on every sweep.
    findFirst.mockResolvedValue({ accountId: '0' });
    stub(() => json({ id: 0 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({ status: 'ok' });
  });
});
