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

const approver = vi.hoisted(() => ({
  approver: { appId: '222' } as { appId: string } | null,
  platformAppId: '111' as string | null,
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubApproverAppConfig: vi.fn(async () => approver.approver),
  resolveGitHubConfig: vi.fn(async () => ({ appId: approver.platformAppId })),
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
  'prEvaluation.autoEvidenceMinChangedLines': 10,
  'prEvaluation.autoMergeAllowed': true,
  'prEvaluation.autoMinDistinctRequesters': 2,
  'prEvaluation.autoMinEvidence': 10,
  'prEvaluation.autoMinRepoEvidence': 5,
  'prEvaluation.botApprovalAllowed': true,
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
    prEvaluation: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
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

  /**
   * Evidence figures: the organization's qualifying and bad merges, and (by default the same) the
   * repository's, plus how many distinct requesters the qualifying merges came from.
   */
  function evidence(
    lowMerged: number,
    badMerges: number,
    over: { repoLow?: number; repoBad?: number; requesters?: number } = {}
  ) {
    ctx.prisma.prEvaluation.count.mockImplementation(
      async (args: { where: { badMerge?: boolean; connectionId?: string } }) => {
        const bad = args.where.badMerge === true;
        if (args.where.connectionId) {
          return bad ? (over.repoBad ?? badMerges) : (over.repoLow ?? lowMerged);
        }
        return bad ? badMerges : lowMerged;
      }
    );
    ctx.prisma.prEvaluation.groupBy.mockImplementation(async () =>
      Array.from({ length: over.requesters ?? 5 }, (_v, i) => ({ requesterId: `req-${i}` }))
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
    approver.approver = { appId: '222' };
    approver.platformAppId = '111';
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

  const repoRow = (mode: string | null = null, botApproval = false) => ({
    id: REPO,
    prEvaluationBotApproval: botApproval,
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

    it('reports both evidence scopes and each unmet condition when the gate is not met', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('advisory'));
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null);
      evidence(12, 0, { repoLow: 1, requesters: 1 });
      const body = (await get()).json().data.evidence;
      expect(body.satisfied).toBe(false);
      expect(body.deployment).toMatchObject({ distinctRequesters: 1, lowMerged: 12 });
      expect(body.repository).toMatchObject({ lowMerged: 1, minRepoEvidence: 5 });
      expect(body.unmet).toHaveLength(2);
      expect(JSON.stringify(body)).not.toContain('req-');
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
      expect(JSON.stringify(res.json())).not.toContain('req-');
      expect(res.json().data).toEqual({
        autoMergeAllowed: true,
        botApproval: { approverAppConfigured: true, enabled: false, globalAllowed: true },
        enabled: true,
        evidence: {
          deployment: {
            badMerges: 0,
            distinctRequesters: 5,
            lowMerged: 12,
            minDistinctRequesters: 2,
            minEvidence: 10,
          },
          minChangedLines: 10,
          repository: { badMerges: 0, lowMerged: 12, minRepoEvidence: 5 },
          satisfied: true,
          unmet: [],
          windowDays: 90,
        },
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

    it('reports the bot approval block as booleans only, with no App identity', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto', true));
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue(null);
      settings.values['prEvaluation.botApprovalAllowed'] = false;
      approver.approver = null;
      const body = (await get()).json().data;
      expect(body.botApproval).toEqual({
        approverAppConfigured: false,
        enabled: true,
        globalAllowed: false,
      });
      approver.approver = { appId: '222' };
      const again = await get();
      expect(again.json().data.botApproval.approverAppConfigured).toBe(true);
      expect(JSON.stringify(again.json())).not.toContain('222');
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
          data: { prEvaluationBotApproval: false, prEvaluationMode: mode },
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

    describe('enforce', () => {
      const READY_CTX = {
        requiredStatusContexts: ['auto-swe/pr-evaluation'],
        requiredStatusPinnedToApp: true,
      };
      function asLead(readiness: unknown) {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('advisory'));
        leadOfTeam(true);
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue(
          readiness === undefined ? null : { readiness }
        );
      }

      it('lets the owning-team LEAD set enforce, without any auto precondition', async () => {
        settings.values['prEvaluation.enabled'] = false;
        asLead(READY_CTX);
        const res = await put('enforce');
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update).toHaveBeenCalledWith({
          data: { prEvaluationBotApproval: false, prEvaluationMode: 'enforce' },
          select: { id: true },
          where: { id: REPO },
        });
        expect(res.json().data).toMatchObject({ mode: 'enforce', modeSource: 'repository' });
      });

      it('refuses a plain member and a LEAD of another team', async () => {
        expect((await put('enforce')).statusCode).toBe(403);
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
        leadOfTeam(false);
        expect((await put('enforce')).statusCode).toBe(403);
        expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
      });

      it('answers a non-member 404', async () => {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(null);
        expect((await put('enforce')).statusCode).toBe(404);
      });

      it('has no warning when the context is a required check', async () => {
        asLead(READY_CTX);
        expect((await put('enforce')).json().data.warnings).toEqual([]);
      });

      it.each([
        ['the context is not required', { requiredStatusContexts: ['ci/build'] }],
        ['the required checks are unknown', { requiredStatusContexts: 'unknown' }],
        ['the field is missing', {}],
        ['the readiness is not an object', 'junk'],
      ])('warns that nothing is enforced when %s', async (_name, readiness) => {
        asLead(readiness);
        const res = await put('enforce');
        expect(res.statusCode).toBe(200);
        const warnings: string[] = res.json().data.warnings;
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('auto-swe/pr-evaluation');
        expect(warnings[0]).toMatch(/nothing is enforced/i);
      });

      it.each([
        ['false', false],
        ['unknown', 'unknown'],
        ['missing', undefined],
      ])(
        'warns that the status is not pinned to the app when pinning is %s',
        async (_n, pinned) => {
          asLead({ ...READY_CTX, requiredStatusPinnedToApp: pinned });
          const warnings: string[] = (await put('enforce')).json().data.warnings;
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatch(/pinned/i);
          expect(warnings[0]).toMatch(/personal access token/i);
        }
      );

      it('warns that it is not known whether the status is required when nothing is recorded', async () => {
        asLead(undefined);
        const res = await put('enforce');
        expect(res.statusCode).toBe(200);
        const warnings: string[] = res.json().data.warnings;
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/no evaluation has run yet/i);
      });

      it('warns on a null (inherit) PUT when the resolved default mode is enforce', async () => {
        settings.values['prEvaluation.defaultMode'] = 'enforce';
        asLead({ requiredStatusContexts: [] });
        const res = await put(null);
        expect(res.json().data.warnings).toHaveLength(1);
        expect(res.json().data.warnings[0]).toMatch(/nothing is enforced/i);
      });

      it.each(['off', 'advisory'])(
        'has no warning on a null PUT when the resolved default mode is %s',
        async (mode) => {
          settings.values['prEvaluation.defaultMode'] = mode;
          asLead({ requiredStatusContexts: [] });
          expect((await put(null)).json().data.warnings).toEqual([]);
        }
      );

      it('has no warning for auto, whatever the readiness', async () => {
        ctx.authState.role = 'ADMIN';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('advisory'));
        ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
        evidence(10, 0);
        const res = await put('auto');
        expect(res.statusCode).toBe(200);
        expect(res.json().data.warnings).toEqual([]);
      });

      it('says plainly that nothing is enforced while evaluation is switched off', async () => {
        settings.values['prEvaluation.enabled'] = false;
        asLead(READY_CTX);
        const warnings: string[] = (await put('enforce')).json().data.warnings;
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('prEvaluation.enabled');
        expect(warnings[0]).toMatch(/nothing is evaluated/i);
      });

      it('says so on a null PUT inheriting enforce while evaluation is switched off', async () => {
        settings.values['prEvaluation.enabled'] = false;
        settings.values['prEvaluation.defaultMode'] = 'enforce';
        asLead(READY_CTX);
        const warnings: string[] = (await put(null)).json().data.warnings;
        expect(warnings.join(' ')).toContain('prEvaluation.enabled');
      });

      it('gives no warnings for another mode', async () => {
        asLead({ requiredStatusContexts: [] });
        expect((await put('advisory')).json().data.warnings).toEqual([]);
      });
    });

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

      it.each(['off', 'advisory', 'enforce', null] as const)(
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
        // The evidence read is a count and a groupBy; the sweep reads rows with findMany.
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

    it('lists every unmet evidence condition at once, and no requester id', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow());
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
      evidence(3, 1, { repoBad: 1, repoLow: 0, requesters: 1 });
      const res = await put('auto');
      expect(res.statusCode).toBe(400);
      const reasons: string[] = res.json().error.details.reasons;
      expect(reasons.filter((r) => /deployment-wide|this repository/.test(r))).toHaveLength(5);
      expect(JSON.stringify(res.json())).not.toContain('req-');
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
        [
          'there are too few low-risk merges',
          () => evidence(9, 0),
          'deployment-wide: 9 qualifying',
        ],
        ['a merge was marked bad', () => evidence(50, 1), 'deployment-wide: 1 low-risk merge'],
        [
          'this repository has too few merges',
          () => evidence(50, 0, { repoLow: 4 }),
          'this repository: 4 qualifying',
        ],
        [
          'this repository has a bad merge',
          () => evidence(50, 0, { repoBad: 1 }),
          'this repository: 1 low-risk merge',
        ],
        [
          'too few distinct requesters',
          () => evidence(50, 0, { requesters: 1 }),
          '1 distinct requester',
        ],
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

  describe('PUT bot approval', () => {
    const putBody = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        headers: AUTH,
        method: 'PUT',
        payload,
        url: `/api/v1/repositories/${REPO}/pr-evaluation`,
      });
    const reasonsOf = (res: { json: () => { error: { details: { reasons: string[] } } } }) =>
      res.json().error.details.reasons;

    function asAdmin(mode: string | null, botApproval = false) {
      ctx.authState.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(mode, botApproval));
      ctx.prisma.prEvaluation.findFirst.mockResolvedValue({ readiness: READY });
      evidence(50, 0);
    }

    it('needs at least one of mode and botApproval', async () => {
      ctx.authState.role = 'ADMIN';
      expect((await putBody({})).statusCode).toBe(400);
      expect((await putBody({ botApproval: 'yes' })).statusCode).toBe(400);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses turning it on to a team LEAD, naming the role rule, and writes nothing', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto'));
      leadOfTeam(true);
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BOT_APPROVAL_NOT_READY');
      expect(reasonsOf(res)).toContain('Only a platform admin may enable bot approval.');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('answers a lost race against the database check with a 409 and a fixed message, never a 500', async () => {
      asAdmin('auto');
      const lost = Object.assign(
        new Error(
          'new row for relation "connections" violates check constraint "connections_bot_approval_requires_auto_check"'
        ),
        { code: 'P2004' }
      );
      ctx.prisma.connection.update.mockRejectedValue(lost);
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PR_EVALUATION_CONFLICT');
      expect(res.payload).not.toContain('connections_bot_approval_requires_auto_check');
      expect(res.payload).not.toContain('relation');
    });

    it('still fails an unrelated database error', async () => {
      asAdmin('auto');
      ctx.prisma.connection.update.mockRejectedValue(new Error('connection reset'));
      expect((await putBody({ botApproval: true })).statusCode).toBe(500);
    });

    it('turns it on for an admin when every precondition holds, in one update', async () => {
      asAdmin('auto');
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.connection.update).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.connection.update.mock.calls[0][0].data).toEqual({
        prEvaluationBotApproval: true,
      });
      expect(res.json().data).toMatchObject({ botApproval: true, mode: 'auto' });
      expect(ctx.temporal.startPrEvaluationWorkflow).not.toHaveBeenCalled();
    });

    it.each([
      [
        'auto-merge is not allowed',
        () => {
          settings.values['prEvaluation.autoMergeAllowed'] = false;
        },
        'prEvaluation.autoMergeAllowed',
      ],
      [
        'bot approval is not allowed',
        () => {
          settings.values['prEvaluation.botApprovalAllowed'] = false;
        },
        'prEvaluation.botApprovalAllowed',
      ],
      [
        'the approver App is not configured',
        () => {
          approver.approver = null;
        },
        'approver GitHub App is not configured',
      ],
      [
        'the approver App is the platform App',
        () => {
          approver.approver = { appId: '111' };
        },
        'must be a different GitHub App',
      ],
    ])('refuses turning it on when %s', async (_name, arrange, text) => {
      asAdmin('auto');
      arrange();
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BOT_APPROVAL_NOT_READY');
      expect(reasonsOf(res)).toHaveLength(1);
      expect(reasonsOf(res)[0]).toContain(text);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('reports every unmet precondition together, and never an App id', async () => {
      asAdmin('advisory');
      settings.values['prEvaluation.autoMergeAllowed'] = false;
      settings.values['prEvaluation.botApprovalAllowed'] = false;
      approver.approver = { appId: '111' };
      const res = await putBody({ botApproval: true });
      expect(reasonsOf(res)).toHaveLength(4);
      expect(JSON.stringify(res.json())).not.toContain('111');
    });

    it('refuses it on a repository whose mode is advisory', async () => {
      asAdmin('advisory');
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(400);
      expect(reasonsOf(res).join('\n')).toContain('auto mode');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('refuses it together with a mode other than auto', async () => {
      asAdmin('auto');
      const res = await putBody({ botApproval: true, mode: 'enforce' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BOT_APPROVAL_NOT_READY');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('sets auto and bot approval in one update, and auto must itself be ready', async () => {
      asAdmin('advisory');
      const res = await putBody({ botApproval: true, mode: 'auto' });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.connection.update).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.connection.update.mock.calls[0][0].data).toEqual({
        prEvaluationBotApproval: true,
        prEvaluationMode: 'auto',
      });

      asAdmin('advisory');
      ctx.prisma.connection.update.mockClear();
      evidence(1, 0);
      const refused = await putBody({ botApproval: true, mode: 'auto' });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('AUTO_NOT_READY');
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
    });

    it('lets the owning-team LEAD turn it off with no precondition, and sweeps every open pull request', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto', true));
      leadOfTeam(true);
      settings.values['prEvaluation.botApprovalAllowed'] = false;
      approver.approver = null;
      ctx.prisma.prEvaluation.findMany
        .mockResolvedValueOnce([{ connectionId: REPO, prNumber: 5 }])
        .mockResolvedValueOnce([
          {
            autoMergeEnabled: false,
            closedAt: null,
            connectionId: REPO,
            mergedAt: null,
            prNumber: 5,
          },
        ]);
      const res = await putBody({ botApproval: false });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.connection.update.mock.calls[0][0].data).toEqual({
        prEvaluationBotApproval: false,
      });
      // Unarmed pull requests are swept too: the approval is withdrawn, not only auto-merge.
      expect(ctx.prisma.prEvaluation.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'autoMergeEnabled'
      );
      expect(ctx.temporal.startPrEvaluationWorkflow.mock.calls.map((c) => c[1])).toEqual([
        { connectionId: REPO, prNumber: 5, trigger: 'disarm-sweep' },
      ]);
    });

    it('does not sweep when it was already off, or when it is turned on', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto', false));
      leadOfTeam(true);
      expect((await putBody({ botApproval: false })).statusCode).toBe(200);
      expect(ctx.prisma.prEvaluation.findMany).not.toHaveBeenCalled();
      asAdmin('auto');
      expect((await putBody({ botApproval: true })).statusCode).toBe(200);
      expect(ctx.prisma.prEvaluation.findMany).not.toHaveBeenCalled();
    });

    it.each(['off', 'advisory', 'enforce', null] as const)(
      'forces it off in the same update when auto becomes %s',
      async (mode) => {
        ctx.authState.role = 'LEAD';
        ctx.prisma.connection.findFirst.mockResolvedValue(repoRow('auto', true));
        leadOfTeam(true);
        const res = await putBody({ mode });
        expect(res.statusCode).toBe(200);
        expect(ctx.prisma.connection.update).toHaveBeenCalledTimes(1);
        expect(ctx.prisma.connection.update.mock.calls[0][0].data).toEqual({
          prEvaluationBotApproval: false,
          prEvaluationMode: mode,
        });
        expect(res.json().data.botApproval).toBe(false);
        expect(ctx.prisma.prEvaluation.findMany).toHaveBeenCalled();
      }
    );

    it('never writes a state the CHECK constraint rejects', async () => {
      // The constraint: bot approval is false, or the mode is exactly 'auto'.
      const accepted = (
        data: { prEvaluationBotApproval?: boolean; prEvaluationMode?: unknown },
        before: ReturnType<typeof repoRow>
      ) => {
        const bot = data.prEvaluationBotApproval ?? before.prEvaluationBotApproval;
        const mode = 'prEvaluationMode' in data ? data.prEvaluationMode : before.prEvaluationMode;
        return bot === false || mode === 'auto';
      };
      const cases: Array<[string | null, boolean, Record<string, unknown>]> = [
        ['auto', true, { mode: 'off' }],
        ['auto', true, { mode: null }],
        ['auto', true, { botApproval: false, mode: 'enforce' }],
        ['auto', true, { mode: 'auto' }],
        ['auto', true, { botApproval: false }],
        ['advisory', false, { botApproval: true, mode: 'auto' }],
        ['advisory', false, { mode: 'advisory' }],
      ];
      for (const [mode, bot, payload] of cases) {
        ctx.prisma.connection.update.mockClear();
        asAdmin(mode, bot);
        const res = await putBody(payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(200);
        const before = repoRow(mode, bot);
        expect(accepted(ctx.prisma.connection.update.mock.calls[0][0].data, before)).toBe(true);
        resetSweepDebounceForTests();
      }
    });

    it('audits the old and new value of each field', async () => {
      asAdmin('advisory');
      expect((await putBody({ botApproval: true, mode: 'auto' })).statusCode).toBe(200);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        actorId: 'user-1',
        afterJson: { prEvaluationBotApproval: true, prEvaluationMode: 'auto' },
        beforeJson: { prEvaluationBotApproval: false, prEvaluationMode: 'advisory' },
        entityId: REPO,
        entityType: 'Connection',
      });
      ctx.prisma.configAuditLog.create.mockClear();
      asAdmin('auto', true);
      expect((await putBody({ botApproval: false })).statusCode).toBe(200);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
        afterJson: { prEvaluationBotApproval: false, prEvaluationMode: 'auto' },
        beforeJson: { prEvaluationBotApproval: true, prEvaluationMode: 'auto' },
      });
    });

    it('answers a non-member 404, not 403 or a readiness list', async () => {
      ctx.authState.role = 'LEAD';
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      const res = await putBody({ botApproval: true });
      expect(res.statusCode).toBe(404);
      expect(ctx.prisma.connection.update).not.toHaveBeenCalled();
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
