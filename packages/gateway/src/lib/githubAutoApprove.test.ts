import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AutoApproveDeps,
  autoApproveGithubUser,
  fetchOrgMembership,
} from './githubAutoApprove.js';

const API = 'https://api.github.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchOrgMembership', () => {
  const ask = () =>
    fetchOrgMembership({ apiUrl: `${API}/`, login: 'octocat', org: 'acme', token: 'tok' });

  it('reads 204 as a member and asks the instance API with the credential', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    await expect(ask()).resolves.toBe('member');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/orgs/acme/members/octocat');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.redirect).toBe('manual');
  });

  it('reads 404 as not a member', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(ask()).resolves.toBe('not-member');
  });

  it.each([302, 401, 403, 429, 500])(
    'treats %i as could-not-ask, never a verdict',
    async (status) => {
      vi.stubGlobal('fetch', async () => new Response(null, { status }));
      await expect(ask()).resolves.toBe('unavailable');
    }
  );

  it('treats a network failure as could-not-ask', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    await expect(ask()).resolves.toBe('unavailable');
  });
});

interface Row {
  approvedAt: Date | null;
  emailVerified: boolean;
  githubLogin: string | null;
  isActive: boolean;
}

function harness(opts: { row?: Row | null; accounts?: number; updated?: number }) {
  const row: Row | null =
    opts.row === undefined
      ? { approvedAt: null, emailVerified: true, githubLogin: 'octocat', isActive: false }
      : opts.row;
  const updateMany = vi.fn(async () => ({ count: opts.updated ?? 1 }));
  const audit = vi.fn(async (_args: unknown) => ({}));
  const tx = { configAuditLog: { create: audit }, user: { updateMany } };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<boolean>) => fn(tx),
    account: { count: async () => opts.accounts ?? 1 },
    user: { findUnique: async () => row },
  } as unknown as PrismaClient;
  return { audit, prisma, updateMany };
}

function deps(over: Partial<AutoApproveDeps> = {}): AutoApproveDeps {
  return {
    credential: async () => ({ apiUrl: API, token: 'tok' }),
    membership: vi.fn(async () => 'member' as const),
    now: () => new Date('2026-01-01T00:00:00Z'),
    orgs: async () => ['acme'],
    ...over,
  };
}

describe('autoApproveGithubUser', () => {
  it('approves a pending sole-account member, stamps the source and audits it', async () => {
    const h = harness({});
    const outcome = await autoApproveGithubUser(h.prisma, 'u1', deps());
    expect(outcome).toEqual({ approved: true, org: 'acme' });
    expect(h.updateMany).toHaveBeenCalledWith({
      data: {
        approvalSource: 'github-org:acme',
        approvedAt: new Date('2026-01-01T00:00:00Z'),
        isActive: true,
      },
      where: { approvedAt: null, id: 'u1', isActive: false },
    });
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({ data: { actorId: null, entityId: 'u1' } });
  });

  it('does nothing when the org list is empty, without asking GitHub', async () => {
    const h = harness({});
    const membership = vi.fn(async () => 'member' as const);
    const outcome = await autoApproveGithubUser(
      h.prisma,
      'u1',
      deps({ membership, orgs: async () => [] })
    );
    expect(outcome).toEqual({ approved: false, reason: 'disabled' });
    expect(membership).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('never re-approves a deactivated account (approvedAt set)', async () => {
    const h = harness({
      row: {
        approvedAt: new Date('2025-01-01'),
        emailVerified: true,
        githubLogin: 'octocat',
        isActive: false,
      },
    });
    const outcome = await autoApproveGithubUser(h.prisma, 'u1', deps());
    expect(outcome).toEqual({ approved: false, reason: 'not-pending' });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('leaves an already-active user alone', async () => {
    const h = harness({
      row: { approvedAt: null, emailVerified: true, githubLogin: 'octocat', isActive: true },
    });
    await expect(autoApproveGithubUser(h.prisma, 'u1', deps())).resolves.toEqual({
      approved: false,
      reason: 'not-pending',
    });
  });

  it('does not approve a user who already signs in another way', async () => {
    const h = harness({ accounts: 2 });
    await expect(autoApproveGithubUser(h.prisma, 'u1', deps())).resolves.toEqual({
      approved: false,
      reason: 'not-sole-account',
    });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('requires a verified email and a recorded GitHub login', async () => {
    const unverified = harness({
      row: { approvedAt: null, emailVerified: false, githubLogin: 'octocat', isActive: false },
    });
    await expect(autoApproveGithubUser(unverified.prisma, 'u1', deps())).resolves.toEqual({
      approved: false,
      reason: 'email-unverified',
    });
    const noLogin = harness({
      row: { approvedAt: null, emailVerified: true, githubLogin: null, isActive: false },
    });
    await expect(autoApproveGithubUser(noLogin.prisma, 'u1', deps())).resolves.toEqual({
      approved: false,
      reason: 'no-login',
    });
  });

  it('stays pending without a usable platform credential', async () => {
    const h = harness({});
    const outcome = await autoApproveGithubUser(
      h.prisma,
      'u1',
      deps({ credential: async () => null })
    );
    expect(outcome).toEqual({ approved: false, reason: 'no-credential' });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('stays pending when GitHub cannot be asked, and distinguishes a real "no"', async () => {
    const down = harness({});
    await expect(
      autoApproveGithubUser(down.prisma, 'u1', deps({ membership: async () => 'unavailable' }))
    ).resolves.toEqual({ approved: false, reason: 'unavailable' });
    const no = harness({});
    await expect(
      autoApproveGithubUser(no.prisma, 'u1', deps({ membership: async () => 'not-member' }))
    ).resolves.toEqual({ approved: false, reason: 'not-member' });
    expect(down.updateMany).not.toHaveBeenCalled();
    expect(no.updateMany).not.toHaveBeenCalled();
  });

  it('tries each listed org and approves on the first that matches', async () => {
    const h = harness({});
    const membership = vi.fn(async ({ org }: { org: string }) =>
      org === 'beta' ? ('member' as const) : ('not-member' as const)
    );
    const outcome = await autoApproveGithubUser(
      h.prisma,
      'u1',
      deps({ membership, orgs: async () => ['acme', 'beta', 'gamma'] })
    );
    expect(outcome).toEqual({ approved: true, org: 'beta' });
    expect(membership).toHaveBeenCalledTimes(2);
  });

  it('reports a lost race instead of double-approving or auditing', async () => {
    const h = harness({ updated: 0 });
    await expect(autoApproveGithubUser(h.prisma, 'u1', deps())).resolves.toEqual({
      approved: false,
      reason: 'raced',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
