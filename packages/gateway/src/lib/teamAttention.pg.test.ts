import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { TeamAttentionFailure } from '@auto-swe/shared/types/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamAttentionRoutes } from '../routes/teamAttention.js';

/**
 * The unowned-failures list against real Postgres: the list is a relational predicate (the desk's
 * visibility and scope terms, plus "has no assignment") that a mocked Prisma would not evaluate.
 *
 * Opt in with `TEAM_ATTENTION_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 *
 * One team with a lead (`lead`) and a member (`dev`). Two failed requests were launched by `gone`,
 * who is no longer on the team; `taken` is assigned to `dev` after the first read.
 */
const enabled = process.env.TEAM_ATTENTION_PG_TEST === '1';

describe.skipIf(!enabled)('team attention against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'WorkflowTemplate', 'Organization'],
      fn
    );
  const list = async () => {
    const res = await app.inject({
      headers: { authorization: `Bearer ${ids.lead}` },
      method: 'GET',
      url: `/api/v1/teams/${ids.team}/attention/failures`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { data: TeamAttentionFailure[] }).data.map((f) => f.runId);
  };

  async function failedRun(key: string) {
    const request = await prisma.runInput.create({
      data: {
        connectionId: ids.repo,
        description: `ta ${key} ${suffix}`,
        externalTicketId: `TA-${key}-${suffix}`,
        requestedById: ids.gone,
        requestPayload: '{}',
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        connectionId: ids.repo,
        endedAt: new Date(),
        launchedById: ids.gone,
        specSnapshot: {},
        startedAt: new Date(),
        status: 'FAILED',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: `wf-${key}-${suffix}`,
        workRequestId: request.id,
      },
    });
    ids[`run${key}`] = run.id;
  }

  beforeAll(async () => {
    for (const key of ['lead', 'dev', 'gone']) {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `ta-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
          },
        })
      ).id;
    }
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `ta-org-${suffix}`, slug: `ta-org-${suffix}` },
        })
      ).id;
      ids.team = (
        await prisma.team.create({
          data: { name: `ta-${suffix}`, orgId: ids.org, slug: `ta-${suffix}` },
        })
      ).id;
      ids.repo = (
        await prisma.connection.create({
          data: {
            organizationName: `ta-${suffix}`,
            repoName: 'repo',
            teamId: ids.team,
            type: 'git_repo',
          },
        })
      ).id;
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `ta-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
    });
    await prisma.teamMembership.create({
      data: { role: 'LEAD', teamId: ids.team, userId: ids.lead },
    });
    await prisma.teamMembership.create({ data: { teamId: ids.team, userId: ids.dev } });
    await failedRun('open');
    await failedRun('taken');

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9999999999,
        iat: 0,
        role: 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(teamAttentionRoutes, { prefix: '/api/v1/teams' });
    await app.ready();
  });

  afterAll(async () => {
    const people = ['lead', 'dev', 'gone'].map((k) => ids[k]).filter(Boolean);
    await prisma.workflowRun.deleteMany({ where: { templateId: ids.tpl } }); // cascades assignments
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.tpl } });
      await prisma.connection.deleteMany({ where: { id: ids.repo } });
      await prisma.team.deleteMany({ where: { id: ids.team } });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('lists a failure of a former member until it is assigned, then drops it', async () => {
    expect((await list()).sort()).toEqual([ids.runopen, ids.runtaken].sort());
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.dev,
        teamId: ids.team,
        workflowRunId: ids.runtaken,
      },
    });
    expect(await list()).toEqual([ids.runopen]);
  });

  it('allows one assignment per run', async () => {
    await expect(
      prisma.failureAssignment.create({
        data: {
          assignedById: ids.lead,
          assigneeId: ids.lead,
          teamId: ids.team,
          workflowRunId: ids.runtaken,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
