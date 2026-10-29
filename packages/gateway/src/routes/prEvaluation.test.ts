import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// repositories.ts (for `canManageTeamRepos`) needs `Prisma.DbNull` and `Role` from the barrel;
// mock it so the real PrismaClient is never constructed.
const ROLE = vi.hoisted(() => ({ ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' }) as const);
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  Prisma: { DbNull: { __sentinel: 'DbNull' } },
  Role: ROLE,
}));

const settings = vi.hoisted(() => ({
  ctx: [] as unknown[],
  values: {} as Record<string, unknown>,
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string, ctx: unknown) => {
    settings.ctx.push(ctx);
    return settings.values[key];
  }),
  resolveSettings: vi.fn(async (keys: string[], ctx: unknown) => {
    settings.ctx.push(ctx);
    return Object.fromEntries(keys.map((k) => [k, settings.values[k]]));
  }),
}));

import { resetSweepDebounceForTests } from '../lib/prEvaluationSweep.js';
import { prEvaluationRoutes } from './prEvaluation.js';

interface AuthState {
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  sub: string;
}

const REPO = '11111111-1111-4111-8111-111111111111';
const TEAM = 'aaaaaaaa-1111-4111-8111-111111111111';
const EVAL = '33333333-3333-4333-8333-333333333333';
const AUTH = { authorization: 'Bearer fake' };

/** A readiness record every arming rule is satisfied by. */
const READY = {
  allowsAutoMerge: true,
  requiredStatusContexts: ['auto-swe/pr-evaluation'],
  requiredStatusPinnedToApp: true,
  requiresReviews: true,
  statusPublished: { ok: true },
};

const DEFAULTS: Record<string, unknown> = {
  'prEvaluation.autoMergeAllowed': true,
  'prEvaluation.autoMinEvidence': 10,
  'prEvaluation.defaultMode': 'advisory',
  'prEvaluation.enabled': true,
  'prEvaluation.highApprovers': 2,
  'prEvaluation.highLines': 1000,
  'prEvaluation.lowApprovers': 1,
  'prEvaluation.maxLowDirs': 5,
  'prEvaluation.maxLowFiles': 15,
  'prEvaluation.maxLowLines': 400,
  'prEvaluation.requiredStatusContext': 'auto-swe/pr-evaluation',
  'prEvaluation.sensitivePaths': [],
  'prEvaluation.standardApprovers': 1,
};

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const authState: AuthState = { role: 'ENGINEER', sub: 'user-1' };
  const prisma = {
    configAuditLog: { create: vi.fn() },
    connection: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    prEvaluation: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
  };
  const temporal = { startPrEvaluationWorkflow: vi.fn() };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', temporal as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  } as unknown as never);
  await app.register(prEvaluationRoutes, { prefix: '/api/v1' });
  await app.ready();
  return { app, authState, prisma, temporal };
}

describe('pr evaluation routes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());

  /** Evidence counts: first call is low merged, second is the bad merges. */
  function evidence(lowMerged: number, badMerges: number) {
    ctx.prisma.prEvaluation.count.mockImplementation(
      async (args: { where: { badMerge?: boolean } }) =>
        args.where.badMerge ? badMerges : lowMerged
    );
  }
  function leadOfTeam(yes: boolean) {
    ctx.prisma.teamMembership.findUnique.mockResolvedValue(
      yes ? { role: 'LEAD', team: { isActive: true } } : null
    );
  }

  beforeEach(() => {
    resetSweepDebounceForTests();
    ctx.authState.role = 'ENGINEER';
    ctx.authState.sub = 'user-1';
    settings.values = { ...DEFAULTS };
    settings.ctx.length = 0;
    for (const model of Object.values(ctx.prisma)) {
      for (const fn of Object.values(model)) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    ctx.temporal.startPrEvaluationWorkflow.mockReset();
    ctx.prisma.prEvaluation.findMany.mockResolvedValue([]);
    ctx.prisma.connection.update.mockResolvedValue({ id: REPO });
    evidence(0, 0);
  });

  const repoRow = (mode: string | null = null) => ({
    id: REPO,
    prEvaluationMode: mode,
    team: { orgId: 'org-1' },
    teamId: TEAM,
    type: 'git_repo',
  });

  describe('GET /repositories/:id/pr-evaluation', () => {
    const get = () =>
      ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/repositories/${REPO}/pr-evaluation`,
      });

    it('is 404 for a repository the caller cannot reach, and asks with the reach predicate', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      const res = await get();
      expect(res.statusCode).toBe(404);
      const where = ctx.prisma.connection.findFirst.mock.calls[0][0].where;
      expect(where.id).toBe(REPO);
      expect(where.AND).toBeDefined();
    });

    it('does not add the reach predicate for a platform admin', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      await get();
      expect(ctx.prisma.connection.findFirst.mock.calls[0][0].where.AND).toBeUndefined();
    });

    it('returns the effective policy, the last evaluation and the evidence', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto'));
      const last = {
        autoMergeEnabled: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        headSha: 'abc',
        id: EVAL,
        prNumber: 7,
        readiness: { allowsAutoMerge: true },
        reasons: [],
        requiredApprovers: 1,
        riskClass: 'LOW',
        statusState: 'success',
      };
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue(last);
      evidence(12, 0);
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        autoMergeAllowed: true,
        enabled: true,
        evidence: { badMerges: 0, lowMerged: 12, minEvidence: 10, satisfied: true, windowDays: 90 },
        lastEvaluation: last,
        mode: 'auto',
        modeSource: 'repository',
        requiredStatusContext: 'auto-swe/pr-evaluation',
        thresholds: {
          highApprovers: 2,
          highLines: 1000,
          lowApprovers: 1,
          maxLowDirs: 5,
          maxLowFiles: 15,
          maxLowLines: 400,
          sensitivePaths: [],
          standardApprovers: 1,
        },
      });
      expect(settings.ctx).toContainEqual({ orgId: 'org-1', teamId: TEAM });
    });

    it('reports the default mode when the repository has not chosen one', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null);
      const body = (await get()).json().data;
      expect(body).toMatchObject({ lastEvaluation: null, mode: 'advisory', modeSource: 'default' });
    });
  });

  describe('PUT /repositories/:id/pr-evaluation', () => {
    const put = (mode: string | null) =>
      ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload: { mode },
        url: `/api/v1/repositories/${REPO}/pr-evaluation`,
      });

    it('refuses a plain member', async () => {
      const res = await put('advisory');
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses a LEAD who does not lead the owning team', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
      leadOfTeam(false);
      const res = await put('off');
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('is 404 for an unknown repository', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      expect((await put('off')).statusCode).toBe(404);
    });

    it.each(['advisory', 'off', null] as const)(
      'lets the owning-team LEAD set %s',
      async (mode) => {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('advisory'));
        leadOfTeam(true);
        const res = await put(mode);
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update).toHaveBeenCalledWith({
          data: { prEvaluationMode: mode },
          select: { id: true },
          where: { id: REPO },
        });
        expect(ctx.prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
          action: 'UPDATE',
          actorId: 'user-1',
          afterJson: { prEvaluationMode: mode },
          beforeJson: { prEvaluationMode: 'advisory' },
          entityId: REPO,
          entityType: 'Connection',
        });
      }
    );

    it('answers a non-member 404, not 403, so it cannot tell a repository exists', async () => {
      ctx.authState.role = 'LEAD';
      // The reach predicate finds nothing for a LEAD of another team.
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      leadOfTeam(false);
      const res = await put('off');
      expect(res.statusCode).toBe(404);
      const where = ctx.prisma.connection.findFirst.mock.calls[0][0].where;
      expect(where.id).toBe(REPO);
      expect(where.AND).toBeDefined();
      expect(ctx.prisma.teamMembership.findUnique).not.toHaveBeenCalled();
    });

    describe('disarming on leaving auto', () => {
      const armed = (n: number) =>
        Array.from({ length: n }, (_v, i) => ({ connectionId: REPO, prNumber: i + 1 }));
      const latestRows = (n: number) =>
        armed(n).map((r) => ({
          ...r,
          autoMergeEnabled: true,
          closedAt: null,
          mergedAt: null,
        }));
      function arrange(n: number) {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto'));
        leadOfTeam(true);
        ctx.prisma.prEvaluation.findMany
          .mockResolvedValueOnce(armed(n))
          .mockResolvedValueOnce(latestRows(n));
      }

      it.each(['off', 'advisory', null] as const)(
        'starts a disarm-sweep evaluation per armed pull request when auto becomes %s, and audits it',
        async (mode) => {
          arrange(2);
          expect((await put(mode)).statusCode).toBe(200);
          const calls = ctx.temporal.startPrEvaluationWorkflow.mock.calls;
          expect(calls.map((c) => c[1])).toEqual([
            { connectionId: REPO, prNumber: 1, trigger: 'disarm-sweep' },
            { connectionId: REPO, prNumber: 2, trigger: 'disarm-sweep' },
          ]);
          expect(calls[0][0]).toMatch(/^preval-11111111-1-[0-9a-f]{8}$/);
          const audits = ctx.prisma.configAuditLog.create.mock.calls.map((c) => c[0].data);
          expect(audits).toHaveLength(2);
          expect(audits[1]).toMatchObject({
            action: 'UPDATE',
            afterJson: { prEvaluationDisarmSweep: { pullRequests: 2 } },
            entityId: REPO,
            entityType: 'Connection',
          });
        }
      );

      it('does not sweep when the mode stays or becomes auto', async () => {
        ctx.authState.role = 'ADMIN';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto'));
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
        evidence(50, 0);
        expect((await put('auto')).statusCode).toBe(200);
        expect(ctx.prisma.prEvaluation.findMany).not.toHaveBeenCalled();
        expect(ctx.temporal.startPrEvaluationWorkflow).not.toHaveBeenCalled();
      });

      it('succeeds, and writes no sweep audit, when nothing is armed', async () => {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto'));
        leadOfTeam(true);
        expect((await put('off')).statusCode).toBe(200);
        expect(ctx.prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
      });

      it('does not start a second sweep for the same repository within a minute', async () => {
        arrange(2);
        expect((await put('off')).statusCode).toBe(200);
        expect(ctx.temporal.startPrEvaluationWorkflow).toHaveBeenCalledTimes(2);
        arrange(2);
        expect((await put('advisory')).statusCode).toBe(200);
        expect(ctx.temporal.startPrEvaluationWorkflow).toHaveBeenCalledTimes(2);
      });

      it('still answers 200 when one start fails, and the others start', async () => {
        arrange(3);
        ctx.temporal.startPrEvaluationWorkflow
          .mockRejectedValueOnce(new Error('temporal unreachable'))
          .mockResolvedValue(undefined);
        expect((await put('off')).statusCode).toBe(200);
        expect(ctx.temporal.startPrEvaluationWorkflow).toHaveBeenCalledTimes(3);
      });
    });

    it('refuses auto to a team LEAD, naming the role rule', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
      leadOfTeam(true);
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
      evidence(50, 0);
      const res = await put('auto');
      expect(res.statusCode).toBe(400);
      const error = res.json().error;
      expect(error.code).toBe('AUTO_NOT_READY');
      expect(error.details.reasons).toEqual(['Only a platform admin may set auto mode.']);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    describe('as a platform admin', () => {
      beforeEach(() => {
        ctx.authState.role = 'ADMIN';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
        evidence(50, 0);
      });

      it('may set auto when every precondition holds', async () => {
        const res = await put('auto');
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update.mock.calls[0][0].data).toEqual({
          prEvaluationMode: 'auto',
        });
        expect(settings.ctx).toContainEqual({ orgId: 'org-1', teamId: TEAM });
      });

      const latest = (readiness: unknown) =>
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness });

      it.each([
        [
          'the feature is off',
          () => {
            settings.values['prEvaluation.enabled'] = false;
          },
          'switched off',
        ],
        [
          'auto-merge is not allowed',
          () => {
            settings.values['prEvaluation.autoMergeAllowed'] = false;
          },
          'Auto-merge is not allowed',
        ],
        ['there are too few low-risk merges', () => evidence(9, 0), 'Not enough evidence'],
        ['a merge was marked bad', () => evidence(50, 1), 'Not enough evidence'],
        [
          'there is no evaluation yet',
          () => ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null),
          'no evaluation has run yet',
        ],
        [
          'the repository does not allow auto-merge',
          () => latest({ ...READY, allowsAutoMerge: false }),
          'does not allow auto-merge',
        ],
        [
          'whether the repository allows auto-merge is unknown',
          () => latest({ ...READY, allowsAutoMerge: 'unknown' }),
          'allows auto-merge is unknown',
        ],
        [
          'the status is not a required check',
          () => latest({ ...READY, requiredStatusContexts: ['ci/build'] }),
          'is not a required check',
        ],
        [
          'the required checks are unknown',
          () => latest({ ...READY, requiredStatusContexts: 'unknown' }),
          'required status checks of the base branch are unknown',
        ],
        [
          'the requirement is not pinned to an App',
          () => latest({ ...READY, requiredStatusPinnedToApp: false }),
          "not pinned to the platform's own GitHub App",
        ],
        [
          'whether the requirement is pinned is unknown',
          () => latest({ ...READY, requiredStatusPinnedToApp: undefined }),
          "is pinned to the platform's own GitHub App is unknown",
        ],
        [
          'the status was not published',
          () => latest({ ...READY, statusPublished: { ok: false } }),
          'commit status was not published',
        ],
        [
          'no status publication was recorded',
          () => latest({ ...READY, statusPublished: undefined }),
          'commit status was not published',
        ],
        ['readiness was never read', () => latest(null), 'does not allow auto-merge|unknown'],
      ])('refuses auto when %s, and says so', async (_name, arrange, text) => {
        arrange();
        const res = await put('auto');
        expect(res.statusCode).toBe(400);
        const error = res.json().error;
        expect(error.code).toBe('AUTO_NOT_READY');
        const reasons: string[] = error.details.reasons;
        expect(reasons.some((r) => new RegExp(text).test(r))).toBe(true);
        expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
      });

      it('reports every unmet precondition together', async () => {
        settings.values['prEvaluation.enabled'] = false;
        latest({ allowsAutoMerge: false, requiredStatusContexts: [] });
        const res = await put('auto');
        const reasons: string[] = res.json().error.details.reasons;
        expect(reasons.length).toBeGreaterThanOrEqual(5);
        expect(reasons.join('\n')).toContain('switched off');
        expect(reasons.join('\n')).toContain('does not allow auto-merge');
        expect(reasons.join('\n')).toContain('is not a required check');
        expect(reasons.join('\n')).toContain('commit status was not published');
      });

      it('sets a stricter mode without any precondition', async () => {
        settings.values['prEvaluation.enabled'] = false;
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null);
        expect((await put('advisory')).statusCode).toBe(200);
      });
    });
  });

  describe('GET /pr-evaluations', () => {
    const row = {
      autoMergeEnabled: false,
      badMerge: false,
      badMergeReason: null,
      baseBranch: 'main',
      brief: { markdown: 'hello brief' },
      closedAt: null,
      connection: { organizationName: 'acme', repoName: 'api' },
      connectionId: REPO,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      headSha: 'abc',
      id: EVAL,
      mergedAt: null,
      mode: 'advisory',
      prNumber: 7,
      reasons: [],
      requiredApprovers: 1,
      riskClass: 'LOW',
      statusState: 'success',
      triggeredBy: 'pull_request.opened',
    };

    it('lists newest first with the brief length only', async () => {
      ctx.prisma.prEvaluation.findMany.mockResolvedValue([row, { ...row, brief: {} }]);
      ctx.prisma.prEvaluation.count.mockResolvedValue(2);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/pr-evaluations?limit=10',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.meta).toEqual({ limit: 10, offset: 0, total: 2 });
      expect(body.data[0]).toMatchObject({ briefAvailable: true, briefMarkdownLength: 11 });
      expect(body.data[0].brief).toBeUndefined();
      expect(body.data[1]).toMatchObject({ briefAvailable: false, briefMarkdownLength: 0 });
      const args = ctx.prisma.prEvaluation.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.where.connection).toBeDefined();
    });

    it('applies filters, and no reach predicate to an admin', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.prEvaluation.findMany.mockResolvedValue([]);
      ctx.prisma.prEvaluation.count.mockResolvedValue(0);
      await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/pr-evaluations?repoId=${REPO}&riskClass=LOW&merged=true`,
      });
      expect(ctx.prisma.prEvaluation.findMany.mock.calls[0][0].where).toEqual({
        connectionId: REPO,
        mergedAt: { not: null },
        riskClass: 'LOW',
      });
    });

    it('does not filter on merge when merged is false or absent', async () => {
      ctx.prisma.prEvaluation.findMany.mockResolvedValue([]);
      ctx.prisma.prEvaluation.count.mockResolvedValue(0);
      await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/pr-evaluations?merged=false',
      });
      expect(ctx.prisma.prEvaluation.findMany.mock.calls[0][0].where.mergedAt).toBeUndefined();
    });

    it('rejects a malformed boolean and an unknown risk class', async () => {
      for (const query of ['merged=yes', 'riskClass=EXTREME']) {
        const res = await ctx.app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/pr-evaluations?${query}`,
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('GET /pr-evaluations/:id', () => {
    it('returns the full row, brief included', async () => {
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ brief: { markdown: 'x' }, id: EVAL });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/pr-evaluations/${EVAL}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.brief).toEqual({ markdown: 'x' });
      expect(ctx.prisma.prEvaluation.findFirst.mock.calls[0][0].where.connection).toBeDefined();
    });

    it('is 404 when the row is outside the caller reach', async () => {
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/pr-evaluations/${EVAL}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
