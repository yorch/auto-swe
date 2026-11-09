import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { MeSummary } from '@auto-swe/shared/types/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanStepRoutes } from './humanSteps.js';
import { meRoutes } from './me.js';
import { requestWorkspaceRoutes } from './requestWorkspace.js';

/**
 * `GET /api/v1/me/summary` against real Postgres: the desk's counts, lists and team buckets are
 * relational predicates (control, visibility, the member-scope term) that a mocked Prisma would
 * not evaluate.
 *
 * Opt in with `ME_SUMMARY_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 *
 * Teams A, B and C. Repository A belongs to A and is shared to C; repository B belongs to B.
 * Repository A2 also belongs to A. Team D is deactivated, alice is on it, and it owns repository D.
 * alice and erin are on A, bob on B, carol on C (a sharee), and the platform ADMIN `root` is on B
 * only. Three actionable steps wait on alice's run on repository A.
 */
const enabled = process.env.ME_SUMMARY_PG_TEST === '1';

const STEPS_A = 3;
const STEPS_B = 2;

describe.skipIf(!enabled)('me summary against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'WorkflowTemplate', 'Organization'],
      fn
    );

  const call = (user: string, url: string) =>
    app.inject({ headers: { authorization: `Bearer ${ids[user]}` }, method: 'GET', url });
  const json = async <T>(user: string, url: string) => {
    const res = await call(user, url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as T;
  };
  const summary = (user: string) => json<MeSummary>(user, '/api/v1/me/summary');
  const stepTotal = async (user: string, query: string) =>
    (
      await json<{ meta: { total: number } }>(
        user,
        `/api/v1/human-steps?count=true&limit=1&${query}`
      )
    ).meta.total;
  const approvals = (s: MeSummary) =>
    s.needsYou.items.filter((i) => i.kind === 'approval' || i.kind === 'approval_due_soon');
  const keysOf = (s: MeSummary, kind: string) =>
    s.needsYou.items.filter((i) => i.kind === kind).map((i) => i.runId);

  async function request(
    key: string,
    repo: string,
    requester: string,
    ledger: string,
    crossRepo = false
  ) {
    const wr = await prisma.runInput.create({
      data: {
        connectionId: crossRepo ? null : ids[repo],
        description: `ms ${key} ${suffix}`,
        externalTicketId: `MS-${key}-${suffix}`,
        isCrossRepo: crossRepo,
        requestedById: ids[requester],
        requestPayload: '{}',
      },
    });
    await prisma.activeWorkflow.create({
      data: {
        currentStatus: ledger,
        repoId: ids[repo],
        temporalWorkflowId: `wf-${key}-${suffix}`,
        workRequestId: wr.id,
      },
    });
    ids[`wr${key}`] = wr.id;
    return wr.id;
  }

  async function attempt(opts: {
    key: string;
    launcher: string;
    repo: string;
    startedAt?: Date;
    status: 'RUNNING' | 'FAILED' | 'SUCCESS';
    workflowId?: string;
    workRequestId: string;
  }) {
    const run = await prisma.workflowRun.create({
      data: {
        connectionId: ids[opts.repo],
        launchedById: ids[opts.launcher],
        specSnapshot: {},
        startedAt: opts.startedAt ?? new Date(),
        status: opts.status,
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: opts.workflowId ?? `wf-${opts.key}-${suffix}`,
        workRequestId: opts.workRequestId,
      },
    });
    ids[`run${opts.key}`] = run.id;
    return run.id;
  }

  async function single(
    key: string,
    repo: string,
    requester: string,
    launcher: string,
    status: 'RUNNING' | 'FAILED' | 'SUCCESS',
    ledger = 'IMPLEMENTING'
  ) {
    const workRequestId = await request(key, repo, requester, ledger);
    return attempt({ key, launcher, repo, status, workRequestId });
  }

  async function steps(runKey: string, count: number, tag: string) {
    await prisma.workflowHumanStep.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        kind: 'APPROVAL' as const,
        nodeId: `node-${tag}-${i}`,
        requestedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
        runId: ids[`run${runKey}`],
        signalName: `sig-${tag}-${i}-${suffix}`,
        status: 'PENDING' as const,
        title: `step ${tag} ${i}`,
      })),
    });
  }

  beforeAll(async () => {
    for (const key of ['alice', 'bob', 'carol', 'erin', 'root']) {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `ms-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
            ...(key === 'root' ? { role: 'ADMIN' as const } : {}),
          },
        })
      ).id;
    }
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `ms-org-${suffix}`, slug: `ms-org-${suffix}` },
        })
      ).id;
      for (const key of ['a', 'b', 'c', 'd']) {
        ids[`team${key}`] = (
          await prisma.team.create({
            data: {
              isActive: key !== 'd',
              name: `ms-${key}-${suffix}`,
              orgId: ids.org,
              slug: `ms-${key}-${suffix}`,
            },
          })
        ).id;
      }
      for (const [key, team] of [
        ['a', 'a'],
        ['b', 'b'],
        ['a2', 'a'],
        ['d', 'd'],
      ] as const) {
        ids[`repo${key}`] = (
          await prisma.connection.create({
            data: {
              organizationName: `ms-${suffix}`,
              repoName: `repo-${key}`,
              teamId: ids[`team${team}`],
              type: 'git_repo',
            },
          })
        ).id;
      }
      // GLOBAL: a team-owned template would make its team see every run.
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `ms-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
    });
    for (const [team, user] of [
      ['teama', 'alice'],
      ['teama', 'erin'],
      ['teamb', 'bob'],
      ['teamb', 'root'],
      ['teamc', 'carol'],
      ['teamd', 'alice'],
    ] as const) {
      await prisma.teamMembership.create({ data: { teamId: ids[team], userId: ids[user] } });
    }
    await prisma.connectionTeamShare.create({
      data: { connectionId: ids.repoa, teamId: ids.teamc },
    });

    // Waiting on alice and erin (team A), and on bob and root (team B).
    await single('a', 'repoa', 'alice', 'alice', 'RUNNING');
    await steps('a', STEPS_A, 'a');
    await single('b', 'repob', 'bob', 'bob', 'RUNNING');
    await steps('b', STEPS_B, 'b');
    // alice launched it and it failed.
    await single('fa', 'repoa', 'alice', 'alice', 'FAILED');
    // alice requested it, erin launched the attempt that failed: alice controls it (team A) but
    // did not launch it.
    await single('fx', 'repoa', 'alice', 'erin', 'FAILED');
    // carol launched it on the repository shared to her team.
    await single('fc', 'repoa', 'carol', 'carol', 'FAILED');
    // The platform ADMIN launched it on a repository of a team they are not in.
    await single('fadm', 'repoa', 'root', 'root', 'FAILED');
    // A failure the same caller then retried successfully is no longer a failure.
    const retried = await request('rt', 'repoa', 'alice', 'IMPLEMENTING');
    await attempt({
      key: 'rt',
      launcher: 'alice',
      repo: 'repoa',
      startedAt: new Date(Date.now() - 60_000),
      status: 'FAILED',
      workRequestId: retried,
    });
    await attempt({
      key: 'rt2',
      launcher: 'alice',
      repo: 'repoa',
      status: 'SUCCESS',
      workflowId: `wf-rt-2-${suffix}`,
      workRequestId: retried,
    });
    // One multi-repository request, two failed attempts: erin's on repository A is the newer, so
    // it sorts first, and alice's on repository A2 must still reach alice's desk.
    const cross = await request('cx', 'repoa', 'alice', 'IMPLEMENTING', true);
    await attempt({
      key: 'cxe',
      launcher: 'erin',
      repo: 'repoa',
      status: 'FAILED',
      workflowId: `wf-cxe-${suffix}`,
      workRequestId: cross,
    });
    await attempt({
      key: 'cxa',
      launcher: 'alice',
      repo: 'repoa2',
      startedAt: new Date(Date.now() - 60_000),
      status: 'FAILED',
      workflowId: `wf-cxa-${suffix}`,
      workRequestId: cross,
    });
    // Work on a deactivated team: running, with an approval, and nobody's card counts it.
    await single('d', 'repod', 'alice', 'alice', 'RUNNING');
    await steps('d', 2, 'd');
    // A pull request awaiting a human merge, and a run that has not started work.
    await single('pm', 'repoa', 'alice', 'alice', 'RUNNING', 'AWAITING_HUMAN_MERGE');
    await single('qa', 'repoa', 'alice', 'alice', 'RUNNING', 'STARTING');

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler(
      (error: { statusCode?: number; code?: string; message: string }, _r, reply) =>
        reply
          .status(error.statusCode ?? 500)
          .send({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } })
    );
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9999999999,
        iat: 0,
        role: token === ids.root ? 'ADMIN' : 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(meRoutes, { prefix: '/api/v1/me' });
    await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
    await app.register(requestWorkspaceRoutes, { prefix: '/api/v1/workflow-runs' });
    await app.ready();
  });

  afterAll(async () => {
    const people = ['alice', 'bob', 'carol', 'erin', 'root'].map((k) => ids[k]).filter(Boolean);
    const repos = [ids.repoa, ids.repob, ids.repoa2, ids.repod].filter(Boolean);
    await prisma.workflowRun.deleteMany({ where: { templateId: ids.tpl } }); // cascades steps
    await prisma.activeWorkflow.deleteMany({ where: { repoId: { in: repos } } });
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.tpl } });
      await prisma.connection.deleteMany({ where: { id: { in: repos } } });
      await prisma.team.deleteMany({
        where: { id: { in: [ids.teama, ids.teamb, ids.teamc, ids.teamd].filter(Boolean) } },
      });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('counts approvals with the same predicate as the list behind them', async () => {
    for (const [user, expected] of [
      ['alice', STEPS_A],
      ['erin', STEPS_A],
      ['bob', STEPS_B],
      ['root', STEPS_B],
      ['carol', 0],
    ] as const) {
      const s = await summary(user);
      expect(approvals(s), user).toHaveLength(expected);
      expect(await stepTotal(user, 'actionable=true&mine=true'), user).toBe(expected);
    }
  });

  it('makes a platform ADMIN desk member-scoped, and the mine filter narrows their list', async () => {
    const s = await summary('root');
    expect(s.teams.map((t) => t.teamId)).toEqual([ids.teamb]);
    // The ADMIN's own failed run on team A's repository is outside their teams.
    expect(s.needsYou.items.map((i) => i.runId)).not.toContain(ids.runfadm);
    expect(s.needsYou.total).toBe(STEPS_B);
    // Unscoped, the ADMIN's list is the whole platform.
    expect(await stepTotal('root', 'actionable=true')).toBeGreaterThanOrEqual(STEPS_A + STEPS_B);
    expect(await stepTotal('root', 'actionable=true&mine=true')).toBe(STEPS_B);
  });

  it('lists a failure only for the person who launched the latest attempt', async () => {
    const alice = await summary('alice');
    // fa, and cxa: the failed attempt she launched in a request whose first failure is erin's.
    expect(keysOf(alice, 'failed_run').sort()).toEqual([ids.runfa, ids.runcxa].sort());
    expect(keysOf(alice, 'failed_run')).not.toContain(ids.runcxe);
    // alice controls and requested fx, but erin launched it.
    expect(keysOf(alice, 'failed_run')).not.toContain(ids.runfx);
    // The retried request succeeded, so its old failure is gone.
    expect(keysOf(alice, 'failed_run')).not.toContain(ids.runrt);
    expect(keysOf(await summary('erin'), 'failed_run').sort()).toEqual(
      [ids.runfx, ids.runcxe].sort()
    );
    expect(keysOf(await summary('carol'), 'failed_run')).toEqual([ids.runfc]);
  });

  it("excludes the owner's work a sharee team member cannot control", async () => {
    const carol = await summary('carol');
    expect(carol.needsYou.total).toBe(1);
    expect(carol.needsYou.items.map((i) => i.kind)).toEqual(['failed_run']);
    expect(keysOf(carol, 'pr_merge')).toEqual([]);
  });

  it('lists a pull request awaiting merge for the person who requested it', async () => {
    expect(keysOf(await summary('alice'), 'pr_merge')).toEqual([ids.runpm]);
    expect(keysOf(await summary('erin'), 'pr_merge')).toEqual([]);
  });

  it('lists each item once and totals what it lists', async () => {
    for (const user of ['alice', 'erin', 'bob', 'carol', 'root']) {
      const s = await summary(user);
      const keys = s.needsYou.items.map((i) => i.key);
      expect(new Set(keys).size, user).toBe(keys.length);
      expect(s.needsYou.total, user).toBe(keys.length);
    }
    expect((await summary('alice')).needsYou.total).toBe(STEPS_A + 3);
  });

  it('counts a team the way the team-scoped request list does', async () => {
    for (const [user, team] of [
      ['alice', 'teama'],
      ['carol', 'teamc'],
      ['bob', 'teamb'],
    ] as const) {
      const row = (await summary(user)).teams.find((t) => t.teamId === ids[team]);
      const active = await json<{ meta: { total: number } }>(
        user,
        `/api/v1/workflow-runs/requests?scope=TEAM&state=active&limit=100&teamId=${ids[team]}`
      );
      expect((row?.running ?? 0) + (row?.queued ?? 0), user).toBe(active.meta.total);
    }
    const alice = (await summary('alice')).teams.find((t) => t.teamId === ids.teama);
    // a, pm are running; qa has not started work.
    expect(alice).toMatchObject({ needsYou: STEPS_A + 3, queued: 1, running: 2 });
    // A shared repository's work is counted for the sharee team too.
    expect((await summary('carol')).teams[0]).toMatchObject({ needsYou: 1, queued: 1, running: 2 });
  });

  it('leaves work on a deactivated team off the desk, the cards and the mine list', async () => {
    const alice = await summary('alice');
    expect(alice.teams.map((t) => t.teamId)).not.toContain(ids.teamd);
    expect(alice.needsYou.items.map((i) => i.runId)).not.toContain(ids.rund);
    expect(alice.needsYou.total).toBe(STEPS_A + 3);
    // The approvals behind the desk count the same steps.
    expect(await stepTotal('alice', 'actionable=true&mine=true')).toBe(STEPS_A);
  });
});
