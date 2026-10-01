import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';

const lookupRepoPermission = vi.fn();
const lookupPermissionViaUserCredential = vi.fn();
const githubLoginFor = vi.fn();
const recordRepoPermission = vi.fn();

vi.mock('./repoPermission.js', () => ({
  githubLoginFor: (...a: unknown[]) => githubLoginFor(...a),
  lookupPermissionViaUserCredential: (...a: unknown[]) => lookupPermissionViaUserCredential(...a),
  lookupRepoPermission: (...a: unknown[]) => lookupRepoPermission(...a),
  // The launch path resolves a VERIFIED login now: reading the stored one was
  // enough for the sweep to be the only writer that checks ownership, which
  // meant this path kept re-populating rows under a re-registered login.
  verifiedGithubLoginFor: (...a: unknown[]) => githubLoginFor(...a),
}));

vi.mock('@auto-swe/shared/lib/repoAccessProjection', () => ({
  recordRepoPermission: (...a: unknown[]) => recordRepoPermission(...a),
}));

const { decideRepoLaunch } = await import('./repoAccessGate.js');

const prisma = {} as PrismaClient;
const REPO = {
  githubApiUrl: null,
  id: 'conn-1',
  installation: null,
  organizationName: 'acme',
  repoName: 'payments',
};
const engineer = { exp: 0, iat: 0, role: 'ENGINEER' as const, sub: 'user-1' };
const admin = { ...engineer, role: 'ADMIN' as const, sub: 'user-admin' };
const log = { warn: vi.fn() } as never;

const ENFORCE = { mode: 'enforce' as const, staleAfterHours: 72 };
const ADVISORY = { mode: 'advisory' as const, staleAfterHours: 72 };
const OFF = { mode: 'off' as const, staleAfterHours: 72 };

beforeEach(() => {
  vi.clearAllMocks();
  githubLoginFor.mockResolvedValue('octocat');
  recordRepoPermission.mockResolvedValue({ written: true });
  // No saved credential unless a test says otherwise.
  lookupPermissionViaUserCredential.mockResolvedValue(null);
});

describe('decideRepoLaunch for a run that acts as the platform', () => {
  it('never consults a saved token, by default', async () => {
    // A Slack or scheduled launch uses the platform credential whatever the
    // caller saved. Judging it by their token would refuse for a token the run
    // never touches, or admit someone on an identity the run does not act as.
    lookupPermissionViaUserCredential.mockResolvedValue({
      failure: 'credential-rejected',
      ok: false,
    });
    lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log)).resolves.toEqual({
      allowed: true,
      reason: 'permitted',
    });
    expect(lookupPermissionViaUserCredential).not.toHaveBeenCalled();
    expect(lookupRepoPermission).toHaveBeenCalledWith(REPO, 'octocat');
  });
});

describe('decideRepoLaunch with a saved user credential', () => {
  it("decides on the user's own token and never needs a login", async () => {
    lookupPermissionViaUserCredential.mockResolvedValue({ ok: true, permission: 'write' });
    githubLoginFor.mockResolvedValue(null);
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log, 'caller')).resolves.toEqual(
      {
        allowed: true,
        reason: 'permitted',
      }
    );
    expect(lookupPermissionViaUserCredential).toHaveBeenCalledWith(prisma, REPO, 'user-1');
    expect(githubLoginFor).not.toHaveBeenCalled();
    expect(lookupRepoPermission).not.toHaveBeenCalled();
    expect(recordRepoPermission).toHaveBeenCalledWith(prisma, {
      connectionId: 'conn-1',
      lookup: { ok: true, permission: 'write' },
      userId: 'user-1',
    });
  });

  it('refuses read access through the token as it would through the login', async () => {
    lookupPermissionViaUserCredential.mockResolvedValue({ ok: true, permission: 'read' });
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log, 'caller')).resolves.toEqual(
      {
        allowed: false,
        reason: 'insufficient-permission',
      }
    );
  });

  it('says the token is the problem when GitHub rejects it or it cannot see the repo', async () => {
    for (const failure of ['credential-rejected', 'repo-not-found'] as const) {
      lookupPermissionViaUserCredential.mockResolvedValue({ failure, ok: false });
      await expect(
        decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log, 'caller')
      ).resolves.toEqual({
        allowed: false,
        reason: 'user-credential-rejected',
      });
    }
    // Not a silent fallback to the login: the run would use this token and fail.
    expect(lookupRepoPermission).not.toHaveBeenCalled();
  });

  it('fails closed, retryably, when GitHub could not be asked', async () => {
    lookupPermissionViaUserCredential.mockResolvedValue({ failure: 'rate-limited', ok: false });
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log, 'caller')).resolves.toEqual(
      {
        allowed: false,
        reason: 'lookup-unavailable',
      }
    );
  });

  it('falls back to the login when no credential is usable', async () => {
    lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log, 'caller')).resolves.toEqual(
      {
        allowed: true,
        reason: 'permitted',
      }
    );
    expect(lookupRepoPermission).toHaveBeenCalledWith(REPO, 'octocat');
  });
});

describe('decideRepoLaunch', () => {
  it('asks nothing at all when the gate is off', async () => {
    await expect(decideRepoLaunch(prisma, engineer, REPO, OFF, log)).resolves.toEqual({
      allowed: true,
      reason: 'gate-off',
    });
    expect(githubLoginFor).not.toHaveBeenCalled();
    expect(lookupRepoPermission).not.toHaveBeenCalled();
  });

  it('lets a platform admin through without a lookup', async () => {
    await expect(decideRepoLaunch(prisma, admin, REPO, ENFORCE, log)).resolves.toEqual({
      allowed: true,
      reason: 'admin',
    });
    expect(lookupRepoPermission).not.toHaveBeenCalled();
  });

  it('allows write and admin, refuses read and none', async () => {
    // Starting a run pushes a branch and opens a pull request, so read access
    // is not enough to launch even though it is enough to look.
    for (const [permission, allowed] of [
      ['admin', true],
      ['write', true],
      ['read', false],
      ['none', false],
    ] as const) {
      lookupRepoPermission.mockResolvedValue({ ok: true, permission });
      const decision = await decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log);
      expect(decision.allowed, permission).toBe(allowed);
      if (!decision.allowed) {
        expect(decision.reason).toBe('insufficient-permission');
      }
    }
  });

  it('fails closed when the lookup cannot be made', async () => {
    // An unanswered question is not a yes. Safe here because the failure is
    // loud, immediate and retryable by the person in front of it.
    for (const failure of [
      'unavailable',
      'rate-limited',
      'credential-rejected',
      'repo-not-found',
    ]) {
      lookupRepoPermission.mockResolvedValue({ failure, ok: false });
      await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log)).resolves.toEqual({
        allowed: false,
        reason: 'lookup-unavailable',
      });
    }
  });

  it('refuses a user whose login is missing or no longer theirs', async () => {
    // `verifiedGithubLoginFor` returns null for both, having already cleared a
    // login that turned out to name somebody else. The launch path cannot tell
    // them apart and does not need to: neither is an identity to ask about.
    githubLoginFor.mockResolvedValue(null);
    await expect(decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log)).resolves.toEqual({
      allowed: false,
      reason: 'no-github-identity',
    });
    expect(lookupRepoPermission).not.toHaveBeenCalled();
  });

  it('records the answer so listings benefit from the live lookup', async () => {
    lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
    await decideRepoLaunch(prisma, engineer, REPO, ENFORCE, log);
    expect(recordRepoPermission).toHaveBeenCalledWith(prisma, {
      connectionId: 'conn-1',
      lookup: { ok: true, permission: 'write' },
      userId: 'user-1',
    });
  });

  it('allows and logs in advisory mode what enforcement would refuse', async () => {
    lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'none' });
    const warn = vi.fn();
    await expect(
      decideRepoLaunch(prisma, engineer, REPO, ADVISORY, { warn } as never)
    ).resolves.toEqual({ allowed: true, reason: 'advisory-would-refuse' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      connectionId: 'conn-1',
      refusal: 'insufficient-permission',
      userId: 'user-1',
    });
  });

  it('logs nothing in advisory mode when the launch would be permitted', async () => {
    lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
    const warn = vi.fn();
    await decideRepoLaunch(prisma, engineer, REPO, ADVISORY, { warn } as never);
    expect(warn).not.toHaveBeenCalled();
  });
});
