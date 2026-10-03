import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import {
  type AccountTargets,
  accountTargets,
  fetchGithubUserId,
  parseAccountId,
  verifyGithubLoginOwnership,
} from './githubIdentityCheck.js';
import type { ResolvedGitHubConfig } from './systemConfig.js';

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

const findFirst = vi.fn(); // account.findMany
const update = vi.fn();
const deleteMany = vi.fn();
const auditCreate = vi.fn();

function prisma(): PrismaClient {
  return {
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
    account: { findMany: findFirst },
    configAuditLog: { create: auditCreate },
    repoAccess: { deleteMany },
    user: { update },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 0 });
  auditCreate.mockResolvedValue({});
  findFirst.mockResolvedValue([{ accountId: '4242' }]);
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
  // A real UUID: `config_audit_log.entity_id` is `@db.Uuid`, so a stub that
  // accepts 'user-1' would let a test pass on a call Postgres would reject.
  const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const fixed: AccountTargets = {
    forAccount: async () => ({ apiUrl: API, token: 'tok' }),
    unauthenticatedHosts: () => [],
  };
  const args = { login: 'octocat', targets: fixed, userId: USER_ID };

  it('accepts a login that still resolves to the same account', async () => {
    stub(() => json({ id: 4242 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({ status: 'ok' });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not check an account whose host has no credential to ask with, and clears nothing', async () => {
    // A GHE account id is `{host}:{id}`: that host's id space, not github.com's. Asking another
    // host would read as a mismatch and clear a valid login, plus write a false takeover audit row.
    findFirst.mockResolvedValue([{ accountId: 'ghe.example.com:42' }]);
    const spy = stub(() => json({ id: 42 }));
    const none: AccountTargets = { forAccount: async () => null, unauthenticatedHosts: () => [] };

    await expect(
      verifyGithubLoginOwnership(prisma(), { ...args, targets: none })
    ).resolves.toMatchObject({ status: 'unverifiable' });

    expect(spy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("compares a GitHub Enterprise account against the id after the host, at that host's API", async () => {
    findFirst.mockResolvedValue([{ accountId: 'ghe.example.com:42' }]);
    const spy = stub(() => json({ id: 42 }));
    const ghe: AccountTargets = {
      forAccount: async () => ({ apiUrl: 'https://ghe.example.com/api/v3', token: 'host-tok' }),
      unauthenticatedHosts: () => [],
    };
    await expect(verifyGithubLoginOwnership(prisma(), { ...args, targets: ghe })).resolves.toEqual({
      status: 'ok',
    });
    expect(spy.mock.calls[0][0]).toBe('https://ghe.example.com/api/v3/users/octocat');
    expect(spy.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer host-tok' });

    // A different owner there is a takeover, like on github.com.
    stub(() => json({ id: 7 }));
    await expect(
      verifyGithubLoginOwnership(prisma(), { ...args, targets: ghe })
    ).resolves.toMatchObject({ status: 'reassigned' });
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
      where: { id: USER_ID },
    });
  });

  it('also drops the cached access the stolen login was backing', async () => {
    // Listing enforcement reads `repo_access` by user id, never through the
    // login, so clearing the login alone leaves the impostor's recorded
    // permissions serving this user for up to the staleness window — three days
    // by default. Detecting the takeover and then doing nothing about it.
    stub(() => json({ id: 9999 }));
    await verifyGithubLoginOwnership(prisma(), args);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('records the takeover in the audit log, with both account ids', async () => {
    // A log line is gone by the time anyone asks. This is the one event in the
    // subsystem that says somebody's recorded identity was claimed by a
    // stranger, so it belongs somewhere durable and operator-facing.
    stub(() => json({ id: 9999 }));
    await verifyGithubLoginOwnership(prisma(), args);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({
      action: 'UPDATE',
      // The system acted, not a person.
      actorId: null,
      entityId: USER_ID,
      entityType: 'User',
    });
    expect(row.beforeJson).toEqual({ accountId: '4242', githubLogin: 'octocat' });
    expect(row.afterJson).toMatchObject({
      githubLogin: null,
      observedAccountId: '9999',
      reason: 'login-reassigned',
    });
  });

  it('records nothing when the login is still the user’s own', async () => {
    // Guards the test above: if it passed because `create` is simply always
    // called, this would fail.
    stub(() => json({ id: 4242 }));
    await verifyGithubLoginOwnership(prisma(), args);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('still clears when the audit write fails', async () => {
    // Losing the record is bad; leaving a hijacked login in place is worse.
    auditCreate.mockRejectedValue(new Error('audit table gone'));
    stub(() => json({ id: 9999 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toMatchObject({
      status: 'reassigned',
    });
    expect(update).toHaveBeenCalledWith({
      data: { githubLogin: null },
      where: { id: USER_ID },
    });
  });

  it('does not audit a benign unlink as a takeover', async () => {
    // `unlinked` and `reassigned` both clear, and only one of them is an
    // incident. Auditing both would make the log useless for finding the
    // incidents.
    findFirst.mockResolvedValue([]);
    await verifyGithubLoginOwnership(prisma(), args);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('clears a login with no linked account, and calls it unlinked, not a takeover', async () => {
    // A login left behind backs repository access with nothing standing behind
    // it, so clearing is right. Reporting it as `reassigned` would not be: the
    // caller raises a takeover alarm on that status, and an unlink whose hook
    // failed is benign.
    findFirst.mockResolvedValue([]);
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({
      clearedLogin: 'octocat',
      status: 'unlinked',
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
    findFirst.mockResolvedValue([{ accountId: '0' }]);
    stub(() => json({ id: 0 }));
    await expect(verifyGithubLoginOwnership(prisma(), args)).resolves.toEqual({ status: 'ok' });
  });
});

describe('verifyGithubLoginOwnership with several linked accounts', () => {
  it('leaves the login alone and writes no audit when it cannot be tied to one host', async () => {
    // A bare github.com id and a `{ghe}:{id}` id: the login came from one of
    // them, and comparing it with the other's id space would clear a valid login.
    findFirst.mockResolvedValue([{ accountId: '4242' }, { accountId: 'ghe.corp:7' }]);
    const spy = stub(() => json({ id: 7 }));
    const targets: AccountTargets = {
      forAccount: async () => ({ apiUrl: API, token: 'tok' }),
      unauthenticatedHosts: () => [],
    };
    await expect(
      verifyGithubLoginOwnership(prisma(), {
        login: 'octocat',
        targets,
        userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      })
    ).resolves.toMatchObject({ status: 'unverifiable' });
    expect(spy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('parseAccountId', () => {
  it('reads a bare id as github.com and splits `{host}:{id}` at the last colon', () => {
    expect(parseAccountId('4242')).toEqual({ host: 'github.com', id: '4242' });
    expect(parseAccountId('ghe.example.com:42')).toEqual({ host: 'ghe.example.com', id: '42' });
    expect(parseAccountId('ghe.corp:8443:42')).toEqual({ host: 'ghe.corp:8443', id: '42' });
  });
});

describe('accountTargets', () => {
  const config = (over: Partial<ResolvedGitHubConfig>): ResolvedGitHubConfig => ({
    apiUrl: 'https://api.github.com',
    appClientId: null,
    appClientSecret: null,
    appId: null,
    appInstallationId: null,
    appPrivateKey: null,
    authMode: null,
    baseUrl: 'https://github.com',
    oauthClientId: null,
    oauthClientSecret: null,
    token: null,
    webhookSecret: null,
    ...over,
  });
  const GHE = config({
    apiUrl: 'https://ghe.corp/api/v3',
    baseUrl: 'https://ghe.corp',
    token: 'ghe-pat',
  });
  const noInstallations = { gitHubInstallation: { findFirst: vi.fn().mockResolvedValue(null) } };
  const db = noInstallations as unknown as PrismaClient;
  const hostCreds = (rows: Record<string, { token: string | null }>) => async (host: string) =>
    rows[host] ? { appId: null, appPrivateKey: null, host, token: rows[host].token } : null;

  it("asks github.com with the instance's credential when the instance is github.com", async () => {
    const t = accountTargets(db, config({ token: 'dotcom-pat' }), hostCreds({}));
    await expect(t.forAccount('4242')).resolves.toEqual({ apiUrl: API, token: 'dotcom-pat' });
  });

  it('never sends a GitHub Enterprise instance credential to github.com', async () => {
    const t = accountTargets(db, GHE, hostCreds({}));
    // A bare id is github.com's: asked unauthenticated, and reported.
    await expect(t.forAccount('4242')).resolves.toEqual({ apiUrl: API, token: null });
    expect(t.unauthenticatedHosts()).toEqual(['github.com']);
  });

  it("uses the host's own credential for github.com when the instance is a GHE", async () => {
    const t = accountTargets(db, GHE, hostCreds({ 'github.com': { token: 'dotcom-host-pat' } }));
    await expect(t.forAccount('4242')).resolves.toEqual({ apiUrl: API, token: 'dotcom-host-pat' });
  });

  it("asks a GHE instance's own accounts at the instance with the instance credential", async () => {
    const t = accountTargets(db, GHE, hostCreds({}));
    await expect(t.forAccount('ghe.corp:42')).resolves.toEqual({
      apiUrl: 'https://ghe.corp/api/v3',
      token: 'ghe-pat',
    });
  });

  it("asks another host's accounts at that host with that host's credential, never the instance's", async () => {
    const t = accountTargets(db, GHE, hostCreds({ 'ghe.other': { token: 'other-pat' } }));
    await expect(t.forAccount('ghe.other:7')).resolves.toEqual({
      apiUrl: 'https://ghe.other/api/v3',
      token: 'other-pat',
    });
  });

  it('treats a host whose credentials cannot be loaded as unverifiable, and retries it next time', async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('cannot decrypt'))
      .mockResolvedValue({ appId: null, appPrivateKey: null, host: 'ghe.other', token: 'p' });
    const t = accountTargets(db, GHE, lookup);
    // Never throws, so one bad row cannot abort a sweep or a launch.
    await expect(t.forAccount('ghe.other:7')).resolves.toBeNull();
    // The failure was not cached.
    await expect(t.forAccount('ghe.other:8')).resolves.toMatchObject({ token: 'p' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('asks github.com unauthenticated when its credentials cannot be loaded', async () => {
    const t = accountTargets(db, GHE, async () => {
      throw new Error('db down');
    });
    await expect(t.forAccount('4242')).resolves.toEqual({ apiUrl: API, token: null });
  });

  it('does not ask a host with no credential at all', async () => {
    const t = accountTargets(db, GHE, hostCreds({}));
    await expect(t.forAccount('ghe.other:7')).resolves.toBeNull();
    expect(t.unauthenticatedHosts()).toEqual(['ghe.other']);
  });
});
