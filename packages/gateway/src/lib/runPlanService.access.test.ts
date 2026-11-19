/**
 * Who may plan on a repository: the real launch decision, with the platform role read from the
 * database. `runPlanService.test.ts` mocks the decision; here nothing of it is mocked, so the
 * platform ADMIN bypass is exercised exactly as every other launch path gets it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
}));

import { authorizeRepository } from './runPlanService.js';

const USER = 'user-1';
const REPO = 'repo-1';

const NO_ACCESS = 'You do not have access to this repository.';

interface Opts {
  role: string;
  userRow?: 'missing';
  userActive?: boolean;
  memberOfOwningTeam?: boolean;
  isActive?: boolean;
  installationRetired?: boolean;
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
    organizationMembership: { findUnique: vi.fn(async () => ({ role: 'MEMBER' })) },
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
    expect(await authorize({ role: 'ADMIN' })).toMatchObject({ ok: true });
  });

  it('still refuses an ENGINEER who is not a member', async () => {
    expect(await authorize({ role: 'ENGINEER' })).toMatchObject({
      code: 'FORBIDDEN',
      message: NO_ACCESS,
      ok: false,
      status: 403,
    });
  });

  it('still refuses a LEAD who is not a member', async () => {
    expect(await authorize({ role: 'LEAD' })).toMatchObject({
      code: 'FORBIDDEN',
      message: NO_ACCESS,
      ok: false,
    });
  });

  it('lets an ENGINEER who belongs to the owning team plan', async () => {
    expect(await authorize({ memberOfOwningTeam: true, role: 'ENGINEER' })).toMatchObject({
      ok: true,
    });
  });

  it('lets an ADMIN who is also a member of the owning team plan', async () => {
    expect(await authorize({ memberOfOwningTeam: true, role: 'ADMIN' })).toMatchObject({
      ok: true,
    });
  });

  it('refuses an inactive ADMIN user at the role check, not the repository check', async () => {
    const result = await authorize({ role: 'ADMIN', userActive: false });
    expect(result).toMatchObject({ code: 'FORBIDDEN', ok: false });
    expect(result).toMatchObject({ message: 'Only an active user can use run plans' });
  });

  it('refuses a user row that is gone', async () => {
    expect(await authorize({ role: 'ADMIN', userRow: 'missing' })).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only an active user can use run plans',
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
