import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { epicRoutes, parseRepoIdsFromPayload } from './epics.js';

// ── Fixtures ──

const REPO_A = '00000000-0000-4000-8000-00000000000a'; // team-1 (user-1 is a member), org-1
const REPO_B = '00000000-0000-4000-8000-00000000000b'; // team-2 (user-1 is NOT a member), org-1
const REPO_C = '00000000-0000-4000-8000-00000000000c'; // team-3 (user-1 IS a member), org-3 (not an org member)
const REPO_D = '00000000-0000-4000-8000-00000000000d'; // team-4 (user-1 is a member), org-4 (over budget)

interface RepoFixture {
  id: string;
  organizationName: string;
  repoName: string;
  isActive: boolean;
  memberIds: string[];
  orgId: string;
  monthlyBudgetUsdCents: number | null;
}

interface ActiveWorkflowFixture {
  id: string;
  temporalWorkflowId: string;
  parentWorkflowId: string | null;
  repoId: string | null;
  currentStatus: string;
  assignedBranch: string | null;
  updatedAt: Date;
}

const repoFixtures: RepoFixture[] = [
  {
    id: REPO_A,
    isActive: true,
    memberIds: ['user-1'],
    monthlyBudgetUsdCents: null,
    organizationName: 'org',
    orgId: 'org-1',
    repoName: 'alpha',
  },
  {
    id: REPO_B,
    isActive: true,
    memberIds: [],
    monthlyBudgetUsdCents: null,
    organizationName: 'org',
    orgId: 'org-1',
    repoName: 'beta',
  },
  {
    id: REPO_C,
    isActive: true,
    memberIds: ['user-1'],
    monthlyBudgetUsdCents: null,
    organizationName: 'org',
    orgId: 'org-3',
    repoName: 'gamma',
  },
  {
    id: REPO_D,
    isActive: true,
    memberIds: ['user-1'],
    monthlyBudgetUsdCents: 1000,
    organizationName: 'org',
    orgId: 'org-4',
    repoName: 'delta',
  },
];

// org-1 and org-4 have user-1 as an org member; org-3 does not (non-member test).
const orgMembershipFixtures: Record<string, string[]> = {
  'org-1': ['user-1'],
  'org-4': ['user-1'],
};

// Keyed by `${orgId}:${yearMonth}` — populated per-test for the budget check.
let orgMonthlyUsageFixtures: Record<string, { costUsdAccrued: number }> = {};

describe('epic routes', () => {
  const app = Fastify();

  // Mutable per-test state
  let currentRole = 'LEAD';
  let currentSub = 'user-1';
  let activeWorkflowFixtures: ActiveWorkflowFixture[] = [];
  let workRequestFixtures: Array<Record<string, unknown>> = [];
  let epicStartShouldConflict = false;
  const startedEpicIds: string[] = [];
  const createdWorkRequests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        return { exp: 9999999999, iat: 0, role: currentRole, sub: currentSub };
      },
    } as unknown as never);

    const prismaMock = {
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        if (typeof arg === 'function') {
          return arg(prismaMock);
        }
        return undefined;
      },
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => {
          const row = {
            assignedBranch: null,
            currentStatus: 'STARTING',
            id: `aw-${activeWorkflowFixtures.length + 1}`,
            parentWorkflowId: null,
            repoId: null,
            temporalWorkflowId: args.data.temporalWorkflowId,
            updatedAt: new Date(),
            ...args.data,
          } as ActiveWorkflowFixture;
          activeWorkflowFixtures.push(row);
          return row;
        },
        delete: async (args: { where: { id: string } }) => {
          activeWorkflowFixtures = activeWorkflowFixtures.filter((w) => w.id !== args.where.id);
        },
        findMany: async (args: {
          where: {
            temporalWorkflowId?: { in?: string[]; startsWith?: string };
            OR?: Array<{
              parentWorkflowId?: string;
              temporalWorkflowId?: { startsWith: string };
            }>;
          };
        }) => {
          if (args.where.temporalWorkflowId?.in) {
            const ids = new Set(args.where.temporalWorkflowId.in);
            return activeWorkflowFixtures.filter((w) => ids.has(w.temporalWorkflowId));
          }
          if (args.where.OR) {
            const clauses = args.where.OR;
            return activeWorkflowFixtures.filter((w) =>
              clauses.some((c) =>
                c.parentWorkflowId !== undefined
                  ? w.parentWorkflowId === c.parentWorkflowId
                  : c.temporalWorkflowId?.startsWith !== undefined &&
                    w.temporalWorkflowId.startsWith(c.temporalWorkflowId.startsWith)
              )
            );
          }
          return [];
        },
        findUnique: async (args: { where: { temporalWorkflowId: string } }) =>
          activeWorkflowFixtures.find(
            (w) => w.temporalWorkflowId === args.where.temporalWorkflowId
          ) ?? null,
      },
      connection: {
        findMany: async (args: { where: { id?: { in: string[] }; team?: unknown } }) => {
          // Membership-scoped query (accessibleRepoIds helper)
          if (args.where.team) {
            return repoFixtures
              .filter((r) => r.memberIds.includes(currentSub))
              .map((r) => ({ id: r.id }));
          }
          const ids = new Set(args.where.id?.in ?? []);
          return repoFixtures
            .filter((r) => ids.has(r.id) && r.isActive)
            .map((r) => ({
              id: r.id,
              organizationName: r.organizationName,
              repoName: r.repoName,
              team: {
                memberships: r.memberIds.includes(currentSub) ? [{ userId: currentSub }] : [],
                organization: { id: r.orgId, monthlyBudgetUsdCents: r.monthlyBudgetUsdCents },
                orgId: r.orgId,
              },
            }));
        },
      },
      organizationMembership: {
        findUnique: async (args: {
          where: { userId_orgId: { orgId: string; userId: string } };
        }) => {
          const { orgId, userId } = args.where.userId_orgId;
          return (orgMembershipFixtures[orgId] ?? []).includes(userId) ? { orgId, userId } : null;
        },
      },
      orgMonthlyUsage: {
        findUnique: async (args: {
          where: { orgId_yearMonth: { orgId: string; yearMonth: string } };
        }) => {
          const { orgId } = args.where.orgId_yearMonth;
          const usage = orgMonthlyUsageFixtures[orgId];
          return usage ? { costUsdAccrued: usage.costUsdAccrued } : null;
        },
      },
      runInput: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdWorkRequests.push(args.data);
          return { ...args.data };
        },
        delete: async () => {
          createdWorkRequests.length = 0;
        },
        findFirst: async (args: { where: { externalTicketId: string } }) =>
          workRequestFixtures.find((wr) => wr.externalTicketId === args.where.externalTicketId) ??
          null,
        findMany: async () => workRequestFixtures,
      },
    };

    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      startEpicWorkflow: async (id: string) => {
        if (epicStartShouldConflict) {
          const err = new Error('already started');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }
        startedEpicIds.push(id);
      },
    } as unknown as never);

    await app.register(epicRoutes, { prefix: '/api/v1/epics' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    currentRole = 'LEAD';
    currentSub = 'user-1';
    activeWorkflowFixtures = [];
    workRequestFixtures = [];
    epicStartShouldConflict = false;
    startedEpicIds.length = 0;
    createdWorkRequests.length = 0;
    orgMonthlyUsageFixtures = {};
  });

  const auth = { authorization: 'Bearer test-token' };

  // ── POST / ──

  describe('POST /api/v1/epics', () => {
    const payload = {
      description: 'Cross-repo migration',
      externalTicketId: 'EPIC-1',
      repoIds: [REPO_A, REPO_B],
    };

    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.inject({ method: 'POST', payload, url: '/api/v1/epics' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 naming the inaccessible repo for a non-admin (PROD-12)', async () => {
      currentRole = 'LEAD'; // member of repo A's team, not repo B's
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload,
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('org/beta');
      expect(body.error.message).not.toContain('org/alpha');
      expect(startedEpicIds).toHaveLength(0);
      expect(createdWorkRequests).toHaveLength(0);
    });

    it('bypasses the team membership check for ADMIN', async () => {
      currentRole = 'ADMIN';
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload,
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.epicWorkflowId).toBe('epic-EPIC-1');
      expect(body.data.detailPath).toBe('/epics/epic-EPIC-1');
      expect(body.data.workRequestId).toBeDefined();
      expect(startedEpicIds).toEqual(['epic-EPIC-1']);
      expect(createdWorkRequests[0]).toMatchObject({
        externalTicketId: 'EPIC-1',
        isCrossRepo: true,
        requestedById: currentSub,
      });
    });

    it('allows a LEAD who is a member of every targeted repo team', async () => {
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload: { ...payload, repoIds: [REPO_A] },
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(201);
      expect(startedEpicIds).toEqual(['epic-EPIC-1']);
    });

    it('returns 404 when a repo does not exist or is inactive', async () => {
      currentRole = 'ADMIN';
      const missing = '00000000-0000-4000-8000-0000000000ff';
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload: { ...payload, repoIds: [REPO_A, missing] },
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('REPOS_NOT_FOUND');
    });

    it('returns 409 when the epic workflow is already running', async () => {
      currentRole = 'ADMIN';
      epicStartShouldConflict = true;
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload,
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('EPIC_ALREADY_EXISTS');
      expect(createdWorkRequests).toHaveLength(0);
    });

    it('returns 403 for a non-admin who is not a member of the repo org (P5)', async () => {
      // user-1 is on repo C's team, but not a member of org-3.
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload: { ...payload, repoIds: [REPO_C] },
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('You are not a member of this organization');
      expect(startedEpicIds).toHaveLength(0);
      expect(createdWorkRequests).toHaveLength(0);
    });

    it('returns 402 when the repo org has exceeded its monthly budget cap (P5)', async () => {
      // org-4 caps at 1000 cents ($10); accrued usage of $10.50 exceeds it.
      orgMonthlyUsageFixtures['org-4'] = { costUsdAccrued: 10.5 };
      const res = await app.inject({
        headers: auth,
        method: 'POST',
        payload: { ...payload, repoIds: [REPO_D] },
        url: '/api/v1/epics',
      });
      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.payload).error.code).toBe('ORG_BUDGET_EXCEEDED');
      expect(startedEpicIds).toHaveLength(0);
      expect(createdWorkRequests).toHaveLength(0);
    });
  });

  // ── GET / ──

  describe('GET /api/v1/epics', () => {
    beforeEach(() => {
      workRequestFixtures = [
        {
          createdAt: new Date('2026-06-01T00:00:00Z'),
          description: 'Epic on repo A',
          externalTicketId: 'EPIC-1',
          id: 'wr-1',
          isCrossRepo: true,
          requestedBy: null,
          requestPayload: JSON.stringify({ repoIds: [REPO_A] }),
        },
        {
          createdAt: new Date('2026-06-02T00:00:00Z'),
          description: 'Epic on repo B',
          externalTicketId: 'EPIC-2',
          id: 'wr-2',
          isCrossRepo: true,
          requestedBy: null,
          requestPayload: JSON.stringify({ repoIds: [REPO_B] }),
        },
      ];
      activeWorkflowFixtures = [
        {
          assignedBranch: null,
          currentStatus: 'FANNING_OUT',
          id: 'aw-epic-1',
          parentWorkflowId: null,
          repoId: null,
          temporalWorkflowId: 'epic-EPIC-1',
          updatedAt: new Date('2026-06-01T01:00:00Z'),
        },
        // No row for epic-EPIC-2 → STARTING
      ];
    });

    it('shows every epic to ADMIN, with status from the epic ActiveWorkflow row', async () => {
      currentRole = 'ADMIN';
      const res = await app.inject({ headers: auth, method: 'GET', url: '/api/v1/epics' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.total).toBe(2);
      const byTicket = Object.fromEntries(
        body.data.map((e: { externalTicketId: string }) => [e.externalTicketId, e])
      );
      expect(byTicket['EPIC-1']).toMatchObject({
        epicWorkflowId: 'epic-EPIC-1',
        repoCount: 1,
        status: 'FANNING_OUT',
      });
      expect(byTicket['EPIC-2']).toMatchObject({
        epicWorkflowId: 'epic-EPIC-2',
        status: 'STARTING',
      });
    });

    it('filters out epics with no repo on the requesting user team', async () => {
      currentRole = 'ENGINEER'; // user-1 is only a member of repo A's team
      const res = await app.inject({ headers: auth, method: 'GET', url: '/api/v1/epics' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].externalTicketId).toBe('EPIC-1');
    });
  });

  // ── GET /:workflowId ──

  describe('GET /api/v1/epics/:workflowId', () => {
    beforeEach(() => {
      workRequestFixtures = [
        {
          createdAt: new Date('2026-06-01T00:00:00Z'),
          description: 'Cross-repo migration',
          externalTicketId: 'EPIC-1',
          id: 'wr-1',
          isCrossRepo: true,
          requestedBy: { email: 'lead@x.io', id: 'user-1', name: 'Lead' },
          requestPayload: JSON.stringify({ repoIds: [REPO_A, REPO_B] }),
        },
      ];
      activeWorkflowFixtures = [
        {
          assignedBranch: null,
          currentStatus: 'FANNING_OUT',
          id: 'aw-epic-1',
          parentWorkflowId: null,
          repoId: null,
          temporalWorkflowId: 'epic-EPIC-1',
          updatedAt: new Date('2026-06-01T01:00:00Z'),
        },
        // Child for repo A — self-registered by updateDomainState, so repoId,
        // parentWorkflowId, and assignedBranch are all null; the repo is only
        // recoverable from the temporal ID suffix.
        {
          assignedBranch: null,
          currentStatus: 'IMPLEMENTING',
          id: 'aw-child-a',
          parentWorkflowId: null,
          repoId: null,
          temporalWorkflowId: `epic-EPIC-1-${REPO_A}`,
          updatedAt: new Date('2026-06-01T02:00:00Z'),
        },
        // Prefix-similar row from a DIFFERENT epic ticket (EPIC-1-hotfix) —
        // suffix is not a repo UUID, so it must not appear as a child.
        {
          assignedBranch: null,
          currentStatus: 'COMPLETED',
          id: 'aw-other',
          parentWorkflowId: null,
          repoId: null,
          temporalWorkflowId: 'epic-EPIC-1-hotfix',
          updatedAt: new Date('2026-06-01T03:00:00Z'),
        },
      ];
    });

    it('returns 404 for an unknown epic', async () => {
      currentRole = 'ADMIN';
      const res = await app.inject({
        headers: auth,
        method: 'GET',
        url: '/api/v1/epics/epic-NOPE',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns epic status plus per-repo children (started + pending)', async () => {
      currentRole = 'ADMIN';
      const res = await app.inject({
        headers: auth,
        method: 'GET',
        url: '/api/v1/epics/epic-EPIC-1',
      });
      expect(res.statusCode).toBe(200);
      const { data } = JSON.parse(res.payload);
      expect(data).toMatchObject({
        description: 'Cross-repo migration',
        epicWorkflowId: 'epic-EPIC-1',
        externalTicketId: 'EPIC-1',
        status: 'FANNING_OUT',
        workRequestId: 'wr-1',
      });
      expect(data.children).toHaveLength(2);
      const byRepo = Object.fromEntries(
        data.children.map((c: { repoId: string }) => [c.repoId, c])
      );
      // Started child: repoId parsed from the temporal ID suffix, DB UUID
      // exposed for the /workflows/<uuid> link.
      expect(byRepo[REPO_A]).toMatchObject({
        branch: null,
        organizationName: 'org',
        repoName: 'alpha',
        status: 'IMPLEMENTING',
        temporalWorkflowId: `epic-EPIC-1-${REPO_A}`,
        workflowId: 'aw-child-a',
      });
      // Requested repo with no child row yet renders as PENDING.
      expect(byRepo[REPO_B]).toMatchObject({
        repoName: 'beta',
        status: 'PENDING',
        temporalWorkflowId: null,
        workflowId: null,
      });
      // The prefix-similar row from another ticket is excluded.
      expect(
        data.children.some(
          (c: { temporalWorkflowId: string | null }) =>
            c.temporalWorkflowId === 'epic-EPIC-1-hotfix'
        )
      ).toBe(false);
    });

    it('is visible to a non-admin with at least one child repo on their team', async () => {
      currentRole = 'ENGINEER'; // user-1 is on repo A's team
      const res = await app.inject({
        headers: auth,
        method: 'GET',
        url: '/api/v1/epics/epic-EPIC-1',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 404 (not 403) to a non-admin with no repo on their team', async () => {
      currentRole = 'ENGINEER';
      currentSub = 'user-2'; // not a member of any team
      const res = await app.inject({
        headers: auth,
        method: 'GET',
        url: '/api/v1/epics/epic-EPIC-1',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('EPIC_NOT_FOUND');
    });
  });

  // ── helpers ──

  describe('parseRepoIdsFromPayload', () => {
    it('extracts repoIds from a well-formed payload', () => {
      expect(parseRepoIdsFromPayload(JSON.stringify({ repoIds: [REPO_A, REPO_B] }))).toEqual([
        REPO_A,
        REPO_B,
      ]);
    });

    it('returns [] for malformed or repo-less payloads', () => {
      expect(parseRepoIdsFromPayload('not json')).toEqual([]);
      expect(parseRepoIdsFromPayload('{}')).toEqual([]);
      expect(parseRepoIdsFromPayload(JSON.stringify({ repoIds: 'nope' }))).toEqual([]);
    });
  });
});
