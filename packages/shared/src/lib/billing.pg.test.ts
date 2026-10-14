import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { currentYearMonth, orgMonthSpend } from './billing.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * orgMonthSpend against real Postgres: which unfinalized runs it counts for an
 * organization is a set of relational filters that must mirror `billedOrgId`
 * exactly and stay disjoint, which a mocked client does not evaluate.
 *
 * Opt in with `BILLING_PG_TEST=1` and a migrated `DATABASE_URL`
 * (see modelSuggestions.pg.test.ts for a disposable pgvector container).
 */
const enabled = process.env.BILLING_PG_TEST === '1';

const ORG_A = '7d000000-0000-4000-8000-00000000000a';
const ORG_B = '7d000000-0000-4000-8000-00000000000b';
const TEAM_A = '7d000000-0000-4000-8000-0000000000a1';
const TEAM_B = '7d000000-0000-4000-8000-0000000000b1';
const REPO_A = '7d000000-0000-4000-8000-0000000000a2';
const REPO_B = '7d000000-0000-4000-8000-0000000000b2';
const TEMPLATE = '7d000000-0000-4000-8000-0000000000c1';
const PREFIX = 'billing-pg-';

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped(
    'test fixture rows',
    ['AgentTrace', 'Connection', 'OrgMonthlyUsage', 'Team', 'WorkflowTemplate'],
    fn
  );

let seq = 0;

/**
 * One unfinalized (or, with `ended`, finalized) run of the fixture template:
 * its request, its own ledger row when `ledger` is given, and a trace row of
 * `traceUsd` so a run counted from its ledger is seen not also counted twice.
 */
async function run(opts: {
  requestConnectionId?: string | null;
  billingOrgId?: string | null;
  runConnectionId?: string | null;
  ledger?: { repoId: string | null; costUsd: number };
  traceUsd?: number;
  ended?: boolean;
}): Promise<string> {
  seq += 1;
  const workflowId = `${PREFIX}${seq}`;
  const request = await prisma.runInput.create({
    data: {
      billingOrgId: opts.billingOrgId ?? null,
      connectionId: opts.requestConnectionId ?? null,
      externalTicketId: workflowId,
      requestPayload: '{}',
    },
  });
  if (opts.ledger) {
    await prisma.activeWorkflow.create({
      data: {
        costUsdAccrued: opts.ledger.costUsd,
        currentStatus: 'IMPLEMENTING',
        repoId: opts.ledger.repoId,
        temporalWorkflowId: workflowId,
        workRequestId: request.id,
      },
    });
  }
  const row = await prisma.workflowRun.create({
    data: {
      connectionId: opts.runConnectionId ?? null,
      endedAt: opts.ended ? new Date() : null,
      specSnapshot: {},
      templateId: TEMPLATE,
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
  return row.id;
}

describe.skipIf(!enabled)('orgMonthSpend against Postgres', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [org, team, repo, slug] of [
      [ORG_A, TEAM_A, REPO_A, 'billing-pg-a'],
      [ORG_B, TEAM_B, REPO_B, 'billing-pg-b'],
    ] as const) {
      await prisma.organization.create({ data: { id: org, name: slug, slug } });
      await prisma.team.create({ data: { id: team, name: slug, orgId: org, slug } });
      await prisma.connection.create({ data: { id: repo, teamId: team } });
    }
    await unscoped(() =>
      prisma.workflowTemplate.create({ data: { id: TEMPLATE, name: `${PREFIX}template` } })
    );
    await unscoped(() =>
      prisma.orgMonthlyUsage.create({
        data: { costUsdAccrued: 16, orgId: ORG_A, yearMonth: currentYearMonth() },
      })
    );

    // Charged to A at launch, no connection, no ledger row: counted for A from its traces.
    await run({ billingOrgId: ORG_A, traceUsd: 1 });
    // Charged to A, a ledger row with no repository: counted for A from that row, not its traces.
    await run({ billingOrgId: ORG_A, ledger: { costUsd: 2, repoId: null }, traceUsd: 50 });
    // Charged to A, but its ledger row names B's repository: B's, never A's.
    await run({ billingOrgId: ORG_A, ledger: { costUsd: 4, repoId: REPO_B }, traceUsd: 50 });
    // Charged to A, but its request names B's repository: B's, never A's.
    await run({
      billingOrgId: ORG_A,
      ledger: { costUsd: 8, repoId: REPO_B },
      requestConnectionId: REPO_B,
    });
    // Charged to A, but its own run connection is B's repository: B's.
    await run({ billingOrgId: ORG_A, runConnectionId: REPO_B, traceUsd: 32 });
    // Charged to A and finalized: its spend is in OrgMonthlyUsage already, not in flight.
    await run({ billingOrgId: ORG_A, ended: true, traceUsd: 64 });
    // Charged to no org and placed nowhere: nobody's.
    await run({ traceUsd: 128 });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('counts an in-flight run charged to the org once, from its ledger row or else its traces', async () => {
    expect(await orgMonthSpend(prisma, ORG_A)).toEqual({
      finalizedUsd: 16,
      inFlightUsd: 3,
      runlessUsd: 0,
      totalUsd: 19,
    });
  });

  it('leaves a charged run to the connection or ledger repository that places it', async () => {
    expect(await orgMonthSpend(prisma, ORG_B)).toEqual({
      finalizedUsd: 0,
      inFlightUsd: 4 + 8 + 32,
      runlessUsd: 0,
      totalUsd: 44,
    });
  });
});

async function cleanup() {
  const runs = await prisma.workflowRun.findMany({
    select: { id: true, workRequestId: true },
    where: { workflowId: { startsWith: PREFIX } },
  });
  const runIds = runs.map((r) => r.id);
  await unscoped(() => prisma.agentTrace.deleteMany({ where: { runId: { in: runIds } } }));
  await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
  await prisma.activeWorkflow.deleteMany({
    where: { temporalWorkflowId: { startsWith: PREFIX } },
  });
  await prisma.runInput.deleteMany({ where: { externalTicketId: { startsWith: PREFIX } } });
  await unscoped(() => prisma.workflowTemplate.deleteMany({ where: { id: TEMPLATE } }));
  await unscoped(() =>
    prisma.orgMonthlyUsage.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } })
  );
  await unscoped(() => prisma.connection.deleteMany({ where: { id: { in: [REPO_A, REPO_B] } } }));
  await unscoped(() => prisma.team.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B] } } }));
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
}
