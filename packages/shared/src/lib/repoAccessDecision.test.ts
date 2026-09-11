import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';

const decideRepoLaunch = vi.fn();

vi.mock('./repoAccessGate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repoAccessGate.js')>()),
  decideRepoLaunch: (...a: unknown[]) => decideRepoLaunch(...a),
}));

const { decideRepoAccess, multiRepoRefusalBody, repoAccessErrorBody } = await import(
  './repoAccessDecision.js'
);

const prisma = {} as PrismaClient;
const engineer = { exp: 0, iat: 0, role: 'ENGINEER' as const, sub: 'user-1' };
const admin = { ...engineer, role: 'ADMIN' as const, sub: 'user-admin' };
const ENFORCE = { mode: 'enforce' as const, staleAfterHours: 72 };
const OFF = { mode: 'off' as const, staleAfterHours: 72 };

function repo(over: Record<string, unknown> = {}) {
  return {
    githubApiUrl: null,
    id: 'conn-1',
    installation: null,
    organizationName: 'acme',
    repoName: 'payments',
    team: { memberships: [{ userId: 'user-1' }] },
    type: 'git_repo',
    ...over,
  };
}

const RETIRED = { installationId: '900001', isActive: false };
const LIVE = { installationId: '900001', isActive: true };

beforeEach(() => {
  vi.clearAllMocks();
  decideRepoLaunch.mockResolvedValue({ allowed: true, reason: 'permitted' });
});

describe('decideRepoAccess', () => {
  it('refuses a non-member without asking GitHub', async () => {
    // Membership first, so someone outside the team is told exactly that rather
    // than being sent to link a GitHub account that would not help them.
    await expect(
      decideRepoAccess(prisma, engineer, repo({ team: { memberships: [] } }), ENFORCE)
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
    expect(decideRepoLaunch).not.toHaveBeenCalled();
  });

  it('still refuses a non-member when the gate is off', async () => {
    // GitHub can only ever take access away, so membership stays the outer
    // bound however the gate is configured. Putting the membership test inside
    // the gate's mode switch would open every repository the moment an operator
    // turned the gate off.
    await expect(
      decideRepoAccess(prisma, engineer, repo({ team: { memberships: [] } }), OFF)
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
  });

  it('ignores a membership belonging to somebody else', async () => {
    // The query is expected to filter to the acting user, but a call site that
    // forgets must not turn "someone is a member" into "you are".
    await expect(
      decideRepoAccess(
        prisma,
        engineer,
        repo({ team: { memberships: [{ userId: 'someone-else' }] } }),
        ENFORCE
      )
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
  });

  it('consults GitHub once membership holds', async () => {
    decideRepoLaunch.mockResolvedValue({ allowed: false, reason: 'insufficient-permission' });
    await expect(decideRepoAccess(prisma, engineer, repo(), ENFORCE)).resolves.toEqual({
      allowed: false,
      reason: 'insufficient-permission',
    });
    expect(decideRepoLaunch).toHaveBeenCalledTimes(1);
  });

  it('lets a platform admin past both halves', async () => {
    await expect(
      decideRepoAccess(prisma, admin, repo({ team: { memberships: [] } }), ENFORCE)
    ).resolves.toEqual({ allowed: true, reason: 'admin' });
    expect(decideRepoLaunch).not.toHaveBeenCalled();
  });

  it('refuses new work through a retired installation', async () => {
    // Retiring is an operator statement about what starts next. Refusing here
    // gives the flag meaning without touching the paths that keep running work
    // alive.
    await expect(
      decideRepoAccess(prisma, engineer, repo({ installation: RETIRED }), ENFORCE)
    ).resolves.toEqual({ allowed: false, reason: 'installation-retired' });
    expect(decideRepoLaunch).not.toHaveBeenCalled();
  });

  it('refuses through a retired installation even with the gate off', async () => {
    // The flag is operator configuration, not part of the GitHub gate, so it
    // must not switch off with it.
    await expect(
      decideRepoAccess(prisma, engineer, repo({ installation: RETIRED }), OFF)
    ).resolves.toEqual({ allowed: false, reason: 'installation-retired' });
  });

  it('allows a live installation through to the GitHub check', async () => {
    // The discriminating case: if the retired test passed because ANY
    // installation refused, this would fail.
    await expect(
      decideRepoAccess(prisma, engineer, repo({ installation: LIVE }), ENFORCE)
    ).resolves.toEqual({ allowed: true, reason: 'permitted' });
    expect(decideRepoLaunch).toHaveBeenCalledTimes(1);
  });

  it('tells a non-member they are not a member, not that the installation is retired', async () => {
    // Membership is still decided first: someone outside the team gets the
    // answer that is actionable for them.
    await expect(
      decideRepoAccess(
        prisma,
        engineer,
        repo({ installation: RETIRED, team: { memberships: [] } }),
        ENFORCE
      )
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
  });

  it('subjects a platform admin to a retired installation too', async () => {
    // Retirement is operator configuration, not a statement about the person
    // asking, so the admin bypass does not reach it. An admin who retired an
    // installation and then launched through it anyway would get GitHub's
    // failure instead of ours, which is a worse way to learn the same thing.
    await expect(
      decideRepoAccess(prisma, admin, repo({ installation: RETIRED }), ENFORCE)
    ).resolves.toEqual({ allowed: false, reason: 'installation-retired' });
  });

  it('still lets a platform admin past everything else', async () => {
    // The discriminating case: the admin bypass is narrowed, not removed.
    await expect(
      decideRepoAccess(
        prisma,
        admin,
        repo({ installation: LIVE, team: { memberships: [] } }),
        ENFORCE
      )
    ).resolves.toEqual({ allowed: true, reason: 'admin' });
  });

  it('exempts non-git connections from the GitHub half', async () => {
    // An MCP server or an HTTP API has no GitHub permission to ask about, and
    // asking anyway answers `repo-not-found`, which fails closed — so without
    // this an api_only template run would be refused for a reason that cannot
    // apply to it.
    for (const type of ['mcp', 'http_api', 'notion']) {
      await expect(
        decideRepoAccess(
          prisma,
          engineer,
          repo({ organizationName: null, repoName: null, type }),
          ENFORCE
        )
      ).resolves.toEqual({ allowed: true, reason: 'permitted' });
    }
    expect(decideRepoLaunch).not.toHaveBeenCalled();
  });

  it('exempts a connection with no coordinates even when its installation is retired', async () => {
    // The coordinates exemption is checked after the retired one, so this is
    // the documented order rather than an accident: a row with an installation
    // but no org/repo has nothing to clone, and nothing to refuse about. Only
    // an ADMIN can attach an installation, so reaching this at all is a
    // misconfiguration rather than an attack.
    await expect(
      decideRepoAccess(
        prisma,
        engineer,
        repo({ installation: RETIRED, organizationName: null, repoName: null }),
        ENFORCE
      )
    ).resolves.toEqual({ allowed: false, reason: 'installation-retired' });
  });

  it('still requires membership on a non-git connection', async () => {
    await expect(
      decideRepoAccess(prisma, engineer, repo({ team: { memberships: [] }, type: 'mcp' }), ENFORCE)
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
  });
});

describe('error bodies', () => {
  it('gives a retired installation its own code, not an access-denied one', () => {
    // It is an operator-configuration problem, not a statement about this user;
    // a client should be able to tell them apart.
    expect(repoAccessErrorBody('installation-retired').error.code).toBe('INSTALLATION_RETIRED');
  });

  it('keeps INSTALLATION_RETIRED on the multi-repo routes too', () => {
    // Epics and PRD runs answered REPO_ACCESS_DENIED for a retired
    // installation, which is the exact conflation the single-repo helper exists
    // to avoid. Only the single-repo path was tested, so nothing caught it.
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'installation-retired' },
      { label: 'acme/beta', reason: 'insufficient-permission' },
    ]);
    expect(body.error.code).toBe('INSTALLATION_RETIRED');
  });

  it('lets a membership refusal outrank a retired one', () => {
    // The pre-existing contract: any membership failure among the named
    // repositories answers FORBIDDEN, whatever else is wrong.
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'installation-retired' },
      { label: 'acme/beta', reason: 'not-a-team-member' },
    ]);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('keeps FORBIDDEN for a membership refusal', async () => {
    // The code these routes returned before the gate existed. A client handling
    // it should not start seeing a new code for a case whose meaning has not
    // changed.
    expect(repoAccessErrorBody('not-a-team-member').error.code).toBe('FORBIDDEN');
  });

  it('uses REPO_ACCESS_DENIED only for the genuinely new refusals', () => {
    for (const reason of [
      'insufficient-permission',
      'lookup-unavailable',
      'no-github-identity',
    ] as const) {
      expect(repoAccessErrorBody(reason).error.code).toBe('REPO_ACCESS_DENIED');
    }
  });

  it('names every refused repository, not just the first', () => {
    // A caller naming five repositories should fix them in one pass.
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'not-a-team-member' },
      { label: 'acme/beta', reason: 'not-a-team-member' },
    ]);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toContain('acme/alpha');
    expect(body.error.message).toContain('acme/beta');
  });

  it('keeps FORBIDDEN when a membership refusal is mixed with a gate refusal', () => {
    // Before the gate existed these routes ran the membership check to
    // completion and answered FORBIDDEN if any named repository failed it,
    // whatever else was wrong. A caller who is not a member of one repository
    // and lacks GitHub write on another saw FORBIDDEN then, so they must see it
    // now — requiring unanimity would change the code for a case whose
    // membership half has not changed meaning.
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'not-a-team-member' },
      { label: 'acme/beta', reason: 'insufficient-permission' },
    ]);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toContain('acme/alpha');
    expect(body.error.message).toContain('acme/beta');
  });

  it('uses REPO_ACCESS_DENIED when no refusal is a membership one', () => {
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'no-github-identity' },
      { label: 'acme/beta', reason: 'insufficient-permission' },
    ]);
    expect(body.error.code).toBe('REPO_ACCESS_DENIED');
  });

  it('carries the machine-readable reasons, which the message loses', () => {
    // The single-repo helper emits `reason`; without this the two shapes
    // disagree about whether a client can tell "link your GitHub account" from
    // "insufficient permission".
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'no-github-identity' },
      { label: 'acme/beta', reason: 'insufficient-permission' },
    ]);
    expect(body.error.reasons).toEqual([
      { reason: 'no-github-identity', repo: 'acme/alpha' },
      { reason: 'insufficient-permission', repo: 'acme/beta' },
    ]);
  });
});
