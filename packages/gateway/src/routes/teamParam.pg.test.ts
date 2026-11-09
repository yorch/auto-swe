import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanStepRoutes } from './humanSteps.js';
import { pullRequestRoutes } from './pullRequests.js';
import { requestWorkspaceRoutes } from './requestWorkspace.js';

/**
 * The `teamId` filter, the human-step count and the control-only attention state against real
 * Postgres: each is a relational predicate ANDed with visibility or control, which a mocked Prisma
 * would not evaluate.
 *
 * Opt in with `TEAM_SCOPE_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 *
 * Teams A, B and C. Repository A belongs to team A and is shared to team C; repository B belongs
 * to team B. alice is on A, bob on B, carol on C. alice launched the runs on repository A, so she
 * controls their steps; carol sees them through the share and does not.
 */
const enabled = process.env.TEAM_SCOPE_PG_TEST === '1';

/** More pending steps than the list's default page, so a count that rode the page would be wrong. */
const ACTIONABLE_STEPS = 105;

describe.skipIf(!enabled)('team scope against Postgres', () => {
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
  const get = async <T>(user: string, url: string) => {
    const res = await call(user, url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { data: T[]; meta?: { total: number } };
  };
  const requests = (user: string, query = '') =>
    get<{ id: string; pendingStepCount: number }>(
      user,
      `/api/v1/workflow-runs/requests?scope=TEAM&limit=100${query}`
    );
  const prs = (user: string, query = '') =>
    get<{ id: string }>(user, `/api/v1/pull-requests?scope=TEAM${query}`);
  const exported = async (user: string, query: string) => {
    const res = await call(
      user,
      `/api/v1/pull-requests/outcomes/export?format=ndjson&scope=TEAM${query}`
    );
    expect(res.statusCode, res.body).toBe(200);
    return res.body
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { pull_request_id: string }).pull_request_id);
  };

  async function workRequestRun(key: string, repo: string, owner: string, team: string) {
    const wr = await prisma.runInput.create({
      data: {
        connectionId: ids[repo],
        description: `ts ${key} ${suffix}`,
        externalTicketId: `TS-${key}-${suffix}`,
        requestedById: ids[owner],
        requestPayload: '{}',
      },
    });
    const ledger = await prisma.activeWorkflow.create({
      data: {
        currentStatus: 'RUNNING',
        repoId: ids[repo],
        temporalWorkflowId: `wf-${key}-${suffix}`,
        workRequestId: wr.id,
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        attributedTeamId: ids[team],
        connectionId: ids[repo],
        launchedById: ids[owner],
        specSnapshot: {},
        status: 'RUNNING',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: ledger.temporalWorkflowId,
        workRequestId: wr.id,
      },
    });
    const pr = await prisma.pullRequest.create({
      data: {
        headSha: key,
        prNumber: key === 'a' ? 1 : 2,
        repoId: ids[repo],
        runId: run.id,
        status: 'OPEN',
        title: `ts ${key}`,
        workflowId: ledger.id,
      },
    });
    ids[`run${key}`] = run.id;
    ids[`pr${key}`] = pr.id;
    ids[`wr${key}`] = wr.id;
  }

  beforeAll(async () => {
    for (const key of ['alice', 'bob', 'carol', 'admin']) {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `ts-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
            ...(key === 'admin' ? { role: 'ADMIN' as const } : {}),
          },
        })
      ).id;
    }
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `ts-org-${suffix}`, slug: `ts-org-${suffix}` },
        })
      ).id;
      for (const key of ['a', 'b', 'c']) {
        ids[`team${key}`] = (
          await prisma.team.create({
            data: { name: `ts-${key}-${suffix}`, orgId: ids.org, slug: `ts-${key}-${suffix}` },
          })
        ).id;
      }
      for (const key of ['a', 'b']) {
        ids[`repo${key}`] = (
          await prisma.connection.create({
            data: {
              organizationName: `ts-${suffix}`,
              repoName: `repo-${key}`,
              teamId: ids[`team${key}`],
              type: 'git_repo',
            },
          })
        ).id;
      }
      // GLOBAL: a team-owned template would make its team see every run.
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `ts-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
    });
    await prisma.teamMembership.create({ data: { teamId: ids.teama, userId: ids.alice } });
    await prisma.teamMembership.create({ data: { teamId: ids.teamb, userId: ids.bob } });
    await prisma.teamMembership.create({ data: { teamId: ids.teamc, userId: ids.carol } });
    await prisma.connectionTeamShare.create({
      data: { connectionId: ids.repoa, teamId: ids.teamc },
    });

    await workRequestRun('a', 'repoa', 'alice', 'teama');
    await workRequestRun('b', 'repob', 'bob', 'teamb');

    await prisma.workflowHumanStep.createMany({
      data: Array.from({ length: ACTIONABLE_STEPS }, (_, i) => ({
        kind: 'APPROVAL' as const,
        nodeId: `node-${i}`,
        requestedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
        runId: ids.runa,
        signalName: `sig-${i}-${suffix}`,
        status: 'PENDING' as const,
        title: `step ${i} ${suffix}`,
      })),
    });

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
        role: token === ids.admin ? 'ADMIN' : 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(requestWorkspaceRoutes, { prefix: '/api/v1/workflow-runs' });
    await app.register(pullRequestRoutes, { prefix: '/api/v1/pull-requests' });
    await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
    await app.ready();
  });

  afterAll(async () => {
    const people = ['alice', 'bob', 'carol', 'admin'].map((k) => ids[k]).filter(Boolean);
    const repos = [ids.repoa, ids.repob].filter(Boolean);
    await prisma.pullRequest.deleteMany({ where: { repoId: { in: repos } } });
    await prisma.workflowRun.deleteMany({ where: { templateId: ids.tpl } }); // cascades steps
    await prisma.activeWorkflow.deleteMany({ where: { repoId: { in: repos } } });
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.tpl } });
      await prisma.connection.deleteMany({ where: { id: { in: repos } } });
      await prisma.team.deleteMany({
        where: { id: { in: [ids.teama, ids.teamb, ids.teamc].filter(Boolean) } },
      });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('only narrows: a team-filtered list is a subset of the unfiltered one', async () => {
    const all = (await requests('alice')).data.map((r) => r.id);
    const narrowed = (await requests('alice', `&teamId=${ids.teama}`)).data.map((r) => r.id);
    expect(narrowed.length).toBeGreaterThan(0);
    for (const id of narrowed) {
      expect(all).toContain(id);
    }
    const allPrs = (await prs('alice')).data.map((p) => p.id);
    for (const pr of (await prs('alice', `&teamId=${ids.teama}`)).data) {
      expect(allPrs).toContain(pr.id);
    }
    // Team B's work is outside alice's visibility, so even an admin-style filter cannot reach it.
    expect(allPrs).not.toContain(ids.prb);
  });

  it('answers 404 TEAM_NOT_FOUND for a team the caller is not in', async () => {
    for (const url of [
      `/api/v1/workflow-runs/requests?teamId=${ids.teamb}`,
      `/api/v1/pull-requests?teamId=${ids.teamb}`,
      `/api/v1/pull-requests/outcomes?teamId=${ids.teamb}`,
      `/api/v1/pull-requests/outcomes/export?teamId=${ids.teamb}`,
    ]) {
      const res = await call('alice', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('TEAM_NOT_FOUND');
    }
  });

  it('lets a platform ADMIN name any team', async () => {
    const res = await call('admin', `/api/v1/pull-requests?scope=TEAM&teamId=${ids.teamb}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data: { id: string }[] }).data.map((p) => p.id)).toContain(ids.prb);
  });

  it("lists a shared repository's work for the sharee team but does not count it in metrics", async () => {
    // List scope: owned or shared.
    expect((await prs('carol', `&teamId=${ids.teamc}`)).data.map((p) => p.id)).toContain(ids.pra);
    expect((await requests('carol', `&teamId=${ids.teamc}`)).data.map((r) => r.id)).toContain(
      ids.runa
    );
    // Metrics scope: the run is attributed to team A alone.
    expect(await exported('carol', `&teamId=${ids.teamc}`)).not.toContain(ids.pra);
    expect(await exported('alice', `&teamId=${ids.teama}`)).toContain(ids.pra);
  });

  it('counts every actionable step, not just the first page', async () => {
    const plain = await get<{ id: string }>('alice', '/api/v1/human-steps?actionable=true');
    expect(plain.data).toHaveLength(100);
    expect(plain.meta).toBeUndefined();
    const counted = await get<{ id: string }>(
      'alice',
      '/api/v1/human-steps?actionable=true&count=true&limit=1'
    );
    expect(counted.meta?.total).toBe(ACTIONABLE_STEPS);
    let seen = 0;
    for (let offset = 0; offset < ACTIONABLE_STEPS; offset += 50) {
      seen += (
        await get<{ id: string }>(
          'alice',
          `/api/v1/human-steps?actionable=true&limit=50&offset=${offset}`
        )
      ).data.length;
    }
    expect(seen).toBe(counted.meta?.total);
  });

  it('shows a shared-team member the steps without letting them control or count them', async () => {
    const visible = await get<{ id: string }>('carol', '/api/v1/human-steps?count=true&limit=1');
    expect(visible.meta?.total).toBe(ACTIONABLE_STEPS);
    const actionable = await get<{ id: string }>(
      'carol',
      '/api/v1/human-steps?actionable=true&count=true&limit=1'
    );
    expect(actionable.meta?.total).toBe(0);

    const mine = (await requests('alice')).data.find((r) => r.id === ids.runa);
    expect(mine?.pendingStepCount).toBe(ACTIONABLE_STEPS);
    const theirs = (await requests('carol', `&teamId=${ids.teamc}`)).data.find(
      (r) => r.id === ids.runa
    );
    expect(theirs?.pendingStepCount).toBe(0);
    // The request is not "needs attention" for carol, who cannot answer anything on it.
    const attention = (await requests('carol', `&teamId=${ids.teamc}&state=attention`)).data;
    expect(attention.map((r) => r.id)).not.toContain(ids.runa);
    expect((await requests('alice', '&state=attention')).data.map((r) => r.id)).toContain(ids.runa);
  });
});
