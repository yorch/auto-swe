import type { PrismaClient } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('still requires membership on a non-git connection', async () => {
    await expect(
      decideRepoAccess(prisma, engineer, repo({ team: { memberships: [] }, type: 'mcp' }), ENFORCE)
    ).resolves.toEqual({ allowed: false, reason: 'not-a-team-member' });
  });
});

describe('error bodies', () => {
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

  it('escalates the code when any refusal is a gate refusal', () => {
    const body = multiRepoRefusalBody([
      { label: 'acme/alpha', reason: 'not-a-team-member' },
      { label: 'acme/beta', reason: 'insufficient-permission' },
    ]);
    expect(body.error.code).toBe('REPO_ACCESS_DENIED');
    expect(body.error.message).toContain('acme/alpha');
    expect(body.error.message).toContain('acme/beta');
  });
});
