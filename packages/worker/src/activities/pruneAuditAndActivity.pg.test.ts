import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The run-effect ledger against real Postgres: `recordEffect` writes a row (through the real
 * client, with the Temporal context stubbed), and the retention sweep deletes rows past
 * `audit.runEffectRetentionDays` by age, in id batches, while keeping a row of a run under legal
 * hold. A mocked client evaluates none of those predicates.
 *
 * Opt in with `RUN_EFFECT_PRUNE_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it deletes rows older than the cutoff, so use a throwaway one).
 */
const enabled = process.env.RUN_EFFECT_PRUNE_PG_TEST === '1';

const h = vi.hoisted(() => ({ retentionDays: 30, workflowId: 'unset' }));
vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({ workflowExecution: { workflowId: h.workflowId } }),
  heartbeat: vi.fn(),
}));
vi.mock('../lib/activityContext.js', () => ({ currentWorkflowRunId: async () => undefined }));
vi.mock('../lib/spendOwner.js', () => ({ currentSpendOwner: async () => ({}) }));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: async (key: string) =>
    key === 'audit.runEffectRetentionDays' ? h.retentionDays : 0,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!enabled)('run effect retention against Postgres', () => {
  let prisma: typeof import('@auto-swe/shared/db').prisma;
  let sweep: typeof import('./pruneAuditAndActivity.js').pruneAuditAndActivity;
  let recordEffect: typeof import('../lib/effectLedger.js').recordEffect;
  const marker = `effprune-${randomUUID()}`;
  let templateId = '';
  let heldRunId = '';
  const now = new Date();

  const row = (workflowId: string, ageDays: number, runId?: string) =>
    prisma.runEffect.create({
      data: {
        action: 'create',
        createdAt: new Date(now.getTime() - ageDays * DAY_MS),
        kind: 'PULL_REQUEST',
        runId: runId ?? null,
        status: 'DONE',
        via: 'activity',
        workflowId,
      },
    });
  const remaining = (workflowId: string) =>
    runUnscoped('read back the run-effect test fixture', ['RunEffect'], () =>
      prisma.runEffect.count({ where: { workflowId } })
    );

  beforeAll(async () => {
    ({ prisma } = await import('@auto-swe/shared/db'));
    ({ pruneAuditAndActivity: sweep } = await import('./pruneAuditAndActivity.js'));
    ({ recordEffect } = await import('../lib/effectLedger.js'));
    templateId = (await prisma.workflowTemplate.create({ data: { name: marker } })).id;
    heldRunId = (
      await prisma.workflowRun.create({
        data: {
          specSnapshot: {},
          templateId,
          templateVersion: 1,
          transcriptLegalHold: true,
          workflowId: `${marker}-held-run`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await runUnscoped('remove the run-effect test fixture', ['RunEffect'], () =>
      prisma.runEffect.deleteMany({ where: { workflowId: { startsWith: marker } } })
    );
    await prisma.workflowRun.deleteMany({ where: { templateId } });
    await runUnscoped('remove the run-effect template fixture', ['WorkflowTemplate'], () =>
      prisma.workflowTemplate.deleteMany({ where: { id: templateId } })
    );
    await prisma.$disconnect();
  });

  it('records an effect through the real client', async () => {
    h.workflowId = `${marker}-written`;
    await recordEffect({
      action: 'create',
      kind: 'TRACKER',
      status: 'SKIPPED',
      target: 'T-1',
      via: 'activity',
    });
    const rows = await runUnscoped('read back the written effect', ['RunEffect'], () =>
      prisma.runEffect.findMany({ where: { workflowId: h.workflowId } })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'TRACKER', status: 'SKIPPED', target: 'T-1' });
  });

  it('deletes rows past the retention window and keeps newer ones and held runs', async () => {
    await row(`${marker}-old`, 60);
    await row(`${marker}-new`, 5);
    await row(`${marker}-held`, 60, heldRunId);
    h.retentionDays = 30;
    const result = await sweep(now);
    expect(result.runEffectsDeleted).toBeGreaterThanOrEqual(1);
    expect(await remaining(`${marker}-old`)).toBe(0);
    expect(await remaining(`${marker}-new`)).toBe(1);
    expect(await remaining(`${marker}-held`)).toBe(1);
    expect(await remaining(`${marker}-written`)).toBe(1);
  });

  it('deletes nothing when retention is 0', async () => {
    await row(`${marker}-ancient`, 400);
    h.retentionDays = 0;
    const result = await sweep(now);
    expect(result.runEffectsDeleted).toBe(0);
    expect(await remaining(`${marker}-ancient`)).toBe(1);
  });
});
