import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { billedOrgId, teamMonthSpend } from '@auto-swe/shared/lib/billing';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { resolveWorkflowRunAttribution } from '@auto-swe/shared/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLaunchRepo } from './automations/access.js';
import { authorizeLaunch } from './launchAuthorization.js';

/**
 * Team budgets against real Postgres: the spend a team is held to, the launch decision on a
 * shared repository, and the rule that a run's attributed team and its billed organization agree.
 * Each is a relational filter or a join that a mocked Prisma would not evaluate.
 *
 * Opt in with `TEAM_BUDGET_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.TEAM_BUDGET_PG_TEST === '1';
const GATE_OFF = { mode: 'off' as const, staleAfterHours: 0 };

describe.skipIf(!enabled)('team budgets against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const prefix = `tb-${suffix}-`;
  const ids = {} as Record<string, string>;
  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped(
      'test fixture: throwaway database',
      [
        'AgentTrace',
        'Connection',
        'ConnectionTeamShare',
        'Team',
        'TeamMembership',
        'WorkflowTemplate',
      ],
      fn
    );
  let seq = 0;

  /** A run of the fixture template, attributed to `team` as the worker attributes it at creation. */
  async function run(opts: {
    team: string | null;
    ledgerUsd?: number;
    traceUsd?: number;
    endedAt?: Date | null;
    costUsd?: number;
    requestConnectionId?: string | null;
    runConnectionId?: string | null;
    billingOrgId?: string | null;
    billingTeamId?: string | null;
    template?: 'tpl' | 'globalTpl';
  }) {
    seq += 1;
    const workflowId = `${prefix}${seq}`;
    const request = await prisma.runInput.create({
      data: {
        billingOrgId: opts.billingOrgId ?? null,
        billingTeamId: opts.billingTeamId ?? null,
        connectionId: opts.requestConnectionId ?? null,
        externalTicketId: workflowId,
        requestPayload: '{}',
      },
    });
    if (opts.ledgerUsd !== undefined) {
      await prisma.activeWorkflow.create({
        data: {
          costUsdAccrued: opts.ledgerUsd,
          currentStatus: 'IMPLEMENTING',
          temporalWorkflowId: workflowId,
          workRequestId: request.id,
        },
      });
    }
    const row = await prisma.workflowRun.create({
      data: {
        attributedTeamId: opts.team,
        connectionId: opts.runConnectionId ?? null,
        costUsdAccrued: opts.costUsd ?? 0,
        endedAt: opts.endedAt ?? null,
        specSnapshot: {},
        templateId: ids[opts.template ?? 'tpl'] as string,
        templateVersion: 1,
        workflowId,
        workRequestId: request.id,
      },
    });
    if (opts.traceUsd) {
      await unscoped(() =>
        prisma.agentTrace.create({
          data: {
            agentKey: 'implementer',
            costUsd: opts.traceUsd,
            nodeId: 'n',
            runId: row.id,
            seq: 1,
            type: 'llm',
          },
        })
      );
    }
    return row;
  }

  const user = (key: string) => ({ role: 'ENGINEER' as const, sub: ids[key] as string });
  async function launch(key: string, repo: string) {
    const row = await findLaunchRepo(prisma, ids[repo] as string, ids[key] as string);
    if (!row) {
      throw new Error('fixture repo missing');
    }
    return authorizeLaunch(prisma, user(key), { gate: GATE_OFF, repos: [row] });
  }

  beforeAll(async () => {
    await cleanup();
    for (const key of ['owner', 'sharee', 'outsider']) {
      ids[key] = (
        await prisma.user.create({
          data: { email: `${prefix}${key}@example.test`, emailVerified: true, name: key },
        })
      ).id;
    }
    ids.org = (
      await prisma.organization.create({ data: { name: `${prefix}org`, slug: `${prefix}org` } })
    ).id;
    // `authorizeLaunch` checks organization membership before any cap, so a user with none is
    // refused with ORG_ACCESS and never reaches the budget decisions this suite is about.
    for (const key of ['owner', 'sharee', 'outsider']) {
      await prisma.organizationMembership.create({
        data: { orgId: ids.org as string, userId: ids[key] as string },
      });
    }
    for (const key of ['own', 'shr', 'other']) {
      ids[key] = (
        await prisma.team.create({
          data: { name: `${prefix}${key}`, orgId: ids.org as string, slug: `${prefix}${key}` },
        })
      ).id;
    }
    await prisma.teamMembership.create({ data: { teamId: ids.own, userId: ids.owner } });
    await prisma.teamMembership.create({ data: { teamId: ids.shr, userId: ids.sharee } });
    for (const [key, team] of [
      ['ownRepo', 'own'],
      ['shrRepo', 'shr'],
    ] as const) {
      ids[key] = (
        await prisma.connection.create({
          data: {
            organizationName: prefix,
            repoName: key,
            teamId: ids[team] as string,
            type: 'git_repo',
          },
        })
      ).id;
    }
    await prisma.connectionTeamShare.create({
      data: { canLaunch: true, connectionId: ids.ownRepo as string, teamId: ids.shr as string },
    });
    ids.tpl = (
      await unscoped(() =>
        prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            name: `${prefix}tpl`,
            status: 'ACTIVE',
            teamId: ids.own as string,
          },
        })
      )
    ).id;
    // A global template names no team: only a launch's own team can place its run.
    ids.globalTpl = (
      await unscoped(() =>
        prisma.workflowTemplate.create({
          data: { activeVersion: 1, name: `${prefix}global`, status: 'ACTIVE', teamId: null },
        })
      )
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function setCap(team: string, cents: number | null) {
    await unscoped(() =>
      prisma.team.update({
        data: { monthlyBudgetUsdCents: cents },
        where: { id: ids[team] as string },
      })
    );
  }
  async function setShare(canLaunch: boolean) {
    await unscoped(() =>
      prisma.connectionTeamShare.updateMany({
        data: { canLaunch },
        where: { connectionId: ids.ownRepo as string, teamId: ids.shr as string },
      })
    );
  }

  it('counts finalized, in-flight and runless spend once each, in the current UTC month only', async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const own = ids.own as string;
    await run({ costUsd: 5, endedAt: now, team: own });
    // Finalized last month: the month boundary excludes it.
    await run({ costUsd: 100, endedAt: lastMonth, team: own });
    // In flight with a ledger row: counted from it, never also from its traces.
    await run({ ledgerUsd: 3, team: own, traceUsd: 50 });
    // In flight with no ledger row: counted from its traces.
    await run({ team: own, traceUsd: 2 });
    // Finalized, its ledger row still lingering: finalized only, never also in flight.
    await run({ costUsd: 7, endedAt: now, ledgerUsd: 7, team: own, traceUsd: 7 });
    // Another team's, and an unattributed run: nobody's here.
    await run({ costUsd: 1000, endedAt: now, team: ids.other as string });
    await run({ ledgerUsd: 1000, team: null });
    // A workflow that keeps no run, stamped with the team.
    await unscoped(() =>
      prisma.agentTrace.create({
        data: {
          agentKey: 'x',
          costUsd: 1,
          nodeId: 'n',
          orgId: ids.org as string,
          seq: 1,
          teamId: own,
          type: 'llm',
        },
      })
    );
    expect(await teamMonthSpend(prisma, own)).toEqual({
      finalizedUsd: 12,
      inFlightUsd: 5,
      runlessUsd: 1,
      totalUsd: 18,
    });
  });

  it("refuses a sharee's launch on the owner's repository by the OWNER's cap, not the sharee's", async () => {
    await setCap('own', 1800); // exactly the owner's spend of $18: at the cap
    await setCap('shr', 100_000_00);
    const refused = await launch('sharee', 'ownRepo');
    expect(refused).toMatchObject({
      ok: false,
      refusal: { body: { error: { code: 'TEAM_BUDGET_EXCEEDED' } }, status: 402 },
    });
    if (!refused.ok) {
      // The sharee is no member of the owner: the team is not named, and no amount is.
      expect(refused.refusal.body.error.message).not.toContain(`${prefix}own`);
      expect(refused.refusal.body.error.message).not.toMatch(/\d{3,}/);
    }
    // The owner's member is told which team.
    const owner = await launch('owner', 'ownRepo');
    expect(owner).toMatchObject({ ok: false });
    if (!owner.ok) {
      expect(owner.refusal.body.error.message).toContain(`${prefix}own`);
    }
    // The sharee's own repository is held to the sharee's cap alone.
    expect(await launch('sharee', 'shrRepo')).toEqual({ ok: true });
    await setCap('own', 1801);
    expect(await launch('sharee', 'ownRepo')).toEqual({ ok: true });
    await setCap('own', null);
    await setCap('shr', null);
  });

  it('refuses a sharee through a view-only share and never the owning team', async () => {
    await setShare(false);
    expect(await launch('sharee', 'ownRepo')).toMatchObject({
      ok: false,
      refusal: { body: { error: { code: 'REPOSITORY_VIEW_ONLY' } }, status: 403 },
    });
    expect(await launch('owner', 'ownRepo')).toEqual({ ok: true });
    await setShare(true);
    expect(await launch('sharee', 'ownRepo')).toEqual({ ok: true });
    expect(await launch('outsider', 'ownRepo')).toMatchObject({ ok: false });
  });

  describe('attributed team and billed organization agree', () => {
    /** The sources a run's attribution and its billing both read, loaded from its rows. */
    async function sources(runId: string) {
      const team = { select: { id: true, orgId: true } } as const;
      const row = await prisma.workflowRun.findUniqueOrThrow({
        select: {
          connection: { select: { team } },
          connectionId: true,
          template: { select: { team } },
          workRequest: {
            select: {
              billingOrgId: true,
              billingTeam: team,
              connection: { select: { team } },
              connectionId: true,
            },
          },
        },
        where: { id: runId },
      });
      return row;
    }
    function both(row: Awaited<ReturnType<typeof sources>>) {
      const attribution = resolveWorkflowRunAttribution({
        connection: row.connection,
        connectionId: row.connectionId,
        template: row.template,
        workRequest: row.workRequest,
      });
      const billed = billedOrgId({
        requestBillingOrgId: row.workRequest?.billingOrgId,
        requestConnectionId: row.workRequest?.connectionId,
        requestOrgId: row.workRequest?.connection?.team?.orgId,
        runConnectionId: row.connectionId,
        runOrgId: row.connection?.team?.orgId,
      });
      return { attribution, billed };
    }

    it('for a work request on a repository, owned or shared', async () => {
      const r = await run({
        requestConnectionId: ids.ownRepo as string,
        runConnectionId: ids.ownRepo as string,
        team: null,
      });
      const { attribution, billed } = both(await sources(r.id));
      // The OWNER of the repository, whoever launched through a share.
      expect(attribution.attributedTeamId).toBe(ids.own);
      expect(attribution.attributedOrgId).toBe(billed);
    });

    it("for an epic child: the request names no connection, the run's own repository decides", async () => {
      const r = await run({ runConnectionId: ids.shrRepo as string, team: null });
      const { attribution, billed } = both(await sources(r.id));
      expect(attribution.attributedTeamId).toBe(ids.shr);
      expect(attribution.attributedOrgId).toBe(billed);
    });

    it("for a connection-less template run: the template's team and the org its launch was charged to", async () => {
      const r = await run({ billingOrgId: ids.org as string, team: null });
      const { attribution, billed } = both(await sources(r.id));
      expect(attribution.attributedTeamId).toBe(ids.own);
      expect(billed).toBe(ids.org);
      expect(attribution.attributedOrgId).toBe(billed);
    });

    it('for a connection-less automation run on a global template: the team its launch was held to', async () => {
      const r = await run({
        billingOrgId: ids.org as string,
        billingTeamId: ids.shr as string,
        ledgerUsd: 2,
        team: null,
        template: 'globalTpl',
      });
      const { attribution, billed } = both(await sources(r.id));
      // No repository, channel, service principal or template team: the stamped team places it.
      expect(attribution.attributedTeamId).toBe(ids.shr);
      expect(billed).toBe(ids.org);
      expect(attribution.attributedOrgId).toBe(billed);
      // Written as the worker writes it at run creation; the team's spend then counts the run.
      await prisma.workflowRun.update({
        data: { attributedTeamId: attribution.attributedTeamId },
        where: { id: r.id },
      });
      expect(await teamMonthSpend(prisma, ids.shr as string)).toMatchObject({ inFlightUsd: 2 });
      // The launch gate asks the same team the spend was counted under: at its cap, it refuses.
      const gate = (capCents: number) =>
        authorizeLaunch(prisma, user('sharee'), {
          gate: GATE_OFF,
          orgs: [{ id: ids.org as string, monthlyBudgetUsdCents: null }],
          repos: [],
          teams: [
            { id: ids.shr as string, isMember: true, monthlyBudgetUsdCents: capCents, name: 'shr' },
          ],
        });
      expect(await gate(200)).toMatchObject({
        ok: false,
        refusal: { body: { error: { code: 'TEAM_BUDGET_EXCEEDED' } }, status: 402 },
      });
      expect(await gate(201)).toEqual({ ok: true });
    });
  });

  async function cleanup() {
    const runs = await prisma.workflowRun.findMany({
      select: { id: true },
      where: { workflowId: { startsWith: prefix } },
    });
    const runIds = runs.map((r) => r.id);
    await unscoped(() =>
      prisma.agentTrace.deleteMany({
        where: {
          OR: [
            { runId: { in: runIds } },
            { agentKey: 'x', costUsd: 1, nodeId: 'n', team: { slug: { startsWith: prefix } } },
          ],
        },
      })
    );
    await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.activeWorkflow.deleteMany({
      where: { temporalWorkflowId: { startsWith: prefix } },
    });
    await prisma.runInput.deleteMany({ where: { externalTicketId: { startsWith: prefix } } });
    await unscoped(() =>
      prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: prefix } } })
    );
    await unscoped(() =>
      prisma.connectionTeamShare.deleteMany({ where: { connection: { organizationName: prefix } } })
    );
    await unscoped(() => prisma.connection.deleteMany({ where: { organizationName: prefix } }));
    await unscoped(() =>
      prisma.teamMembership.deleteMany({ where: { team: { slug: { startsWith: prefix } } } })
    );
    await unscoped(() => prisma.team.deleteMany({ where: { slug: { startsWith: prefix } } }));
    await prisma.organizationMembership.deleteMany({
      where: { organization: { slug: { startsWith: prefix } } },
    });
    await prisma.organization.deleteMany({ where: { slug: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
  }
});
