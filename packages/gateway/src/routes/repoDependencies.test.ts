import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The route file imports `canManageTeamRepos` from repositories.ts, which pulls
// `Prisma.DbNull` from the barrel; mock the barrel to avoid instantiating the
// real PrismaClient singleton (needs DATABASE_URL at import).
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: { __sentinel: 'DbNull' } } }));

import { repoDependencyRoutes } from './repoDependencies.js';

interface AuthState {
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  sub: string;
}

const ORG = 'org-1';
const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';
const EDGE = '33333333-3333-4333-8333-333333333333';
const TEAM_FROM = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEAM_TO = 'bbbbbbbb-2222-4222-8222-222222222222';

function repoRow(id: string, teamId: string, orgId = ORG, type = 'git_repo') {
  return { id, team: { isActive: true, orgId }, teamId, type };
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authState: AuthState = { role: 'ADMIN', sub: 'admin-1' };

  const mockPrisma = {
    connection: { findMany: vi.fn(), findUnique: vi.fn() },
    repoDependency: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    teamMembership: { findUnique: vi.fn() },
  };

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  };

  const mockTemporal = {
    startRepoDependencyInference: vi.fn(async () => {}),
    triggerRepoDependencyScanNow: vi.fn(async () => {}),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);
  app.decorate('temporal', mockTemporal as unknown as never);
  await app.register(repoDependencyRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  return { app, authState, mockPrisma, mockTemporal };
}

const AUTH = { authorization: 'Bearer fake' };

/** Make `canManageTeamRepos` (via teamMembership.findUnique) grant these team ids. */
function leadOf(mockPrisma: Awaited<ReturnType<typeof buildApp>>['mockPrisma'], teamIds: string[]) {
  mockPrisma.teamMembership.findUnique.mockImplementation(
    (args: { where: { userId_teamId: { teamId: string } } }) =>
      teamIds.includes(args.where.userId_teamId.teamId)
        ? Promise.resolve({ role: 'LEAD', team: { isActive: true } })
        : Promise.resolve(null)
  );
}

describe('repoDependencyRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.authState.role = 'LEAD';
    ctx.authState.sub = 'user-1';
    for (const model of Object.values(ctx.mockPrisma)) {
      for (const fn of Object.values(model)) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    for (const fn of Object.values(ctx.mockTemporal)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  describe('POST /:id/dependencies', () => {
    it('creates a manual edge when the user is LEAD on both teams', async () => {
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_FROM, TEAM_TO]);
      ctx.mockPrisma.repoDependency.create.mockResolvedValueOnce({ id: EDGE, status: 'active' });

      const res = await ctx.app.inject({
        body: { toRepoId: TO },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });

      expect(res.statusCode).toBe(201);
      const data = ctx.mockPrisma.repoDependency.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        fromRepoId: FROM,
        source: 'manual',
        status: 'active',
        toRepoId: TO,
      });
    });

    it('rejects when the user leads only one of the two teams (403)', async () => {
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_FROM]); // not TEAM_TO

      const res = await ctx.app.inject({
        body: { toRepoId: TO },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.repoDependency.create).not.toHaveBeenCalled();
    });

    it('rejects a self-edge (400)', async () => {
      const res = await ctx.app.inject({
        body: { toRepoId: FROM },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('SELF_EDGE');
    });

    it('rejects a cross-org edge (400)', async () => {
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM, 'org-1'))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO, 'org-2'));

      const res = await ctx.app.inject({
        body: { toRepoId: TO },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('CROSS_ORG_EDGE');
    });

    it('maps a unique-constraint violation to 409', async () => {
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_FROM, TEAM_TO]);
      ctx.mockPrisma.repoDependency.create.mockRejectedValueOnce(
        Object.assign(new Error('dup'), { code: 'P2002' })
      );

      const res = await ctx.app.inject({
        body: { toRepoId: TO },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });
      expect(res.statusCode).toBe(409);
    });

    it('forbids an ENGINEER outright (403 at the role gate)', async () => {
      ctx.authState.role = 'ENGINEER';
      const res = await ctx.app.inject({
        body: { toRepoId: TO },
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PATCH /:id/dependencies/:edgeId — dismiss veto', () => {
    it('lets the depended-upon team dismiss (sticky veto)', async () => {
      ctx.mockPrisma.repoDependency.findUnique.mockResolvedValueOnce({
        fromRepoId: FROM,
        id: EDGE,
        toRepoId: TO,
      });
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_TO]); // only the depended-upon team
      ctx.mockPrisma.repoDependency.update.mockResolvedValueOnce({ id: EDGE, status: 'dismissed' });

      const res = await ctx.app.inject({
        body: { status: 'dismissed' },
        headers: AUTH,
        method: 'PATCH',
        url: `/api/v1/repositories/${FROM}/dependencies/${EDGE}`,
      });

      expect(res.statusCode).toBe(200);
      expect(ctx.mockPrisma.repoDependency.update.mock.calls[0][0].data).toMatchObject({
        status: 'dismissed',
      });
    });

    it('rejects dismiss from someone who leads only the dependent team (403)', async () => {
      ctx.mockPrisma.repoDependency.findUnique.mockResolvedValueOnce({
        fromRepoId: FROM,
        id: EDGE,
        toRepoId: TO,
      });
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_FROM]); // dependent team only — not the veto holder

      const res = await ctx.app.inject({
        body: { status: 'dismissed' },
        headers: AUTH,
        method: 'PATCH',
        url: `/api/v1/repositories/${FROM}/dependencies/${EDGE}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets the depended-upon team dismiss from its OWN repo modal (:id === toRepoId)', async () => {
      // The edge is fromRepoId=FROM, toRepoId=TO. The depended-upon team opens
      // TO's Dependencies modal, so the request targets :id = TO. This is the
      // veto flow, and it must not 404 on the fromRepoId !== :id mismatch.
      ctx.mockPrisma.repoDependency.findUnique.mockResolvedValueOnce({
        fromRepoId: FROM,
        id: EDGE,
        toRepoId: TO,
      });
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_TO]);
      ctx.mockPrisma.repoDependency.update.mockResolvedValueOnce({ id: EDGE, status: 'dismissed' });

      const res = await ctx.app.inject({
        body: { status: 'dismissed' },
        headers: AUTH,
        method: 'PATCH',
        url: `/api/v1/repositories/${TO}/dependencies/${EDGE}`,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('DELETE /:id/dependencies/:edgeId', () => {
    it('lets the depended-upon team remove an incoming edge from its own modal (:id === toRepoId)', async () => {
      ctx.mockPrisma.repoDependency.findUnique.mockResolvedValueOnce({
        fromRepoId: FROM,
        id: EDGE,
        toRepoId: TO,
      });
      ctx.mockPrisma.connection.findUnique
        .mockResolvedValueOnce(repoRow(FROM, TEAM_FROM))
        .mockResolvedValueOnce(repoRow(TO, TEAM_TO));
      leadOf(ctx.mockPrisma, [TEAM_TO]);
      ctx.mockPrisma.repoDependency.delete.mockResolvedValueOnce({ id: EDGE });

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `/api/v1/repositories/${TO}/dependencies/${EDGE}`,
      });
      expect(res.statusCode).toBe(204);
      expect(ctx.mockPrisma.repoDependency.delete).toHaveBeenCalledWith({ where: { id: EDGE } });
    });

    it('404s when the edge involves neither the path repo as from nor to', async () => {
      ctx.mockPrisma.repoDependency.findUnique.mockResolvedValueOnce({
        fromRepoId: FROM,
        id: EDGE,
        toRepoId: TO,
      });
      const other = '99999999-9999-4999-8999-999999999999';
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `/api/v1/repositories/${other}/dependencies/${EDGE}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /:id/dependencies', () => {
    it('returns both directions with hydrated neighbours', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(repoRow(FROM, TEAM_FROM));
      ctx.mockPrisma.repoDependency.findMany
        .mockResolvedValueOnce([
          {
            confidence: 1,
            detail: null,
            fromRepoId: FROM,
            id: 'e1',
            kind: 'code',
            source: 'manual',
            status: 'active',
            toRef: null,
            toRepoId: TO,
          },
        ])
        .mockResolvedValueOnce([]);
      ctx.mockPrisma.connection.findMany.mockResolvedValueOnce([
        { id: TO, name: null, organizationName: 'acme', repoName: 'sdk', teamId: TEAM_TO },
      ]);

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/repositories/${FROM}/dependencies`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dependsOn).toHaveLength(1);
      expect(body.dependsOn[0].repo.repoName).toBe('sdk');
      expect(body.dependedOnBy).toEqual([]);
    });
  });
  describe('GET /dependencies/unresolved', () => {
    it('scopes a non-admin to rows raised by repos on their own teams', async () => {
      ctx.authState.role = 'ENGINEER';
      ctx.mockPrisma.repoDependency.findMany.mockResolvedValueOnce([]);

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/repositories/dependencies/unresolved',
      });

      expect(res.statusCode).toBe(200);
      const where = ctx.mockPrisma.repoDependency.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('unresolved');
      // The membership predicate is what stops one team seeing another's backlog.
      expect(where.fromRepo).toEqual({
        team: { memberships: { some: { userId: 'user-1' } } },
      });
    });

    it('does not scope an ADMIN to any team', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.mockPrisma.repoDependency.findMany.mockResolvedValueOnce([]);

      await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/repositories/dependencies/unresolved',
      });

      const where = ctx.mockPrisma.repoDependency.findMany.mock.calls[0][0].where;
      expect(where.fromRepo).toBeUndefined();
    });

    it('returns the rows flat for the client to group', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.mockPrisma.repoDependency.findMany.mockResolvedValueOnce([
        {
          confidence: 1,
          fromRepo: { id: FROM },
          id: 'e1',
          kind: 'code',
          source: 'manifest',
          toRef: '@acme/sdk',
        },
      ]);

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/repositories/dependencies/unresolved',
      });

      expect(JSON.parse(res.payload).data).toHaveLength(1);
      expect(JSON.parse(res.payload).data[0].toRef).toBe('@acme/sdk');
    });
  });

  describe('POST /dependencies/scan', () => {
    it('triggers the sweep for an ADMIN', async () => {
      ctx.authState.role = 'ADMIN';

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/repositories/dependencies/scan',
      });

      expect(res.statusCode).toBe(200);
      expect(ctx.mockTemporal.triggerRepoDependencyScanNow).toHaveBeenCalled();
    });

    it('forbids a LEAD — the sweep spans every team, not just theirs', async () => {
      ctx.authState.role = 'LEAD';

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/repositories/dependencies/scan',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockTemporal.triggerRepoDependencyScanNow).not.toHaveBeenCalled();
    });

    it('reports 503 when the schedule has not been registered yet', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.mockTemporal.triggerRepoDependencyScanNow.mockRejectedValueOnce(new Error('no handle'));

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: '/api/v1/repositories/dependencies/scan',
      });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_UNAVAILABLE');
    });
  });

  describe('POST /:id/dependencies/infer', () => {
    it('starts inference for a LEAD of the repo own team', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(repoRow(FROM, TEAM_FROM));
      leadOf(ctx.mockPrisma, [TEAM_FROM]);

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies/infer`,
      });

      expect(res.statusCode).toBe(202);
      expect(ctx.mockTemporal.startRepoDependencyInference).toHaveBeenCalledWith(
        `repo-dep-infer-${FROM}`,
        FROM
      );
    });

    it('forbids a LEAD of some other team — inference costs a model call', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(repoRow(FROM, TEAM_FROM));
      leadOf(ctx.mockPrisma, [TEAM_TO]);

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies/infer`,
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockTemporal.startRepoDependencyInference).not.toHaveBeenCalled();
    });

    it('409s when inference is already running for the repo', async () => {
      // The workflow id is repo-derived, so a second start while one is in
      // flight is rejected by Temporal. That is intended, but it must not reach
      // the caller as a 500 when someone double-clicks.
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(repoRow(FROM, TEAM_FROM));
      leadOf(ctx.mockPrisma, [TEAM_FROM]);
      ctx.mockTemporal.startRepoDependencyInference.mockRejectedValueOnce(
        Object.assign(new Error('already started'), {
          name: 'WorkflowExecutionAlreadyStartedError',
        })
      );

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies/infer`,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('INFERENCE_IN_PROGRESS');
    });

    it('404s for a non-git connection', async () => {
      ctx.mockPrisma.connection.findUnique.mockResolvedValueOnce(
        repoRow(FROM, TEAM_FROM, ORG, 'mcp')
      );

      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `/api/v1/repositories/${FROM}/dependencies/infer`,
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
