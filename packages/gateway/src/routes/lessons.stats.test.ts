import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lessonRoutes } from './lessons.js';

/** A `memoryItem.groupBy` row as the total-count aggregation returns it. */
function totalRow(repoId: string | null, count: number, consolidatedAt: Date | null = null) {
  return { _count: { _all: count }, _max: { consolidatedAt }, repoId };
}

/** A `memoryItem.groupBy` row as the active-count aggregation returns it. */
function activeRow(repoId: string | null, count: number) {
  return { _count: { _all: count }, repoId };
}

function newMockPrisma() {
  return {
    connection: { findMany: vi.fn() },
    memoryItem: {
      // First call = totals aggregation, second = active-only aggregation.
      groupBy: vi.fn(),
    },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };
const REPO_A = '11111111-1111-4111-8111-111111111111';
const REPO_B = '22222222-2222-4222-8222-222222222222';

function get(app: Awaited<ReturnType<typeof buildApp>>['app']) {
  return app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons/stats' });
}

beforeEach(() => vi.clearAllMocks());

describe('GET /lessons/stats', () => {
  it('rejects a non-admin', async () => {
    const { app } = await buildApp('ENGINEER');
    expect((await get(app)).statusCode).toBe(403);
    await app.close();
  });

  it('includes configured repos that have no lessons yet, as zero rows', async () => {
    // Regression: the repo list used to be derived from the lessons groupBy, so
    // a repo with no lessons never appeared. On a fresh deployment that is every
    // repo, and the admin table rendered "No repositories found".
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([
      { id: REPO_A, organizationName: 'acme', repoName: 'api' },
      { id: REPO_B, organizationName: 'acme', repoName: 'web' },
    ]);
    mockPrisma.memoryItem.groupBy
      .mockResolvedValueOnce([totalRow(REPO_A, 3, new Date('2026-01-02T00:00:00Z'))])
      .mockResolvedValueOnce([activeRow(REPO_A, 1)]);

    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;

    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      activeCount: 1,
      consolidatedCount: 2,
      id: REPO_A,
      repoName: 'api',
      totalCount: 3,
    });
    // The lesson-less repo is present with zeroes rather than missing.
    expect(data[1]).toMatchObject({
      activeCount: 0,
      consolidatedCount: 0,
      id: REPO_B,
      lastConsolidatedAt: null,
      repoName: 'web',
      totalCount: 0,
    });
    await app.close();
  });

  it('only enumerates git_repo connections', async () => {
    // The Connection table is polymorphic (mcp servers live there too) and a
    // non-repo row has no org/repo name to render.
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([]);
    mockPrisma.memoryItem.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await get(app);

    expect(mockPrisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: 'git_repo' } })
    );
    await app.close();
  });

  it('still reports a repo that has lessons but is absent from the repo list', async () => {
    // Defensive: the page sums these rows into its summary tiles, so a repo
    // with lessons must never be silently dropped from the totals.
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([]);
    mockPrisma.memoryItem.groupBy
      .mockResolvedValueOnce([totalRow(REPO_A, 5)])
      .mockResolvedValueOnce([activeRow(REPO_A, 5)]);

    const res = await get(app);
    const data = JSON.parse(res.payload).data;

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      activeCount: 5,
      consolidatedCount: 0,
      id: REPO_A,
      organizationName: null,
      repoName: null,
      totalCount: 5,
    });
    await app.close();
  });

  it('sorts by organization then repo name', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([
      { id: REPO_A, organizationName: 'zeta', repoName: 'api' },
      { id: REPO_B, organizationName: 'acme', repoName: 'web' },
    ]);
    mockPrisma.memoryItem.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await get(app);
    const data = JSON.parse(res.payload).data;

    expect(data.map((r: { organizationName: string }) => r.organizationName)).toEqual([
      'acme',
      'zeta',
    ]);
    await app.close();
  });
});
