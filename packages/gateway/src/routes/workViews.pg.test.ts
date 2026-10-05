import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { PullRequestListItem, TicketGroup } from '@auto-swe/shared/types/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pullRequestRoutes } from './pullRequests.js';
import { ticketRoutes } from './tickets.js';

/**
 * `GET /pull-requests` and `GET /tickets` against real Postgres: what a list
 * returns, and above all what it leaves out, is decided by relational filters
 * that a mocked Prisma would not evaluate.
 *
 * Opt in with `WORK_VIEWS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 *
 * Two teams, each with a repository. Ticket TKT-1 has a request in each (a mixed group), so a
 * member of one team must see only their own request, run, PR and cost.
 */
const enabled = process.env.WORK_VIEWS_PG_TEST === '1';

describe.skipIf(!enabled)('pull-request and ticket views against Postgres', () => {
  let app: FastifyInstance;
  const suffix = crypto.randomBytes(4).toString('hex');
  const ids = {} as Record<string, string>;
  const ticket = (id: string) => `TKT-${id}-${suffix}`;

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      ['Team', 'Connection', 'WorkflowTemplate', 'Organization'],
      fn
    );

  const get = <T>(user: string, url: string) =>
    app
      .inject({ headers: { authorization: `Bearer ${ids[user]}` }, method: 'GET', url })
      .then((res) => {
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as { data: T[]; meta: { total: number } };
      });
  const tickets = (user: string, query = '') =>
    get<TicketGroup>(user, `/api/v1/tickets?scope=TEAM&search=${suffix}${query}`);
  const prs = (user: string, query = '') =>
    get<PullRequestListItem>(user, `/api/v1/pull-requests?scope=TEAM&${query}`);

  async function request(opts: {
    user: string;
    ticket: string;
    repo?: string;
    cost?: number;
    id?: string;
    createdAt?: Date;
    description?: string;
    synthetic?: boolean;
    connection?: string;
    crossRepo?: boolean;
  }) {
    const wr = await prisma.runInput.create({
      data: {
        connectionId: opts.connection ? ids[opts.connection] : undefined,
        createdAt: opts.createdAt,
        description: opts.description ?? `work ${suffix}`,
        externalTicketId: opts.ticket,
        id: opts.id,
        isCrossRepo: opts.crossRepo ?? false,
        requestedById: ids[opts.user],
        requestPayload: '{}',
        ticketIsSynthetic: opts.synthetic ?? false,
      },
    });
    const ledger = opts.repo
      ? await prisma.activeWorkflow.create({
          data: {
            costUsdAccrued: opts.cost ?? 0,
            currentStatus: 'RUNNING',
            repoId: ids[opts.repo],
            temporalWorkflowId: `wf-${wr.id}`,
            workRequestId: wr.id,
          },
        })
      : null;
    return { ledger, wr };
  }

  const run = (wr: string, status: 'SUCCESS' | 'FAILED' | 'RUNNING', template = 'tpl') =>
    prisma.workflowRun.create({
      data: {
        specSnapshot: {},
        status,
        templateId: ids[template],
        templateVersion: 1,
        workflowId: `wf-${wr}`,
        workRequestId: wr,
      },
    });

  beforeAll(async () => {
    const make = async (key: string, role?: 'ADMIN') => {
      ids[key] = (
        await prisma.user.create({
          data: {
            email: `wv-${key}-${suffix}@example.test`,
            emailVerified: true,
            name: key,
            ...(role ? { role } : {}),
          },
        })
      ).id;
    };
    for (const key of ['alice', 'bob', 'carol', 'frank', 'gina']) {
      await make(key);
    }
    await make('admin', 'ADMIN');

    await unscoped(async () => {
      ids.org = (
        await prisma.organization.create({
          data: { name: `wv-org-${suffix}`, slug: `wv-org-${suffix}` },
        })
      ).id;
      for (const key of ['a', 'b', 'c']) {
        ids[`team${key}`] = (
          await prisma.team.create({
            data: { name: `wv-${key}-${suffix}`, orgId: ids.org, slug: `wv-${key}-${suffix}` },
          })
        ).id;
        if (key === 'c') {
          continue;
        }
        ids[`repo${key}`] = (
          await prisma.connection.create({
            data: {
              organizationName: `wv-${suffix}`,
              repoName: `repo-${key}`,
              teamId: ids[`team${key}`],
              type: 'git_repo',
            },
          })
        ).id;
      }
      for (const [key, name, origin] of [
        ['tpl', 'wv-plain', null],
        ['agentTpl', 'wv-agent', AGENT_RUN_TEMPLATE_ORIGIN],
      ] as const) {
        ids[key] = (
          await prisma.workflowTemplate.create({
            data: {
              activeVersion: 1,
              name: `${name}-${suffix}`,
              origin,
              status: 'ACTIVE',
              // GLOBAL: a team-owned template would make its team see every run of it.
            },
          })
        ).id;
      }
    });
    await prisma.teamMembership.create({ data: { teamId: ids.teama, userId: ids.alice } });
    await prisma.teamMembership.create({ data: { teamId: ids.teamb, userId: ids.bob } });
    await prisma.teamMembership.create({ data: { teamId: ids.teamc, userId: ids.gina } });
    // gina's team owns no repository; repo A is shared with it.
    await prisma.connectionTeamShare.create({
      data: { connectionId: ids.repoa, teamId: ids.teamc },
    });

    // TKT-1, mixed: alice's team has a succeeded run, an open PR and $1.50; bob's team has a
    // failed run, a merged PR and $4. bob's request is newer, so it would win the title.
    const a = await request({
      cost: 1.5,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      description: `alpha ${suffix}`,
      repo: 'repoa',
      ticket: ticket('1'),
      user: 'alice',
    });
    const b = await request({
      cost: 4,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      description: `beta ${suffix}`,
      repo: 'repob',
      ticket: ticket('1'),
      user: 'bob',
    });
    ids.wra = a.wr.id;
    ids.wrb = b.wr.id;
    await run(a.wr.id, 'SUCCESS');
    await run(b.wr.id, 'FAILED');
    await prisma.contextSnapshot.create({
      data: {
        rawTicketData: { status: 'In Progress', title: 'Fix login', url: 'https://jira.test/1' },
        successCriteria: [],
        workRequestId: a.wr.id,
      },
    });
    await prisma.contextSnapshot.create({
      data: {
        rawTicketData: { status: 'Done', title: 'SECRET TITLE', url: 'javascript:alert(1)' },
        successCriteria: [],
        workRequestId: b.wr.id,
      },
    });
    await prisma.pullRequest.create({
      data: {
        headSha: 'a',
        isDraft: true,
        prNumber: 1,
        repoId: ids.repoa,
        status: 'OPEN',
        title: 'alice PR',
        workflowId: a.ledger?.id,
      },
    });
    await prisma.pullRequest.create({
      data: {
        headSha: 'b',
        mergedAt: new Date(),
        prNumber: 2,
        repoId: ids.repob,
        status: 'MERGED',
        title: 'bob PR',
        workflowId: b.ledger?.id,
      },
    });

    // Automated: an agent run, and a template launch filed under its own uuid.
    const agent = await request({ repo: 'repoa', ticket: `agent-${suffix}`, user: 'alice' });
    await run(agent.wr.id, 'SUCCESS', 'agentTpl');
    const fallbackId = crypto.randomUUID();
    ids.fallback = fallbackId;
    await request({
      id: fallbackId,
      repo: 'repoa',
      synthetic: true,
      ticket: fallbackId,
      user: 'alice',
    });

    // A cross-repo epic by someone on no team: the epic's own ledger row has no
    // repository, and each child has its repository on its run and its ledger row.
    const epic = await request({
      createdAt: new Date('2026-02-01T00:00:00Z'),
      crossRepo: true,
      ticket: ticket('EPIC'),
      user: 'frank',
    });
    ids.epic = epic.wr.id;
    await prisma.activeWorkflow.create({
      data: {
        costUsdAccrued: 100,
        currentStatus: 'RUNNING',
        temporalWorkflowId: `wf-epic-${suffix}`,
        workRequestId: epic.wr.id,
      },
    });
    const children = {} as Record<string, string>;
    for (const [key, repo, cost, status] of [
      ['a', 'repoa', 2, 'SUCCESS'],
      ['b', 'repob', 3, 'FAILED'],
    ] as const) {
      const ledger = await prisma.activeWorkflow.create({
        data: {
          costUsdAccrued: cost,
          currentStatus: 'RUNNING',
          repoId: ids[repo],
          temporalWorkflowId: `wf-child-${key}-${suffix}`,
          workRequestId: epic.wr.id,
        },
      });
      children[key] = ledger.id;
      await prisma.workflowRun.create({
        data: {
          connectionId: ids[repo],
          specSnapshot: {},
          status,
          templateId: ids.tpl,
          templateVersion: 1,
          workflowId: ledger.temporalWorkflowId,
          workRequestId: epic.wr.id,
        },
      });
      await prisma.pullRequest.create({
        data: {
          headSha: key,
          prNumber: key === 'a' ? 11 : 12,
          repoId: ids[repo],
          status: 'OPEN',
          workflowId: ledger.id,
        },
      });
    }
    // The epic orchestrator's own run: no connection of its own.
    await prisma.workflowRun.create({
      data: {
        specSnapshot: {},
        status: 'RUNNING',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: `wf-epic-${suffix}`,
        workRequestId: epic.wr.id,
      },
    });

    // frank's single-repository request on repo A.
    const single = await request({
      cost: 7,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      repo: 'repoa',
      ticket: ticket('SINGLE'),
      user: 'frank',
    });
    await run(single.wr.id, 'SUCCESS');
    await prisma.pullRequest.create({
      data: {
        headSha: 's',
        prNumber: 21,
        repoId: ids.repoa,
        status: 'OPEN',
        workflowId: single.ledger?.id,
      },
    });

    // A PRD-style request: it names its repository on the request and has no ledger row.
    const prd = await request({
      connection: 'repoa',
      createdAt: new Date('2026-04-01T00:00:00Z'),
      ticket: ticket('PRD'),
      user: 'bob',
    });
    await prisma.workflowRun.create({
      data: {
        specSnapshot: {},
        status: 'RUNNING',
        templateId: ids.tpl,
        templateVersion: 1,
        workflowId: `wf-prd-${suffix}`,
        workRequestId: prd.wr.id,
      },
    });
  });

  afterAll(async () => {
    const repos = [ids.repoa, ids.repob];
    await prisma.pullRequest.deleteMany({ where: { repoId: { in: repos } } });
    await prisma.workflowRun.deleteMany({ where: { templateId: { in: [ids.tpl, ids.agentTpl] } } });
    const people = [ids.alice, ids.bob, ids.carol, ids.admin, ids.frank, ids.gina];
    await prisma.activeWorkflow.deleteMany({
      where: { workRequest: { requestedById: { in: people } } },
    });
    await prisma.runInput.deleteMany({ where: { requestedById: { in: people } } });
    await unscoped(async () => {
      await prisma.workflowTemplate.deleteMany({ where: { id: { in: [ids.tpl, ids.agentTpl] } } });
      await prisma.connection.deleteMany({ where: { id: { in: repos } } });
      await prisma.team.deleteMany({ where: { id: { in: [ids.teama, ids.teamb, ids.teamc] } } });
      await prisma.organization.deleteMany({ where: { id: ids.org } });
    });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await app?.close();
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9999999999,
        iat: 0,
        role: token === ids.admin ? 'ADMIN' : 'ENGINEER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(pullRequestRoutes, { prefix: '/api/v1/pull-requests' });
    await app.register(ticketRoutes, { prefix: '/api/v1/tickets' });
    await app.ready();
  });

  describe('GET /tickets', () => {
    const find = (rows: TicketGroup[], id: string) => rows.find((g) => g.ticketId === ticket(id));

    it("counts only the rows a team member can see in a group that spans two teams' repositories", async () => {
      const { data } = await tickets('alice');
      const group = find(data, '1');
      expect(group).toMatchObject({
        costUsd: 1.5,
        latestRun: { status: 'SUCCESS' },
        requestCount: 1,
        runCounts: { SUCCESS: 1 },
        status: 'In Progress',
        title: 'Fix login',
        url: 'https://jira.test/1',
      });
      expect(group?.latestWorkRequestId).toBe(ids.wra);
      expect(group?.pullRequests.map((pr) => pr.prNumber)).toEqual([1]);
      expect(JSON.stringify(data)).not.toContain('SECRET TITLE');
    });

    it('shows the other team the other half, and an ADMIN the whole group', async () => {
      const bob = find((await tickets('bob')).data, '1');
      expect(bob).toMatchObject({
        costUsd: 4,
        requestCount: 1,
        runCounts: { FAILED: 1 },
        title: 'SECRET TITLE',
      });
      // A javascript: link is data, never a link.
      expect(bob?.url).toBeNull();

      const admin = find((await tickets('admin')).data, '1');
      expect(admin).toMatchObject({
        costUsd: 5.5,
        requestCount: 2,
        runCounts: { FAILED: 1, SUCCESS: 1 },
        // bob's request is newer, so its tracker answer wins.
        title: 'SECRET TITLE',
      });
      expect(admin?.pullRequests.map((pr) => pr.prNumber).sort()).toEqual([1, 2]);
    });

    describe('a cross-repo epic', () => {
      it('gives a member of one repository’s team only that repository’s cost, PRs and runs', async () => {
        const epic = find((await tickets('alice')).data, 'EPIC');
        // The epic's own ledger row ($100, no repository) and repo B's child ($3) are not hers.
        expect(epic?.costUsd).toBe(2);
        expect(epic?.pullRequests.map((pr) => pr.prNumber)).toEqual([11]);
        // Only repo A's child run: not B's child, and not the orchestrator's.
        expect(epic?.runCounts).toEqual({ SUCCESS: 1 });
        expect(epic?.requestCount).toBe(1);
      });

      it('gives the other team the other child, and an ADMIN all of it', async () => {
        const bob = find((await tickets('bob')).data, 'EPIC');
        expect(bob?.costUsd).toBe(3);
        expect(bob?.pullRequests.map((pr) => pr.prNumber)).toEqual([12]);
        expect(bob?.runCounts).toEqual({ FAILED: 1 });

        const admin = find((await tickets('admin')).data, 'EPIC');
        expect(admin?.costUsd).toBe(105);
        expect(admin?.pullRequests.map((pr) => pr.prNumber).sort()).toEqual([11, 12]);
        expect(admin?.runCounts).toEqual({ FAILED: 1, RUNNING: 1, SUCCESS: 1 });
      });

      it('lists it for its requester, who is on no team, with no cost or PR they cannot reach', async () => {
        const epic = find((await tickets('frank')).data, 'EPIC');
        expect(epic).toMatchObject({ costUsd: 0, pullRequests: [], requestCount: 1 });
        // The requester sees every run of their own request, as /workflows lists them.
        expect(epic?.runCounts).toEqual({ FAILED: 1, RUNNING: 1, SUCCESS: 1 });
      });

      it('answers a team filter for a team the caller cannot reach with nothing', async () => {
        const wrongTeam = await tickets('alice', `&teamId=${ids.teamb}`);
        expect(find(wrongTeam.data, 'EPIC')).toBeUndefined();
        expect(JSON.stringify(wrongTeam.data)).not.toContain(ids.wrb);
        const ownTeam = await tickets('alice', `&teamId=${ids.teama}`);
        expect(find(ownTeam.data, 'EPIC')?.costUsd).toBe(2);
        expect(find((await tickets('bob', `&teamId=${ids.teama}`)).data, 'EPIC')).toBeUndefined();
      });
    });

    describe('who sees a request', () => {
      it('lists a single-repository request for its requester on no team, without its cost or PR', async () => {
        const single = find((await tickets('frank')).data, 'SINGLE');
        expect(single).toMatchObject({
          costUsd: 0,
          pullRequests: [],
          requestCount: 1,
          runCounts: { SUCCESS: 1 },
        });
        // The team that owns the repository sees all of it.
        expect(find((await tickets('alice')).data, 'SINGLE')).toMatchObject({
          costUsd: 7,
          requestCount: 1,
        });
        expect(find((await tickets('alice')).data, 'SINGLE')?.pullRequests).toHaveLength(1);
      });

      it('lists a request that only names a reachable repository as its target', async () => {
        const prd = find((await tickets('alice')).data, 'PRD');
        expect(prd).toMatchObject({ requestCount: 1, runCounts: { RUNNING: 1 } });
        expect(find((await tickets('bob')).data, 'PRD')).toBeDefined();
        expect(find((await tickets('carol')).data, 'PRD')).toBeUndefined();
      });

      it('shows a member of a team a repository is shared with that repository’s tickets', async () => {
        const gina = (await tickets('gina')).data;
        expect(find(gina, '1')).toMatchObject({
          costUsd: 1.5,
          requestCount: 1,
          runCounts: { SUCCESS: 1 },
        });
        expect(find(gina, '1')?.pullRequests.map((pr) => pr.prNumber)).toEqual([1]);
        // Nothing of repo B's half.
        expect(JSON.stringify(gina)).not.toContain('SECRET TITLE');
        expect(find(gina, 'EPIC')?.costUsd).toBe(2);
      });
    });

    it('shows an outsider nothing, not even the total', async () => {
      const res = await tickets('carol', '&includeAutomated=true');
      expect(res.data).toEqual([]);
      expect(res.meta.total).toBe(0);
    });

    it('hides automated runs by default and shows them on request', async () => {
      const hidden = (await tickets('alice')).data.map((g) => g.ticketId);
      expect(hidden).not.toContain(`agent-${suffix}`);
      const shown = (await tickets('alice', '&includeAutomated=true')).data.map((g) => g.ticketId);
      expect(shown).toEqual(expect.arrayContaining([ticket('1'), `agent-${suffix}`]));
      // The uuid-filed launch has no suffix to search by, so ask for it directly.
      const byId = await get<TicketGroup>(
        'alice',
        `/api/v1/tickets?scope=TEAM&includeAutomated=true&search=${ids.fallback}`
      );
      expect(byId.data.map((g) => g.ticketId)).toEqual([ids.fallback]);
      const hiddenById = await get<TicketGroup>(
        'alice',
        `/api/v1/tickets?scope=TEAM&search=${ids.fallback}`
      );
      expect(hiddenById.data).toEqual([]);
    });

    it('treats includeAutomated=false as false', async () => {
      const { data } = await tickets('alice', '&includeAutomated=false');
      expect(data.map((g) => g.ticketId)).not.toContain(`agent-${suffix}`);
    });

    it('pages over groups in the database, newest first, with a total that matches', async () => {
      const all = await tickets('alice');
      expect(all.data.map((g) => g.ticketId)).toEqual([
        ticket('PRD'),
        ticket('SINGLE'),
        ticket('EPIC'),
        ticket('1'),
      ]);
      expect(all.meta.total).toBe(4);
      const second = await tickets('alice', '&limit=2&offset=2');
      expect(second.data.map((g) => g.ticketId)).toEqual([ticket('EPIC'), ticket('1')]);
      expect(second.meta.total).toBe(4);
      // The hidden launches never take a slot or count.
      const first = await tickets('alice', '&limit=1');
      expect(first.data).toHaveLength(1);
      expect(first.meta.total).toBe(4);
    });

    it('lets a search choose the tickets while the aggregates cover all their visible requests', async () => {
      const res = await get<TicketGroup>(
        'admin',
        `/api/v1/tickets?scope=TEAM&search=${encodeURIComponent(`alpha ${suffix}`)}`
      );
      expect(res.data.map((g) => g.ticketId)).toEqual([ticket('1')]);
      // Only alice's request matches the text; bob's is the same ticket and still counts.
      expect(res.data[0]).toMatchObject({ costUsd: 5.5, requestCount: 2 });
    });

    it('defaults to the caller’s own requests with scope MINE', async () => {
      const res = await get<TicketGroup>(
        'bob',
        `/api/v1/tickets?search=${suffix}&includeAutomated=true`
      );
      expect(res.data.map((g) => g.ticketId).sort()).toEqual([ticket('1'), ticket('PRD')].sort());
      expect(find(res.data, '1')?.requestCount).toBe(1);
    });
  });

  describe('GET /pull-requests', () => {
    it('lists only PRs on repositories the caller can reach', async () => {
      const alice = await prs('alice');
      // Her own, the epic's repo A child, and the single-repo request on repo A: never B's.
      expect(alice.data.map((p) => p.prNumber).sort()).toEqual([1, 11, 21]);
      expect(alice.meta.total).toBe(3);
      expect(alice.data.find((p) => p.prNumber === 1)).toMatchObject({
        costUsd: 1.5,
        isDraft: true,
        latestRun: { status: 'SUCCESS' },
        status: 'OPEN',
        ticketId: ticket('1'),
        title: 'alice PR',
        url: `https://github.com/wv-${suffix}/repo-a/pull/1`,
        workRequestId: ids.wra,
      });
      expect((await prs('carol')).data).toEqual([]);
      expect((await prs('carol')).meta.total).toBe(0);
    });

    it('lets an ADMIN see every row and filter by state, draft, repository and ticket', async () => {
      const all = await prs('admin', `ticket=${suffix}`);
      expect(all.data.map((p) => p.prNumber).sort()).toEqual([1, 11, 12, 2, 21]);
      expect(
        (await prs('admin', `ticket=${suffix}&state=MERGED`)).data.map((p) => p.prNumber)
      ).toEqual([2]);
      expect(
        (await prs('admin', `ticket=${suffix}&draft=draft`)).data.map((p) => p.prNumber)
      ).toEqual([1]);
      expect(
        (await prs('admin', `ticket=${suffix}&draft=ready`)).data.map((p) => p.prNumber).sort()
      ).toEqual([11, 12, 2, 21]);
      expect(
        (await prs('admin', `ticket=${suffix}&repoId=${ids.repob}`)).data
          .map((p) => p.prNumber)
          .sort()
      ).toEqual([12, 2]);
      expect((await prs('admin', 'ticket=no-such-ticket')).data).toEqual([]);
    });

    it('answers a run only to someone who can see the run', async () => {
      const bob = await prs('bob');
      expect(bob.data.map((p) => p.prNumber).sort()).toEqual([12, 2]);
      expect(bob.data.find((p) => p.prNumber === 2)?.latestRun).toMatchObject({
        status: 'FAILED',
      });
    });
  });
});
