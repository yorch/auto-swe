/**
 * Who may plan on a repository: the real launch decision (`validateRunConnection` and
 * `decideRepoAccess`) against a fake Prisma, with the platform role read from the database.
 * `runPlanService.test.ts` mocks the decision; here nothing of it is mocked, so the platform
 * ADMIN bypass is exercised exactly as every other launch path gets it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
}));

import { authorizeRepository, requireActivePlanUser } from './runPlanService.js';

const USER = 'user-1';
const REPO = 'repo-1';

const NO_ACCESS = 'You do not have access to this repository.';
const NOT_ACTIVE = 'Only an active user can use run plans';

interface Opts {
  role: 'ADMIN' | 'USER';
  userRow?: 'missing';
  userActive?: boolean;
  memberOfOwningTeam?: boolean;
  isActive?: boolean;
  installationRetired?: boolean;
  /** Whether the user belongs to the repository's organization. */
  orgMember?: boolean;
}

function fakePrisma(opts: Opts) {
  const row = {
    githubApiUrl: null,
    githubUrl: null,
    id: REPO,
    installation: opts.installationRetired
      ? { host: '', installationId: 7, isActive: false }
      : null,
    isActive: opts.isActive ?? true,
    organizationName: 'acme',
    repoName: 'payments',
    scmProvider: 'github',
    shares: [],
    team: {
      id: 'team-1',
      memberships: opts.memberOfOwningTeam ? [{ userId: USER }] : [],
      monthlyBudgetUsdCents: null,
      name: 'Payments',
      organization: { id: 'org-1', monthlyBudgetUsdCents: null },
      orgId: 'org-1',
    },
    teamId: 'team-1',
    type: 'git_repo',
  };
  return {
    connection: { findUnique: vi.fn(async () => row) },
    organizationMembership: {
      findUnique: vi.fn(async () => (opts.orgMember === false ? null : { role: 'MEMBER' })),
    },
    user: {
      findUnique: vi.fn(async () =>
        opts.userRow === 'missing'
          ? null
          : { id: USER, isActive: opts.userActive ?? true, role: opts.role }
      ),
    },
  };
}

const authorize = (opts: Opts) =>
  authorizeRepository({ prisma: fakePrisma(opts) as never }, { sub: USER }, REPO);

describe('authorizeRepository: the platform role is the database role', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets an ADMIN who is not a team member plan on the repository', async () => {
    // Outside both the owning team and the organization: the live case.
    expect(await authorize({ orgMember: false, role: 'ADMIN' })).toMatchObject({ ok: true });
  });

  it('lets an ADMIN who is also a member of the owning team plan', async () => {
    expect(await authorize({ memberOfOwningTeam: true, role: 'ADMIN' })).toMatchObject({
      ok: true,
    });
  });

  it('still refuses a USER who is not a member', async () => {
    expect(await authorize({ role: 'USER' })).toMatchObject({
      code: 'FORBIDDEN',
      message: NO_ACCESS,
      ok: false,
      status: 403,
    });
  });

  it('lets a USER who belongs to the owning team plan', async () => {
    expect(await authorize({ memberOfOwningTeam: true, role: 'USER' })).toMatchObject({
      ok: true,
    });
  });

  it('refuses an inactive ADMIN at the active-user check, not the repository check', async () => {
    expect(await authorize({ role: 'ADMIN', userActive: false })).toMatchObject({
      code: 'FORBIDDEN',
      message: NOT_ACTIVE,
      ok: false,
    });
  });

  it('refuses a user row that is gone', async () => {
    expect(await authorize({ role: 'ADMIN', userRow: 'missing' })).toMatchObject({
      code: 'FORBIDDEN',
      message: NOT_ACTIVE,
      ok: false,
    });
  });

  it('refuses an ADMIN for an inactive repository', async () => {
    expect(await authorize({ isActive: false, role: 'ADMIN' })).toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      ok: false,
      status: 404,
    });
  });

  it('refuses an ADMIN for a repository behind a retired installation', async () => {
    expect(await authorize({ installationRetired: true, role: 'ADMIN' })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('requireActivePlanUser', () => {
  it.each(['ADMIN', 'USER'] as const)('returns the stored %s role', async (role) => {
    const prisma = fakePrisma({ role });
    expect(await requireActivePlanUser({ prisma: prisma as never }, { sub: USER })).toEqual({
      ok: true,
      role,
    });
  });

  it('refuses an inactive user and a missing row', async () => {
    for (const opts of [
      { role: 'USER', userActive: false } as const,
      { role: 'USER', userRow: 'missing' } as const,
    ]) {
      expect(
        await requireActivePlanUser({ prisma: fakePrisma(opts) as never }, { sub: USER })
      ).toMatchObject({ code: 'FORBIDDEN', message: NOT_ACTIVE, ok: false });
    }
  });
});
