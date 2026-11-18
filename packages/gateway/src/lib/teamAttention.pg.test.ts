import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { TeamAttentionFailure } from '@auto-swe/shared/types/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { teamAttentionRoutes } from '../routes/teamAttention.js';

/**
 * The unowned-failures list against real Postgres: the list is a relational predicate (the desk's
 * visibility terms, owner attribution, active membership and "has no live assignment") that a
 * mocked Prisma would not evaluate.
 *
 * Opt in with `TEAM_ATTENTION_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 *
 * Fixtures shared by every test and never changed: an `owner` team (a lead, an engineer `dev`, and
 * `idle`, a member whose user is deactivated) owning `repo`, and a `sharee` team (its own lead)
 * that `repo` is shared to. `gone` is a user on no team. Each test creates the runs it reads and
 * the memberships it changes, and `afterEach` removes them, so no test depends on another.
 */
const enabled = process.env.TEAM_ATTENTION_PG_TEST === '1';

describe.skipIf(!enabled)('team attention against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;
  let runCounter = 0;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'ConnectionTeamShare', 'WorkflowTemplate', 'Organization'],
      fn
    );
  const as = (userId: string) => ({ authorization: `Bearer ${userId}` });
  const list = async (teamId: string, asUser: string) => {
    const res = await app.inject({
      headers: as(asUser),
      method: 'GET',
      url: `/api/v1/teams/${teamId}/attention/failures`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { data: TeamAttentionFailure[] }).data;
  };
  const ownerList = async () => (await list(ids.owner, ids.lead)).map((f) => f.runId);
  const assign = (teamId: string, asUser: string, assigneeId: string, runId: string) =>
    app.inject({
      headers: as(asUser),
      method: 'POST',
      payload: { assigneeId, runId },
      url: `/api/v1/teams/${teamId}/failure-assignments`,
    });
  const assignmentsOf = (runId: string) =>
    prisma.failureAssignment.findMany({
      select: { assigneeId: true },
      where: { teamId: ids.owner, workflowRunId: runId },
    });

  /** A failed run owned by the owner team, launched by `launchedById` (null for automation). */
  async function failedRun(launchedById: string | null): Promise<string> {
    runCounter += 1;
    const key = `${runCounter}-${suffix}`;
    const request = await prisma.runInput.create({
      data: {
        connectionId: ids.repo,
        description: `ta ${key}`,
        externalTicketId: `TA-${key}`,
        requestedById: ids.gone,
        requestPayload: '{}',
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        attributedTeamId: ids.owner,
        connectionId: ids.repo,
        endedAt: new Date(),
        launchedById,
        specSnapshot: {},
        startedAt: new Date(),
        status: 'FAILED',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: `wf-${key}`,
        workRequestId: request.id,
      },
    });
    return run.id;
  }

  async function makeUser(key: string, isActive = true) {
    ids[key] = (
      await prisma.user.create({
        data: {
          email: `ta-${key}-${suffix}@example.test`,
          emailVerified: true,
          isActive,
          name: key,
        },
      })
    ).id;
  }

  beforeAll(async () => {
    await makeUser('lead');
    await makeUser('dev');
    await makeUser('idle', false);
    await makeUser('gone');
    await makeUser('temp');
    await makeUser('shareeLead');
    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `ta-org-${suffix}`, slug: `ta-org-${suffix}` },
        })
      ).id;
      ids.owner = (
        await prisma.team.create({
          data: { name: `ta-${suffix}`, orgId: ids.org, slug: `ta-${suffix}` },
        })
      ).id;
      ids.sharee = (
        await prisma.team.create({
          data: { name: `ta-sh-${suffix}`, orgId: ids.org, slug: `ta-sh-${suffix}` },
        })
      ).id;
      ids.repo = (
        await prisma.connection.create({
          data: {
            organizationName: `ta-${suffix}`,
            repoName: 'repo',
            teamId: ids.owner,
            type: 'git_repo',
          },
        })
      ).id;
      await prisma.connectionTeamShare.create({
        data: { connectionId: ids.repo, teamId: ids.sharee },
      });
      ids.tpl = (
        await prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `ta-tpl-${suffix}`, status: 'ACTIVE' },
        })
      ).id;
    });
    await prisma.teamMembership.create({
      data: { role: 'LEAD', teamId: ids.owner, userId: ids.lead },
    });
    await prisma.teamMembership.create({ data: { teamId: ids.owner, userId: ids.dev } });
    await prisma.teamMembership.create({ data: { teamId: ids.owner, userId: ids.idle } });
    await prisma.teamMembership.create({
      data: { role: 'LEAD', teamId: ids.sharee, userId: ids.shareeLead },
    });

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

  afterEach(async () => {
    // Runs cascade their assignments; memberships a test added are removed here.
    await prisma.workflowRun.deleteMany({ where: { templateId: ids.tpl } });
    await prisma.runInput.deleteMany({ where: { connectionId: ids.repo } });
    await prisma.teamMembership.deleteMany({ where: { teamId: ids.owner, userId: ids.temp } });
    await prisma.user.updateMany({ data: { isActive: true }, where: { id: ids.dev } });
  });

  afterAll(async () => {
    const people = ['lead', 'dev', 'idle', 'gone', 'temp', 'shareeLead']
      .map((k) => ids[k])
      .filter(Boolean);
    await prisma.workflowRun.deleteMany({ where: { templateId: ids.tpl } });
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await prisma.configAuditLog.deleteMany({ where: { actorId: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: ids.tpl } });
      await prisma.connection.deleteMany({ where: { id: ids.repo } });
      await prisma.team.deleteMany({ where: { id: { in: [ids.owner, ids.sharee] } } });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('lists a failure of a former member until it is assigned, then drops it', async () => {
    const open = await failedRun(ids.gone);
    const taken = await failedRun(ids.gone);
    expect((await ownerList()).sort()).toEqual([open, taken].sort());
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.dev,
        teamId: ids.owner,
        workflowRunId: taken,
      },
    });
    expect(await ownerList()).toEqual([open]);
  });

  it('allows one assignment per run', async () => {
    const run = await failedRun(ids.gone);
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.dev,
        teamId: ids.owner,
        workflowRunId: run,
      },
    });
    await expect(
      prisma.failureAssignment.create({
        data: {
          assignedById: ids.lead,
          assigneeId: ids.lead,
          teamId: ids.owner,
          workflowRunId: run,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does not call a run on a repository merely shared to a team unowned for that team', async () => {
    const run = await failedRun(ids.gone);
    expect(await ownerList()).toEqual([run]);
    expect(await list(ids.sharee, ids.shareeLead)).toEqual([]);
    // The sharee's lead cannot claim the owner's run either.
    const res = await assign(ids.sharee, ids.shareeLead, ids.shareeLead, run);
    expect(res.statusCode, res.body).toBe(409);
    expect(await assignmentsOf(run)).toEqual([]);
  });

  it('calls a failure launched by automation unowned and says so', async () => {
    const run = await failedRun(null);
    const failures = await list(ids.owner, ids.lead);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      formerLauncherName: null,
      launchedByAutomation: true,
      runId: run,
    });
  });

  it('calls a failure launched by a deactivated member unowned, and by an active one owned', async () => {
    const byInactive = await failedRun(ids.idle);
    await failedRun(ids.dev);
    const failures = await list(ids.owner, ids.lead);
    expect(failures.map((f) => f.runId)).toEqual([byInactive]);
    expect(failures[0]?.launchedByAutomation).toBe(false);
  });

  it('makes a run unowned again when its assignee is removed from the team', async () => {
    const run = await failedRun(ids.gone);
    await prisma.teamMembership.create({ data: { teamId: ids.owner, userId: ids.temp } });
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.temp,
        teamId: ids.owner,
        workflowRunId: run,
      },
    });
    expect(await ownerList()).toEqual([]);
    await prisma.teamMembership.delete({
      where: { userId_teamId: { teamId: ids.owner, userId: ids.temp } },
    });
    expect(await ownerList()).toEqual([run]);
  });

  it('makes a run unowned again when its assignee is deactivated', async () => {
    const run = await failedRun(ids.gone);
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.dev,
        teamId: ids.owner,
        workflowRunId: run,
      },
    });
    expect(await ownerList()).toEqual([]);
    await prisma.user.update({ data: { isActive: false }, where: { id: ids.dev } });
    expect(await ownerList()).toEqual([run]);
  });

  it('replaces a lapsed assignment, refuses a live one and an inactive assignee', async () => {
    const run = await failedRun(ids.gone);
    // A lapsed assignment: its assignee (the deactivated member) is no longer active.
    await prisma.failureAssignment.create({
      data: {
        assignedById: ids.lead,
        assigneeId: ids.idle,
        teamId: ids.owner,
        workflowRunId: run,
      },
    });
    expect(await ownerList()).toEqual([run]);

    const toInactive = await assign(ids.owner, ids.lead, ids.idle, run);
    expect(toInactive.statusCode, toInactive.body).toBe(422);

    const replaced = await assign(ids.owner, ids.lead, ids.dev, run);
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(await assignmentsOf(run)).toEqual([{ assigneeId: ids.dev }]);
    expect(await ownerList()).toEqual([]);

    const again = await assign(ids.owner, ids.lead, ids.lead, run);
    expect(again.statusCode, again.body).toBe(409);
    expect(await assignmentsOf(run)).toEqual([{ assigneeId: ids.dev }]);
  });
});
