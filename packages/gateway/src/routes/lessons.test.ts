import { resolveSetting } from '@auto-swe/shared/config';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lessonRoutes, runLessonRoutes } from './lessons.js';

// The forget walk is covered against real Postgres (memoryForget.pg.test.ts);
// here it is a stand-in that reports what it was asked to forget.
const { forgetMock } = vi.hoisted(() => ({
  forgetMock: vi.fn(async (_tx: unknown, ids: string[]) => ({ deleted: ids, restored: ['r-1'] })),
}));
vi.mock('@auto-swe/shared/lib/memoryForget', () => ({ forgetMemoryItems: forgetMock }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn().mockResolvedValue(2) }));

function newMockPrisma() {
  const prisma = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    lessonFlag: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    memoryItem: {
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    organizationMembership: { findUnique: vi.fn().mockResolvedValue(null) },
    team: { findUnique: vi.fn().mockResolvedValue(null) },
    teamMembership: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  return prisma;
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  const temporal = { startConsolidationWorkflow: vi.fn().mockResolvedValue(undefined) };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.ready();
  return { app, prisma, temporal };
}

const AUTH = { authorization: 'Bearer fake' };
const REPO_ID = '11111111-1111-4111-8111-111111111111';

function lastListWhere(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.memoryItem.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSetting).mockResolvedValue(2);
});

describe('GET /lessons (list)', () => {
  it('lists repository lessons only, never channel memory — even for an admin', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(lastListWhere(prisma)).toMatchObject({ scope: 'swe-lessons' });
  });

  // The dashboard's Lessons page is open to engineers, so the list is their only
  // view of lessons and must be confined to repositories they can reach.
  it('confines a non-admin to lessons of repositories they can reach', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).repository).toEqual({
      AND: [
        {
          OR: [
            { team: { memberships: { some: { userId: 'admin-1' } } } },
            { shares: { some: { team: { memberships: { some: { userId: 'admin-1' } } } } } },
          ],
        },
        {},
      ],
    });
  });

  it('names the repositories a non-admin leads, and none for an admin', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.connection.findMany.mockResolvedValue([{ id: REPO_ID }]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(res.json().meta.managedRepoIds).toEqual([REPO_ID]);
    expect(prisma.connection.findMany.mock.calls[0][0].where).toEqual({
      team: {
        isActive: true,
        memberships: { some: { role: { in: ['LEAD', 'ADMIN'] }, userId: 'admin-1' } },
      },
      type: 'git_repo',
    });

    const admin = await buildApp('ADMIN');
    const adminRes = await admin.app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons',
    });
    expect(adminRes.json().meta.managedRepoIds).toBeUndefined();
  });

  it('returns what a reader needs to judge a lesson, never its embedding', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    const select = prisma.memoryItem.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ confidence: true, metadata: true, workflowRunId: true });
    expect(select.embedding).toBeUndefined();
  });

  it('excludes consolidated lessons by default', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeNull();
  });

  // Regression: z.coerce.boolean() treats the *string* "false" as truthy
  // (Boolean("false") === true), so ?includeConsolidated=false used to
  // silently include consolidated (soft-deleted) lessons.
  it('excludes consolidated lessons when includeConsolidated=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=false',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeNull();
  });

  it('includes consolidated lessons when includeConsolidated=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=true',
    });
    expect(res.statusCode).toBe(200);
    expect(lastListWhere(prisma).consolidatedAt).toBeUndefined();
  });

  it('narrows to one repository and a search term', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons?repoId=${REPO_ID}&q=retry`,
    });
    expect(res.statusCode).toBe(200);
    const where = lastListWhere(prisma);
    expect(where.repoId).toBe(REPO_ID);
    expect(where.OR).toEqual([
      { lessonSummary: { contains: 'retry', mode: 'insensitive' } },
      { rationale: { contains: 'retry', mode: 'insensitive' } },
    ]);
  });

  it('rejects a repoId that is not a UUID', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?repoId=nope',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an includeConsolidated value other than true/false', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/lessons?includeConsolidated=0',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /lessons/search', () => {
  function lastSearchWhere(prisma: ReturnType<typeof newMockPrisma>) {
    return prisma.memoryItem.findMany.mock.calls[0][0].where as Record<string, unknown>;
  }

  it('excludes consolidated lessons when includeConsolidated=false is explicit', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons/search?q=foo&repoId=${REPO_ID}&includeConsolidated=false`,
    });
    expect(res.statusCode).toBe(200);
    expect(lastSearchWhere(prisma).consolidatedAt).toBeNull();
  });

  it('includes consolidated lessons when includeConsolidated=true', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/lessons/search?q=foo&repoId=${REPO_ID}&includeConsolidated=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(lastSearchWhere(prisma).consolidatedAt).toBeUndefined();
  });
});

describe('DELETE /lessons/:id', () => {
  const LESSON_ID = '22222222-2222-4222-8222-222222222222';

  it('only finds a lesson by id within the lesson scope', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.memoryItem.findFirst.mock.calls[0][0].where).toEqual({
      id: LESSON_ID,
      scope: 'swe-lessons',
    });
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('deletes and audits the deleted content in one transaction', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    const lesson = { id: LESSON_ID, lessonSummary: 'run migrations first', rationale: 'r' };
    prisma.memoryItem.findFirst.mockResolvedValue(lesson);

    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(forgetMock).toHaveBeenCalledWith(expect.anything(), [LESSON_ID]);
    expect(res.json().data).toEqual({ deleted: true, forgotten: [LESSON_ID], restored: ['r-1'] });
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DELETE',
        actorId: 'admin-1',
        afterJson: { deleted: [LESSON_ID], restored: ['r-1'] },
        beforeJson: lesson,
        entityId: LESSON_ID,
        entityType: 'MemoryItem',
      }),
    });
  });

  const del = (app: Awaited<ReturnType<typeof buildApp>>['app']) =>
    app.inject({ headers: AUTH, method: 'DELETE', url: `/api/v1/lessons/${LESSON_ID}` });
  const repoLesson = { id: LESSON_ID, lessonSummary: 's', rationale: 'r', repoId: REPO_ID };

  it('lets a lead of the repository team delete its lesson', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.memoryItem.findFirst.mockResolvedValue(repoLesson);
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'LEAD', team: { isActive: true } });
    const res = await del(app);
    expect(res.statusCode).toBe(200);
    expect(forgetMock).toHaveBeenCalledWith(expect.anything(), [LESSON_ID]);
    expect(prisma.teamMembership.findUnique.mock.calls[0][0].where).toEqual({
      userId_teamId: { teamId: 'team-1', userId: 'admin-1' },
    });
  });

  it('refuses a member who reads the lesson but does not lead its team', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.memoryItem.findFirst.mockResolvedValue(repoLesson);
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({
      role: 'ENGINEER',
      team: { isActive: true },
    });
    const res = await del(app);
    expect(res.statusCode).toBe(403);
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('refuses a lead of an inactive team', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.memoryItem.findFirst.mockResolvedValue(repoLesson);
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'LEAD', team: { isActive: false } });
    expect((await del(app)).statusCode).toBe(403);
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('answers 404 to someone who cannot reach the repository at all', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.memoryItem.findFirst.mockResolvedValue(repoLesson);
    prisma.connection.findFirst.mockResolvedValue(null);
    expect((await del(app)).statusCode).toBe(404);
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('keeps a lesson of a deleted repository for platform admins', async () => {
    const { app, prisma } = await buildApp('ENGINEER');
    prisma.memoryItem.findFirst.mockResolvedValue({ ...repoLesson, repoId: null });
    expect((await del(app)).statusCode).toBe(404);
    expect(prisma.connection.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /lessons/consolidate', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>['app']) =>
    app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { repoId: REPO_ID },
      url: '/api/v1/lessons/consolidate',
    });

  it('lets a lead of the repository team start consolidation', async () => {
    const { app, prisma, temporal } = await buildApp('ENGINEER');
    prisma.connection.findUnique.mockResolvedValue({ id: REPO_ID });
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({ role: 'ADMIN', team: { isActive: true } });
    const res = await post(app);
    expect(res.statusCode).toBe(202);
    expect(temporal.startConsolidationWorkflow).toHaveBeenCalledWith(
      expect.stringContaining(`consolidate-lessons-${REPO_ID}-`),
      expect.objectContaining({ repoId: REPO_ID })
    );
  });

  it('refuses an engineer of the team', async () => {
    const { app, prisma, temporal } = await buildApp('ENGINEER');
    prisma.connection.findUnique.mockResolvedValue({ id: REPO_ID });
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({
      role: 'ENGINEER',
      team: { isActive: true },
    });
    expect((await post(app)).statusCode).toBe(403);
    expect(temporal.startConsolidationWorkflow).not.toHaveBeenCalled();
  });

  it('answers 404 for a repository the caller cannot reach', async () => {
    const { app, prisma, temporal } = await buildApp('ENGINEER');
    prisma.connection.findUnique.mockResolvedValue({ id: REPO_ID });
    prisma.connection.findFirst.mockResolvedValue(null);
    expect((await post(app)).statusCode).toBe(404);
    expect(temporal.startConsolidationWorkflow).not.toHaveBeenCalled();
  });

  it('lets a platform admin consolidate any repository without a membership read', async () => {
    const { app, prisma } = await buildApp('ADMIN');
    prisma.connection.findUnique.mockResolvedValue({ id: REPO_ID });
    expect((await post(app)).statusCode).toBe(202);
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /workflow-runs/:id/lessons', () => {
  const RUN_ID = '22222222-2222-4222-8222-222222222222';
  const L1 = '33333333-3333-4333-8333-333333333333';
  const L2 = '44444444-4444-4444-8444-444444444444';

  async function buildRunApp(role: 'ADMIN' | 'ENGINEER' = 'ENGINEER') {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const prisma = {
      ...newMockPrisma(),
      agentTrace: { findMany: vi.fn().mockResolvedValue([]) },
      memoryItem: { findMany: vi.fn().mockResolvedValue([]) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: RUN_ID }) },
    };
    prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    prisma.teamMembership.findUnique.mockResolvedValue({
      role: 'ENGINEER',
      team: { isActive: true },
    });
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
    } as unknown as never);
    await app.register(runLessonRoutes, { prefix: '/api/v1/workflow-runs' });
    await app.ready();
    return { app, prisma };
  }

  const get = (app: Awaited<ReturnType<typeof buildRunApp>>['app']) =>
    app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/workflow-runs/${RUN_ID}/lessons` });

  const row = (summary: string) => ({
    _count: { flags: 0 },
    flags: [],
    id: L1,
    lessonSummary: summary,
    quarantinedAt: null,
    quarantinedById: null,
    quarantineReason: null,
    quarantineSource: null,
    repoId: REPO_ID,
  });

  it('404s a run the caller cannot see, before reading any lesson', async () => {
    const { app, prisma } = await buildRunApp();
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    const res = await get(app);
    expect(res.statusCode).toBe(404);
    // The visibility filter is part of the run lookup, not applied afterwards.
    expect(prisma.workflowRun.findFirst.mock.calls[0][0].where.OR).toBeDefined();
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
    expect(prisma.memoryItem.findMany).not.toHaveBeenCalled();
  });

  it('lists recalled lessons once each, naming every agent that recalled them', async () => {
    const { app, prisma } = await buildRunApp();
    prisma.agentTrace.findMany.mockResolvedValue([
      { outputJson: { lessons: [{ lessonId: L1 }, { lessonId: L2 }], recalledFor: 'implementer' } },
      { outputJson: { lessons: [{ lessonId: L1 }], recalledFor: 'reviewer' } },
    ]);
    prisma.memoryItem.findMany
      .mockResolvedValueOnce([]) // written by this run
      .mockResolvedValueOnce([row('Run migrations first')]);
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const { recalled } = JSON.parse(res.payload).data;
    expect(recalled).toEqual([
      {
        lesson: expect.objectContaining({
          canFlag: true,
          canManage: false,
          flagCount: 0,
          id: L1,
          lessonSummary: 'Run migrations first',
          myFlag: null,
        }),
        lessonId: L1,
        recalledFor: ['implementer', 'reviewer'],
      },
      // Deleted since: the run still recalled it, so it is listed without text.
      { lesson: null, lessonId: L2, recalledFor: ['implementer'] },
    ]);
    // Only this run's recall events are read, and only repository lessons are fetched.
    expect(prisma.agentTrace.findMany.mock.calls[0][0].where).toEqual({
      runId: RUN_ID,
      toolName: 'lessons.retrieved',
      type: 'activity_event',
    });
    expect(prisma.memoryItem.findMany.mock.calls[1][0].where).toEqual({
      id: { in: [L1, L2] },
      scope: 'swe-lessons',
    });
  });

  it('skips malformed recall entries rather than querying them', async () => {
    const { app, prisma } = await buildRunApp();
    prisma.agentTrace.findMany.mockResolvedValue([
      { outputJson: { lessons: [{ lessonId: 'not-a-uuid' }, null, { lessonId: 7 }] } },
      { outputJson: null },
    ]);
    const res = await get(app);
    expect(JSON.parse(res.payload).data.recalled).toEqual([]);
    // Only the written-lessons query ran.
    expect(prisma.memoryItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('lists the lessons this run wrote', async () => {
    const { app, prisma } = await buildRunApp();
    prisma.memoryItem.findMany.mockResolvedValueOnce([row('Pin the image')]);
    const res = await get(app);
    expect(JSON.parse(res.payload).data.written).toEqual([
      expect.objectContaining({
        canFlag: true,
        canManage: false,
        id: L1,
        lessonSummary: 'Pin the image',
      }),
    ]);
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where).toEqual({
      scope: 'swe-lessons',
      workflowRunId: RUN_ID,
    });
    expect(prisma.memoryItem.findMany.mock.calls[0][0].select.embedding).toBeUndefined();
  });

  it.each(['ADMIN', 'ENGINEER'] as const)(
    'labels historical quarantine and scopes triage details for %s',
    async (role) => {
      const { app, prisma } = await buildRunApp(role);
      prisma.memoryItem.findMany.mockResolvedValue([
        {
          ...row('Stale advice'),
          _count: { flags: 1 },
          flags: [
            {
              createdAt: new Date(),
              flaggedBy: { email: 'other@x.test' },
              flaggedById: 'other',
              reason: 'private flag',
            },
          ],
          quarantinedAt: new Date(),
          quarantineReason: 'obsolete',
          quarantineSource: 'MANUAL',
        },
      ]);
      const res = await get(app);
      expect(res.statusCode).toBe(200);
      const [lesson] = res.json().data.written;
      expect(lesson).toMatchObject({
        canFlag: true,
        canManage: role === 'ADMIN',
        flagCount: 1,
        quarantineReason: 'obsolete',
        quarantineSource: 'MANUAL',
      });
      expect(lesson.flags).toEqual(
        role === 'ADMIN' ? [expect.objectContaining({ reason: 'private flag' })] : undefined
      );
      expect(lesson._count).toBeUndefined();
    }
  );

  it('keeps historical text but offers no triage when repository access is lost', async () => {
    const { app, prisma } = await buildRunApp();
    prisma.memoryItem.findMany.mockResolvedValue([row('Historical advice')]);
    prisma.connection.findFirst.mockResolvedValue(null);
    const res = await get(app);
    expect(res.json().data.written[0]).toMatchObject({
      canFlag: false,
      canManage: false,
      lessonSummary: 'Historical advice',
    });
  });
});

describe('lesson flags', () => {
  const LESSON_ID = '55555555-5555-4555-8555-555555555555';
  const lessonRow = { id: LESSON_ID, lessonSummary: 's', repoId: REPO_ID };

  /** An ENGINEER who reaches the repository and, when `lead`, leads its team. */
  async function reader(lead = false) {
    const built = await buildApp('ENGINEER');
    built.prisma.memoryItem.findFirst.mockResolvedValue(lessonRow);
    built.prisma.connection.findFirst.mockResolvedValue({ teamId: 'team-1' });
    built.prisma.teamMembership.findUnique.mockResolvedValue({
      role: lead ? 'LEAD' : 'ENGINEER',
      team: { isActive: true },
    });
    return built;
  }

  const mutate = (
    app: Awaited<ReturnType<typeof buildApp>>['app'],
    action: string,
    method: 'POST' | 'DELETE' = 'POST',
    payload?: { reason: string }
  ) =>
    app.inject({
      headers: AUTH,
      method,
      ...(payload === undefined ? {} : { payload }),
      url: `/api/v1/lessons/${LESSON_ID}/${action}`,
    });

  it.each([0, 1, 2, 3])(
    'quarantines at threshold, not below it (%i distinct flags)',
    async (count) => {
      const { app, prisma } = await reader();
      prisma.lessonFlag.count.mockResolvedValue(count);
      prisma.connection.findUnique.mockResolvedValue({
        team: { orgId: 'org-1' },
        teamId: 'team-1',
      });
      expect((await mutate(app, 'flags', 'POST', { reason: 'wrong' })).statusCode).toBe(201);
      expect(resolveSetting).toHaveBeenCalledWith('memory.lessonFlagQuarantineThreshold', {
        orgId: 'org-1',
        teamId: 'team-1',
      });
      expect(prisma.$executeRaw.mock.calls[0]?.[1]).toBe(`lesson-quarantine:${LESSON_ID}`);
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lessonFlag.upsert.mock.invocationCallOrder[0]
      );
      expect(prisma.lessonFlag.count).toHaveBeenCalledWith({ where: { memoryItemId: LESSON_ID } });
      if (count >= 2) {
        expect(prisma.memoryItem.update).toHaveBeenCalledWith({
          data: expect.objectContaining({
            quarantinedAt: expect.any(Date),
            quarantinedById: null,
            quarantineSource: 'FLAG_THRESHOLD',
          }),
          where: { id: LESSON_ID },
        });
        expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorId: null,
            afterJson: expect.objectContaining({
              event: 'lesson.quarantined',
              flagCount: count,
              threshold: 2,
            }),
          }),
        });
      } else {
        expect(prisma.memoryItem.update).not.toHaveBeenCalled();
      }
    }
  );

  it('does not automatically quarantine when disabled', async () => {
    const { app, prisma } = await reader();
    vi.mocked(resolveSetting).mockResolvedValueOnce(0);
    prisma.lessonFlag.count.mockResolvedValue(20);
    expect((await mutate(app, 'flags', 'POST', { reason: 'wrong' })).statusCode).toBe(201);
    expect(prisma.memoryItem.update).not.toHaveBeenCalled();
  });

  it.each(['MANUAL', 'FLAG_THRESHOLD'])(
    'preserves an existing %s quarantine when a flag reaches threshold',
    async (source) => {
      const { app, prisma } = await reader();
      prisma.memoryItem.findFirst.mockResolvedValue({
        ...lessonRow,
        quarantinedAt: new Date(),
        quarantineSource: source,
      });
      prisma.lessonFlag.count.mockResolvedValue(2);
      expect((await mutate(app, 'flags', 'POST', { reason: 'wrong' })).statusCode).toBe(201);
      expect(prisma.memoryItem.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['FLAG_THRESHOLD', 1, true],
    ['FLAG_THRESHOLD', 2, false],
    ['MANUAL', 1, false],
  ])(
    'withdrawal changes %s at %i flags only when automatic and below threshold',
    async (source, count, lifts) => {
      const { app, prisma } = await reader();
      prisma.memoryItem.findFirst.mockResolvedValue({
        ...lessonRow,
        quarantinedAt: new Date(),
        quarantineSource: source,
      });
      prisma.lessonFlag.count.mockResolvedValue(count);
      expect((await mutate(app, 'flags/mine', 'DELETE')).statusCode).toBe(200);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      if (lifts) {
        expect(prisma.memoryItem.update).toHaveBeenCalledWith({
          data: {
            quarantinedAt: null,
            quarantinedById: null,
            quarantineReason: null,
            quarantineSource: null,
          },
          where: { id: LESSON_ID },
        });
        expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorId: null,
            afterJson: expect.objectContaining({ event: 'lesson.restored' }),
          }),
        });
      } else {
        expect(prisma.memoryItem.update).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['MANUAL', 'FLAG_THRESHOLD'])(
    'clear flags preserves manual quarantine and lifts automatic (%s)',
    async (source) => {
      const { app, prisma } = await reader(true);
      prisma.memoryItem.findFirst.mockResolvedValue({
        ...lessonRow,
        quarantinedAt: new Date(),
        quarantineSource: source,
      });
      expect((await mutate(app, 'flags', 'DELETE')).statusCode).toBe(200);
      expect(prisma.memoryItem.update).toHaveBeenCalledTimes(source === 'MANUAL' ? 0 : 1);
    }
  );

  it.each(['quarantine', 'restore'])(
    'denies reader-only %s and hides inaccessible lessons',
    async (action) => {
      const { app, prisma } = await reader();
      expect((await mutate(app, action, 'POST', { reason: 'wrong' })).statusCode).toBe(403);
      prisma.connection.findFirst.mockResolvedValue(null);
      expect((await mutate(app, action, 'POST', { reason: 'wrong' })).statusCode).toBe(404);
      prisma.memoryItem.findFirst.mockResolvedValue(null);
      expect((await mutate(app, action, 'POST', { reason: 'wrong' })).statusCode).toBe(404);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(['', ' ', 'x'.repeat(501)])(
    'rejects an empty or oversized quarantine reason',
    async (reason) => {
      const { app, prisma } = await reader(true);
      expect((await mutate(app, 'quarantine', 'POST', { reason })).statusCode).toBe(400);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  );

  it('lets an owning-team lead manually quarantine, recording their reason and identity', async () => {
    const { app, prisma } = await reader(true);
    expect((await mutate(app, 'quarantine', 'POST', { reason: ' stale ' })).statusCode).toBe(200);
    expect(prisma.memoryItem.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      scope: 'swe-lessons',
    });
    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          quarantinedAt: expect.any(Date),
          quarantinedById: 'admin-1',
          quarantineReason: 'stale',
          quarantineSource: 'MANUAL',
        },
      })
    );
    expect(prisma.lessonFlag.deleteMany).not.toHaveBeenCalled();
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        afterJson: expect.objectContaining({ event: 'lesson.quarantined' }),
      }),
    });
  });

  it.each([0, 2])('lets an admin restore and audit all %i cleared flag reasons', async (count) => {
    const { app, prisma } = await buildApp('ADMIN');
    prisma.memoryItem.findFirst.mockResolvedValue({
      ...lessonRow,
      quarantinedAt: new Date(),
      quarantineSource: 'MANUAL',
    });
    const flags = Array.from({ length: count }, (_, i) => ({
      flaggedById: `u-${i}`,
      reason: `reason ${i}`,
    }));
    prisma.lessonFlag.findMany.mockResolvedValue(flags);
    expect((await mutate(app, 'restore')).statusCode).toBe(200);
    expect(prisma.lessonFlag.deleteMany).toHaveBeenCalledWith({
      where: { memoryItemId: LESSON_ID },
    });
    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          quarantinedAt: null,
          quarantinedById: null,
          quarantineReason: null,
          quarantineSource: null,
        },
      })
    );
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: expect.objectContaining({ event: 'lesson.restored' }),
        beforeJson: expect.objectContaining({ flagCount: count, flags }),
      }),
    });
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.lessonFlag.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it('filters quarantines without losing repository visibility, while false is not truthy', async () => {
    const { app, prisma } = await reader();
    const row = {
      ...lessonRow,
      _count: { flags: 0 },
      flags: [],
      quarantinedAt: new Date(),
      quarantineReason: 'stale',
      quarantineSource: 'MANUAL',
    };
    prisma.memoryItem.findMany.mockResolvedValue([row]);
    const res = await app.inject({ headers: AUTH, url: '/api/v1/lessons?quarantined=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({
      quarantineReason: 'stale',
      quarantineSource: 'MANUAL',
    });
    expect(lastListWhere(prisma)).toMatchObject({
      quarantinedAt: { not: null },
      repository: expect.anything(),
      scope: 'swe-lessons',
    });
    await app.inject({ headers: AUTH, url: '/api/v1/lessons?quarantined=false' });
    expect(prisma.memoryItem.findMany.mock.calls.at(-1)?.[0]?.where.quarantinedAt).toBeUndefined();
  });

  it('lets anyone who reads a lesson flag it, once, with an audited reason', async () => {
    const { app, prisma } = await reader();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { reason: '  The migration step no longer exists  ' },
      url: `/api/v1/lessons/${LESSON_ID}/flags`,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.lessonFlag.upsert).toHaveBeenCalledWith({
      create: {
        flaggedById: 'admin-1',
        memoryItemId: LESSON_ID,
        reason: 'The migration step no longer exists',
      },
      update: { reason: 'The migration step no longer exists' },
      where: { memoryItemId_flaggedById: { flaggedById: 'admin-1', memoryItemId: LESSON_ID } },
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: { event: 'lesson.flagged', reason: 'The migration step no longer exists' },
        entityId: LESSON_ID,
        entityType: 'MemoryItem',
      }),
    });
  });

  it('refuses an empty reason', async () => {
    const { app, prisma } = await reader();
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { reason: '   ' },
      url: `/api/v1/lessons/${LESSON_ID}/flags`,
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.lessonFlag.upsert).not.toHaveBeenCalled();
  });

  it('answers 404 for a lesson the caller cannot reach', async () => {
    const { app, prisma } = await reader();
    prisma.connection.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { reason: 'wrong' },
      url: `/api/v1/lessons/${LESSON_ID}/flags`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.lessonFlag.upsert).not.toHaveBeenCalled();
  });

  it("withdraws only the caller's own flag", async () => {
    const { app, prisma } = await reader();
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}/flags/mine`,
    });
    expect(res.json().data).toEqual({ withdrawn: true });
    expect(prisma.lessonFlag.deleteMany).toHaveBeenCalledWith({
      where: { flaggedById: 'admin-1', memoryItemId: LESSON_ID },
    });
  });

  it('lets a lead clear every flag, keeping the reasons in the audit row', async () => {
    const { app, prisma } = await reader(true);
    prisma.lessonFlag.findMany.mockResolvedValue([{ flaggedById: 'u-2', reason: 'stale' }]);
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}/flags`,
    });
    expect(res.json().data).toEqual({ cleared: 1 });
    expect(prisma.lessonFlag.deleteMany).toHaveBeenCalledWith({
      where: { memoryItemId: LESSON_ID },
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: { event: 'lesson.flags_cleared' },
        beforeJson: { flags: [{ flaggedById: 'u-2', reason: 'stale' }] },
      }),
    });
  });

  it('refuses to clear flags for someone who only reads the lesson', async () => {
    const { app, prisma } = await reader(false);
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/lessons/${LESSON_ID}/flags`,
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.lessonFlag.deleteMany).not.toHaveBeenCalled();
  });

  describe('in the list', () => {
    const flaggedLesson = {
      _count: { flags: 2 },
      flags: [
        {
          createdAt: '2026-10-01T00:00:00.000Z',
          flaggedBy: { email: 'a@x.test' },
          flaggedById: 'u-a',
          reason: 'outdated',
        },
        {
          createdAt: '2026-10-02T00:00:00.000Z',
          flaggedBy: { email: 'me@x.test' },
          flaggedById: 'admin-1',
          reason: 'mine',
        },
      ],
      id: LESSON_ID,
      lessonSummary: 's',
      repository: { id: REPO_ID, organizationName: 'acme', repoName: 'api' },
    };

    it('narrows to flagged lessons on request', async () => {
      const { app, prisma } = await buildApp('ENGINEER');
      await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons?flagged=true' });
      expect(lastListWhere(prisma).flags).toEqual({ some: {} });
    });

    it('shows a reader the count and their own flag, never who else flagged or why', async () => {
      const { app, prisma } = await buildApp('ENGINEER');
      prisma.memoryItem.findMany.mockResolvedValue([flaggedLesson]);
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
      const [row] = res.json().data;
      expect(row.flagCount).toBe(2);
      expect(row.myFlag).toMatchObject({ reason: 'mine' });
      expect(row.flags).toBeUndefined();
      expect(row._count).toBeUndefined();
    });

    it('shows the reasons to a lead of the repository team', async () => {
      const { app, prisma } = await buildApp('ENGINEER');
      prisma.memoryItem.findMany.mockResolvedValue([flaggedLesson]);
      prisma.connection.findMany.mockResolvedValue([{ id: REPO_ID }]);
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/lessons' });
      expect(res.json().data[0].flags).toEqual([
        { createdAt: '2026-10-01T00:00:00.000Z', email: 'a@x.test', reason: 'outdated' },
        { createdAt: '2026-10-02T00:00:00.000Z', email: 'me@x.test', reason: 'mine' },
      ]);
    });
  });
});
