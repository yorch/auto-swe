import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { teamRoutes } from './teams.js';

/**
 * Tiny in-memory harness covering just the two endpoints these tests target:
 *   - DELETE /api/v1/teams/:id/members/:userId
 *   - PUT    /api/v1/teams/:id/shell-image-allowlist
 *
 * Both are gated behind `requireAuth({ requiredRole: 'LEAD', requiredTeamRole: 'LEAD' })`,
 * so the harness has to provide:
 *   - a fake JWT verifier (state.userRole drives the payload),
 *   - team.findUnique (read for the allowlist endpoint + RBAC team lookup),
 *   - teamMembership.{findUnique, delete} (RBAC + the route's own DB ops).
 *
 * Platform ADMIN bypasses team-role checks (see auth.ts:328), so the test
 * relies on returning userRole='LEAD' + a matching teamMembership row.
 */
interface MembershipRow {
  id: string;
  userId: string;
  teamId: string;
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
}

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  shellImageAllowlist: string[];
  egressAllowlist: string[];
}

interface State {
  userRole: 'ADMIN' | 'LEAD' | 'ENGINEER';
  /** sub claim on the fake JWT — must match a membership row to pass team RBAC. */
  userId: string;
  teams: TeamRow[];
  memberships: MembershipRow[];
}

const TEAM_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TARGET_USER_ID = '00000000-0000-4000-8000-0000000000bb';

function freshState(overrides?: Partial<State>): State {
  return {
    memberships: [
      // The caller (LEAD in this team) — needed to pass requiredTeamRole
      {
        id: 'm-caller',
        role: 'LEAD',
        teamId: TEAM_ID,
        userId: ADMIN_USER_ID,
      },
      // The target member to remove
      {
        id: 'm-target',
        role: 'ENGINEER',
        teamId: TEAM_ID,
        userId: TARGET_USER_ID,
      },
    ],
    teams: [
      {
        egressAllowlist: [],
        id: TEAM_ID,
        name: 'platform',
        shellImageAllowlist: [],
        slug: 'platform',
      },
    ],
    userId: ADMIN_USER_ID,
    userRole: 'LEAD',
    ...overrides,
  };
}

function buildApp(state: State): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9_999_999_999,
      iat: 0,
      role: state.userRole,
      sub: state.userId,
    }),
  } as unknown as never);

  app.decorate('prisma', {
    team: {
      findUnique: async ({ where }: { where: { id?: string; slug?: string } }) => {
        return (
          state.teams.find((t) => (where.id ? t.id === where.id : t.slug === where.slug)) ?? null
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { shellImageAllowlist?: string[]; egressAllowlist?: string[] };
      }) => {
        const row = state.teams.find((t) => t.id === where.id);
        if (!row) throw new Error('team not found');
        if (data.shellImageAllowlist !== undefined) {
          row.shellImageAllowlist = data.shellImageAllowlist;
        }
        if (data.egressAllowlist !== undefined) {
          row.egressAllowlist = data.egressAllowlist;
        }
        return row;
      },
    },
    teamMembership: {
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = state.memberships.findIndex((m) => m.id === where.id);
        if (idx < 0) throw new Error('membership not found');
        const [removed] = state.memberships.splice(idx, 1);
        return removed;
      },
      findUnique: async ({
        where,
      }: {
        where: { userId_teamId?: { userId: string; teamId: string } };
      }) => {
        const k = where.userId_teamId;
        if (!k) return null;
        return (
          state.memberships.find((m) => m.userId === k.userId && m.teamId === k.teamId) ?? null
        );
      },
    },
  } as unknown as never);

  // The shell-allowlist route looks up the team via prisma directly; nothing
  // else needs the verify-PAT path so we leave that decorator out.

  app.register(teamRoutes, { prefix: '/api/v1/teams' });
  return app;
}

afterEach(() => {
  // App instances are throwaway per-test; nothing to clean.
});

describe('DELETE /api/v1/teams/:id/members/:userId', () => {
  it('removes the membership row and returns { removed: true }', async () => {
    const state = freshState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { removed: true } });
    // Only the caller's membership should remain.
    expect(state.memberships.map((m) => m.userId)).toEqual([ADMIN_USER_ID]);
  });

  it('404s when the target membership is absent', async () => {
    const state = freshState({ memberships: [freshState().memberships[0]] });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('403s when the caller is not a LEAD in this team', async () => {
    // Caller is platform LEAD but only ENGINEER in this team — auth.ts:344
    // (the requiredTeamRole check) should reject.
    const state = freshState();
    state.memberships[0].role = 'ENGINEER';
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    // And the target membership must still exist — the handler never ran.
    expect(state.memberships.map((m) => m.userId).sort()).toEqual(
      [ADMIN_USER_ID, TARGET_USER_ID].sort()
    );
  });
});

/** Allowlist PUT requires platform ADMIN. Platform ADMIN bypasses the
 *  team-role check, so we just bump userRole; no membership changes needed. */
function adminState(overrides?: Partial<State>): State {
  return freshState({ userRole: 'ADMIN', ...overrides });
}

describe('PUT /api/v1/teams/:id/shell-image-allowlist', () => {
  it('persists the new allowlist and returns it back', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: {
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest', 'docker.io/library/python:3.13-slim'],
      },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest', 'docker.io/library/python:3.13-slim'],
      },
    });
    expect(state.teams[0].shellImageAllowlist).toEqual([
      'ghcr.io/acme/ci-tools:latest',
      'docker.io/library/python:3.13-slim',
    ]);
  });

  it('rejects images with shell metacharacters (the Zod regex guard)', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: {
        // Contains a shell metachar; DOCKER_IMAGE_REF_RE should reject it
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest; rm -rf /'],
      },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(400);
    // The allowlist must not have been touched.
    expect(state.teams[0].shellImageAllowlist).toEqual([]);
  });

  it('clears the allowlist when given an empty array (disallowing custom images)', async () => {
    const state = adminState({
      teams: [
        {
          ...freshState().teams[0],
          shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest'],
        },
      ],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { shellImageAllowlist: [] },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(state.teams[0].shellImageAllowlist).toEqual([]);
  });
});

describe('GET /api/v1/teams/:id/egress-allowlist', () => {
  it('returns the current egress allowlist for a team member', async () => {
    const state = freshState({
      teams: [{ ...freshState().teams[0], egressAllowlist: ['registry.npmjs.org'] }],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'GET',
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { egressAllowlist: ['registry.npmjs.org'] } });
  });

  it('404s when the team does not exist (platform ADMIN bypasses team-RBAC)', async () => {
    // A non-admin hits 403 (no membership) before the handler can return 404,
    // so we use platform ADMIN who skips the team-role check.
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'GET',
      url: '/api/v1/teams/00000000-0000-4000-8000-000000000999/egress-allowlist',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEAM_NOT_FOUND');
  });
});

describe('PUT /api/v1/teams/:id/egress-allowlist', () => {
  it('persists the new egress allowlist and returns it', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org', 'api.github.com'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { egressAllowlist: ['registry.npmjs.org', 'api.github.com'] },
    });
    expect(state.teams[0].egressAllowlist).toEqual(['registry.npmjs.org', 'api.github.com']);
  });

  it('rejects invalid hostnames (shell metacharacters)', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org; rm -rf /'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(400);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });

  it('clears the allowlist when given an empty array', async () => {
    const state = adminState({
      teams: [{ ...freshState().teams[0], egressAllowlist: ['registry.npmjs.org'] }],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: [] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });

  it('403s when the caller is not a team ADMIN', async () => {
    // PUT requires requiredTeamRole: 'ADMIN'; a LEAD is rejected.
    const state = freshState({ userRole: 'LEAD' });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(403);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });
});
