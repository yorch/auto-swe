import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchRepo } from './launchAuthorization.js';

const decideRepoAccess = vi.fn();
vi.mock('@auto-swe/shared/lib/repoAccessDecision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessDecision')>()),
  decideRepoAccess: (...args: unknown[]) => decideRepoAccess(...args),
}));

const { authorizeLaunch } = await import('./launchAuthorization.js');

const USER = { role: 'ENGINEER' as const, sub: 'user-1' };
const GATE = { mode: 'enforce' as const, staleAfterHours: 24 };

const REPO: LaunchRepo = {
  githubApiUrl: null,
  id: 'repo-1',
  installation: null,
  organizationName: 'acme',
  repoName: 'api',
  shares: [],
  team: {
    memberships: [{ userId: USER.sub }],
    organization: { monthlyBudgetUsdCents: null },
    orgId: 'org-1',
  },
  type: 'git_repo',
};

// Org membership is read after the repository decision; this fake admits every user.
const prisma = {
  organizationMembership: { findUnique: vi.fn(async () => ({ role: 'ORG_MEMBER' })) },
  orgMonthlyUsage: { findUnique: vi.fn(async () => ({ costUsdAccrued: 0 })) },
};

beforeEach(() => {
  decideRepoAccess.mockReset();
  decideRepoAccess.mockResolvedValue({ allowed: true, reason: 'permitted' });
});

describe('authorizeLaunch — which identity the run acts as', () => {
  it('defaults to the platform identity, the login-based check', async () => {
    // Schedules and the Slack modal never say; they must not be judged by a
    // saved personal token the run will never use.
    await authorizeLaunch(prisma as never, USER, { gate: GATE, repos: [REPO] });
    expect(decideRepoAccess).toHaveBeenCalledWith(
      prisma,
      USER,
      REPO,
      GATE,
      undefined,
      'start-new-work',
      'platform'
    );
  });

  it("passes 'caller' through for a launch that records its launcher", async () => {
    await authorizeLaunch(prisma as never, USER, {
      gate: GATE,
      repos: [REPO],
      runIdentity: 'caller',
    });
    expect(decideRepoAccess).toHaveBeenCalledWith(
      prisma,
      USER,
      REPO,
      GATE,
      undefined,
      'start-new-work',
      'caller'
    );
  });

  it('applies one identity to every repository of a multi-repository launch', async () => {
    await authorizeLaunch(prisma as never, USER, {
      gate: GATE,
      repos: [REPO, { ...REPO, id: 'repo-2', repoName: 'web' }],
      runIdentity: 'caller',
    });
    expect(decideRepoAccess).toHaveBeenCalledTimes(2);
    for (const call of decideRepoAccess.mock.calls) {
      expect(call[6]).toBe('caller');
    }
  });
});
