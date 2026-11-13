import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocking the barrel avoids instantiating the real PrismaClient (same pattern as repositories.test.ts).
vi.mock('@auto-swe/shared', () => ({
  encryptSecret: (value: string) => ({
    authTag: Buffer.from('auth-tag'),
    ciphertext: Buffer.from(`sealed-${value.length}`),
    keyVersion: 1,
    lastFour: value.slice(-4),
    nonce: Buffer.from('nonce'),
  }),
}));

import '../test/warmAuthImports.js';
import { teamSecretRoutes } from './teamSecrets.js';

const AUTH = { authorization: 'Bearer fake-jwt' };
const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const REPO_A = '33333333-3333-4333-8333-333333333333';
const REPO_B = '55555555-5555-4555-8555-555555555555';
const SECRET_VALUE = 'super-secret-value-1234';
const updatedAt = new Date('2026-11-13T10:00:00Z');

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const authState = { role: 'ENGINEER', sub: 'user-1' };
  const tx = {
    configAuditLog: { create: vi.fn() },
    teamSecretGrant: { createMany: vi.fn(), deleteMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findMany: vi.fn() },
    repoSetupBlocker: { findMany: vi.fn(), updateMany: vi.fn() },
    repoSetupSecret: { findMany: vi.fn() },
    team: { findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
    teamSecret: {
      count: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      upsert: vi.fn(),
    },
    teamSecretGrant: { findMany: vi.fn() },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  } as unknown as never);
  await app.register(teamSecretRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, authState, prisma, tx };
}

describe('teamSecretRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  const asMember = (role: 'ADMIN' | 'ENGINEER' | null, teamId = TEAM) => {
    ctx.authState.role = 'ENGINEER';
    ctx.prisma.teamMembership.findUnique.mockImplementation(async ({ where }) =>
      role && where.userId_teamId.teamId === teamId ? { role } : null
    );
  };
  const row = (name: string, grants: string[] = []) => ({
    grants: grants.map((connectionId) => ({ connectionId })),
    name,
    updatedAt,
    valueLastFour: SECRET_VALUE.slice(-4),
  });
  const base = `/api/v1/teams/${TEAM}/secrets`;
  const put = (name: string, value: string = SECRET_VALUE) =>
    ctx.app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { value },
      url: `${base}/${name}`,
    });
  const putGrants = (name: string, connectionIds: string[]) =>
    ctx.app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { connectionIds },
      url: `${base}/${name}/grants`,
    });
  const audits = () =>
    JSON.stringify([
      ctx.prisma.configAuditLog.create.mock.calls,
      ctx.tx.configAuditLog.create.mock.calls,
    ]);

  beforeEach(() => {
    for (const group of [ctx.prisma, ctx.tx]) {
      for (const value of Object.values(group)) {
        if (typeof value === 'object') {
          for (const fn of Object.values(value as Record<string, { mockReset?: () => void }>)) {
            fn.mockReset?.();
          }
        }
      }
    }
    ctx.prisma.$transaction.mockImplementation(async (fn) => fn(ctx.tx));
    ctx.prisma.configAuditLog.create.mockResolvedValue({});
    ctx.prisma.team.findUnique.mockResolvedValue({ isActive: true });
    ctx.prisma.teamSecret.count.mockResolvedValue(0);
    ctx.prisma.teamSecret.findUnique.mockResolvedValue(null);
    ctx.prisma.repoSetupBlocker.findMany.mockResolvedValue([]);
    asMember('ADMIN');
  });

  describe('authorization', () => {
    it('refuses a non-admin engineer on every route', async () => {
      asMember('ENGINEER');
      const results = await Promise.all([
        ctx.app.inject({ headers: AUTH, method: 'GET', url: base }),
        put('NPM_TOKEN'),
        ctx.app.inject({ headers: AUTH, method: 'DELETE', url: `${base}/NPM_TOKEN` }),
        putGrants('NPM_TOKEN', []),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
      expect(ctx.prisma.teamSecret.findMany).not.toHaveBeenCalled();
      expect(ctx.prisma.teamSecret.upsert).not.toHaveBeenCalled();
    });

    it("refuses another team's admin", async () => {
      asMember('ADMIN', OTHER_TEAM);
      expect((await ctx.app.inject({ headers: AUTH, method: 'GET', url: base })).statusCode).toBe(
        403
      );
      expect((await put('NPM_TOKEN')).statusCode).toBe(403);
    });

    it('lets a team admin list, sorted by name and without values', async () => {
      ctx.prisma.teamSecret.findMany.mockResolvedValue([
        row('A_TOKEN', [REPO_B, REPO_A]),
        row('B_TOKEN'),
      ]);
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: base });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([
        {
          grantedConnectionIds: [REPO_A, REPO_B],
          lastFour: '1234',
          name: 'A_TOKEN',
          updatedAt: updatedAt.toISOString(),
        },
        {
          grantedConnectionIds: [],
          lastFour: '1234',
          name: 'B_TOKEN',
          updatedAt: updatedAt.toISOString(),
        },
      ]);
      const query = ctx.prisma.teamSecret.findMany.mock.calls[0]?.[0] as {
        orderBy: unknown;
        select: Record<string, unknown>;
        where: unknown;
      };
      expect(query.orderBy).toEqual({ name: 'asc' });
      expect(query.where).toEqual({ teamId: TEAM });
      expect(Object.keys(query.select)).not.toContain('valueCiphertext');
    });

    it('lets a platform admin through without a membership', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.teamMembership.findUnique.mockResolvedValue(null);
      ctx.prisma.teamSecret.findMany.mockResolvedValue([]);
      expect((await ctx.app.inject({ headers: AUTH, method: 'GET', url: base })).statusCode).toBe(
        200
      );
    });
  });

  describe('writing a secret', () => {
    beforeEach(() => {
      ctx.prisma.teamSecret.upsert.mockResolvedValue(row('NPM_TOKEN', [REPO_A]));
    });

    it('stores it encrypted, never returns or audits the value, keeps grants', async () => {
      const res = await put('NPM_TOKEN');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        grantedConnectionIds: [REPO_A],
        lastFour: '1234',
        name: 'NPM_TOKEN',
        updatedAt: updatedAt.toISOString(),
      });
      expect(res.body).not.toContain(SECRET_VALUE);
      const call = ctx.prisma.teamSecret.upsert.mock.calls[0]?.[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.create).toMatchObject({ createdById: 'user-1', name: 'NPM_TOKEN', teamId: TEAM });
      expect(call.update).not.toHaveProperty('createdById');
      expect(JSON.stringify(call)).not.toContain(SECRET_VALUE);
      expect(audits()).not.toContain(SECRET_VALUE);
      expect(
        JSON.parse(JSON.stringify(ctx.prisma.configAuditLog.create.mock.calls[0]))[0].data
      ).toMatchObject({
        action: 'CREATE',
        afterJson: { teamSecret: 'NPM_TOKEN' },
        entityId: TEAM,
        entityType: 'TeamSecret',
      });
    });

    it('audits a replacement as an update', async () => {
      ctx.prisma.teamSecret.findUnique.mockResolvedValue({ id: 's1' });
      expect((await put('NPM_TOKEN')).statusCode).toBe(200);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');
      expect(ctx.prisma.teamSecret.count).not.toHaveBeenCalled();
    });

    it('refuses a new name at the limit but still replaces an existing one', async () => {
      ctx.prisma.teamSecret.count.mockResolvedValue(50);
      const res = await put('NEW_TOKEN');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_SECRET_LIMIT');
      expect(ctx.prisma.teamSecret.upsert).not.toHaveBeenCalled();
      ctx.prisma.teamSecret.findUnique.mockResolvedValue({ id: 's1' });
      expect((await put('NEW_TOKEN')).statusCode).toBe(200);
    });

    it('refuses an inactive team', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue({ isActive: false });
      const res = await put('NPM_TOKEN');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_INACTIVE');
    });

    it.each(['PATH', 'NODE_OPTIONS', 'GIT_ASKPASS', 'HTTPS_PROXY', 'lower_case'])(
      'rejects the name %s',
      async (name) => {
        expect((await put(name)).statusCode).toBe(400);
        expect(ctx.prisma.teamSecret.upsert).not.toHaveBeenCalled();
      }
    );

    it('rejects a value that is too short or too long', async () => {
      expect((await put('NPM_TOKEN', 'short')).statusCode).toBe(400);
      expect((await put('NPM_TOKEN', 'x'.repeat(16_385))).statusCode).toBe(400);
    });
  });

  describe('deleting a secret', () => {
    it('removes it and audits the name', async () => {
      ctx.prisma.teamSecret.deleteMany.mockResolvedValue({ count: 1 });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${base}/NPM_TOKEN`,
      });
      expect(res.statusCode).toBe(204);
      expect(ctx.prisma.teamSecret.deleteMany).toHaveBeenCalledWith({
        where: { name: 'NPM_TOKEN', teamId: TEAM },
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'DELETE',
        beforeJson: { teamSecret: 'NPM_TOKEN' },
      });
    });

    it('returns 404 for an absent secret', async () => {
      ctx.prisma.teamSecret.deleteMany.mockResolvedValue({ count: 0 });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${base}/NPM_TOKEN`,
      });
      expect(res.statusCode).toBe(404);
      expect(ctx.prisma.configAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('grants', () => {
    beforeEach(() => {
      ctx.prisma.teamSecret.findUnique.mockResolvedValue({
        grants: [{ connectionId: REPO_B }],
        id: 'secret-1',
      });
      ctx.prisma.connection.findMany.mockResolvedValue([{ id: REPO_A }]);
      ctx.prisma.teamSecret.findUniqueOrThrow.mockResolvedValue(row('NPM_TOKEN', [REPO_A]));
    });

    it('replaces the set, deduplicated, audits ids only', async () => {
      const res = await putGrants('NPM_TOKEN', [REPO_A, REPO_A]);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.grantedConnectionIds).toEqual([REPO_A]);
      expect(ctx.prisma.connection.findMany).toHaveBeenCalledWith({
        select: { id: true },
        where: { id: { in: [REPO_A] }, teamId: TEAM, type: 'git_repo' },
      });
      expect(ctx.tx.teamSecretGrant.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: { notIn: [REPO_A] }, teamSecretId: 'secret-1' },
      });
      expect(ctx.tx.teamSecretGrant.createMany.mock.calls[0]?.[0].data).toEqual([
        { connectionId: REPO_A, createdById: 'user-1', teamSecretId: 'secret-1' },
      ]);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        afterJson: { grantedConnectionIds: [REPO_A], teamSecret: 'NPM_TOKEN' },
        beforeJson: { grantedConnectionIds: [REPO_B], teamSecret: 'NPM_TOKEN' },
        entityType: 'TeamSecret',
      });
    });

    it('rejects a repository the team does not own, including one only shared to it', async () => {
      ctx.prisma.connection.findMany.mockResolvedValue([]);
      const res = await putGrants('NPM_TOKEN', [REPO_A]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('GRANT_REPO_NOT_OWNED');
      expect(res.body).not.toContain(REPO_A);
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('clears every grant with an empty list', async () => {
      ctx.prisma.teamSecretGrant.findMany.mockResolvedValue([]);
      expect((await putGrants('NPM_TOKEN', [])).statusCode).toBe(200);
      expect(ctx.prisma.connection.findMany).not.toHaveBeenCalled();
      expect(ctx.tx.teamSecretGrant.deleteMany).toHaveBeenCalled();
      expect(ctx.tx.teamSecretGrant.createMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an absent secret and 400 for a bad id', async () => {
      ctx.prisma.teamSecret.findUnique.mockResolvedValue(null);
      expect((await putGrants('NPM_TOKEN', [])).statusCode).toBe(404);
      expect((await putGrants('NPM_TOKEN', ['not-a-uuid'])).statusCode).toBe(400);
    });

    it('resolves a missing-secret blocker the new grant satisfies, and no other', async () => {
      ctx.prisma.repoSetupBlocker.findMany.mockResolvedValue([
        { connectionId: REPO_A, id: 'b-done', subject: 'NPM_TOKEN' },
        { connectionId: REPO_A, id: 'b-partial', subject: 'NPM_TOKEN, OTHER_TOKEN' },
      ]);
      ctx.prisma.repoSetupSecret.findMany.mockResolvedValue([]);
      ctx.prisma.teamSecretGrant.findMany.mockResolvedValue([
        { connectionId: REPO_A, teamSecret: { name: 'NPM_TOKEN' } },
      ]);
      expect((await putGrants('NPM_TOKEN', [REPO_A])).statusCode).toBe(200);
      expect(ctx.prisma.repoSetupBlocker.updateMany).toHaveBeenCalledWith({
        data: { resolvedAt: expect.any(Date) },
        where: { id: { in: ['b-done'] }, resolvedAt: null },
      });
    });
  });
});
