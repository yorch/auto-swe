import { randomUUID } from 'node:crypto';
import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/activityLog.js', () => ({ auditLog: vi.fn(), logWarn: vi.fn() }));
// `heartbeat` needs an activity context, which a test outside Temporal has not got.
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

import { pruneRunHistory, RUN_PRUNE_BATCH } from './pruneRunHistory.js';

/**
 * The run-history sweep against real Postgres. A mocked Prisma cannot show what matters here: that
 * the keyset read keeps going after a batch whose every run was deleted (a cursor on a deleted
 * row returns nothing), that each keep rule is expressed in a query Postgres accepts and answers
 * correctly, and that the database cascade removes exactly the children the design says it does.
 *
 * The sweep is deployment-wide, so global assertions are scoped to the runs this suite seeds.
 *
 * Opt in with `RUN_HISTORY_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it deletes every deletable run in the database, so use a throwaway one):
 *
 *   docker run -d --rm --name rr-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55439:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55439/t yarn workspace @auto-swe/shared db:deploy
 *   RUN_HISTORY_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/worker/src/activities/pruneRunHistory.pg.test.ts
 */
const enabled = process.env.RUN_HISTORY_PG_TEST === '1';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const SCOPED = [
  'AgentTrace',
  'AgentTraceDailyUsage',
  'AgentTranscript',
  'ConfigSetting',
  'MemoryItem',
];
const unscoped = <T>(fn: () => Promise<T>) => runUnscoped('test fixture rows', SCOPED, fn);

describe.skipIf(!enabled)('run-history sweep against Postgres', () => {
  const suffix = Math.random().toString(36).slice(2);
  const NOW = new Date();
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
  let templateId = '';
  let seq = 0;
  const deletable: string[] = [];
  const kept: Record<string, string[]> = {};
  const workflowIds: string[] = [];

  type Kind =
    | 'running'
    | 'endedRecently'
    | 'recentStep'
    | 'recentTrace'
    | 'legalHold'
    | 'pendingCallback'
    | 'liveLedger'
    | 'openPr'
    | 'unrolled';
  const KINDS: Kind[] = [
    'running',
    'endedRecently',
    'recentStep',
    'recentTrace',
    'legalHold',
    'pendingCallback',
    'liveLedger',
    'openPr',
    'unrolled',
  ];

  /** One run, with a step, an LLM trace and (unless `rolled` is false) a rollup row. */
  async function seedRun(opts: {
    kind?: Kind;
    status?: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'RUNNING';
    withChildren?: boolean;
  }): Promise<string> {
    const n = seq++;
    const id = randomUUID();
    const workflowId = `rr-pg-${suffix}-${n}`;
    workflowIds.push(workflowId);
    const kind = opts.kind;
    // Ordered by start time so kept runs sit among deletable ones across batch boundaries.
    const startedAt = new Date(daysAgo(200).getTime() + n * 60_000);
    const endedAt =
      kind === 'running' ? null : kind === 'endedRecently' ? daysAgo(10) : daysAgo(100 - (n % 5));
    await prisma.workflowRun.create({
      data: {
        endedAt,
        id,
        specSnapshot: {},
        startedAt,
        status: kind === 'running' ? 'RUNNING' : (opts.status ?? 'SUCCESS'),
        templateId,
        templateVersion: 1,
        transcriptLegalHold: kind === 'legalHold',
        workflowId,
      },
    });
    const old = daysAgo(100);
    await prisma.workflowStep.create({
      data: {
        attempt: 1,
        nodeId: 'n1',
        runId: id,
        startedAt: kind === 'recentStep' ? daysAgo(1) : old,
      },
    });
    await unscoped(() =>
      prisma.agentTrace.create({
        data: {
          agentKey: 'implementer',
          createdAt: kind === 'recentTrace' ? daysAgo(2) : old,
          nodeId: 'n1',
          runId: id,
          seq: 1,
          type: 'llm_response',
        },
      })
    );
    if (kind !== 'unrolled') {
      await unscoped(() =>
        prisma.agentTraceDailyUsage.create({
          data: {
            agentKey: 'implementer',
            calls: 1,
            costUsd: 0.5,
            day: new Date(Math.floor(old.getTime() / DAY) * DAY),
            errors: 0,
            inputTokens: 10n,
            nodeId: 'n1',
            okDurationCount: 0,
            okDurationMs: 0n,
            outputTokens: 5n,
            runId: id,
          },
        })
      );
    }
    if (kind === 'pendingCallback') {
      await prisma.outboundDelivery.create({
        data: {
          dedupeKey: `${id}:run.completed`,
          event: 'run.completed',
          payload: {},
          status: 'PENDING',
          workflowRunId: id,
        },
      });
    }
    if (kind === 'liveLedger' || kind === 'openPr') {
      const aw = await prisma.activeWorkflow.create({
        data: {
          currentStatus: kind === 'liveLedger' ? 'RUNNING' : 'COMPLETED',
          temporalWorkflowId: workflowId,
        },
      });
      if (kind === 'openPr') {
        await prisma.pullRequest.create({
          data: { headSha: 'a'.repeat(40), status: 'OPEN', workflowId: aw.id },
        });
      }
    } else if (!kind) {
      // A finished run's ledger row, so the "ledger is terminal" branch is exercised too.
      await prisma.activeWorkflow.create({
        data: { currentStatus: 'COMPLETED', temporalWorkflowId: workflowId },
      });
    }
    if (opts.withChildren) {
      await prisma.workflowHumanStep.create({
        data: {
          kind: 'APPROVAL',
          nodeId: 'n1',
          runId: id,
          signalName: 's',
          title: 't',
        },
      });
      await prisma.autonomyDecision.create({ data: { event: 'publish', runId: id } });
      await prisma.evalResult.create({
        data: { runId: id, scorer: 's', scoreType: 'BOOLEAN', source: 'GATE', value: 1 },
      });
      await prisma.workflowOutcomeReference.create({
        data: { attempt: 1, connectionId: randomUUID(), nodeId: 'n1', runId: id },
      });
      await prisma.workflowArtifact.create({
        data: { backend: 'pg', inlineBlob: Buffer.from('x'), kind: 'log', runId: id, sizeBytes: 1 },
      });
      await prisma.outboundDelivery.create({
        data: {
          dedupeKey: `${id}:done`,
          event: 'run.completed',
          payload: {},
          status: 'DELIVERED',
          workflowRunId: id,
        },
      });
      await unscoped(() =>
        prisma.memoryItem.create({
          data: { lessonSummary: `rr-pg-${suffix}`, rationale: 'r', workflowRunId: id },
        })
      );
      await unscoped(() =>
        prisma.agentTranscript.create({
          data: { activityType: 'implementer', runId: id, workflowId },
        })
      );
    }
    return id;
  }

  const runIdsPresent = async (ids: string[]) =>
    (await prisma.workflowRun.findMany({ select: { id: true }, where: { id: { in: ids } } })).map(
      (r) => r.id
    );
  const count = {
    steps: (ids: string[]) => prisma.workflowStep.count({ where: { runId: { in: ids } } }),
    traces: (ids: string[]) =>
      unscoped(() => prisma.agentTrace.count({ where: { runId: { in: ids } } })),
  };

  async function setRetention(days: number | null) {
    await unscoped(() =>
      prisma.configSetting.deleteMany({
        where: { key: 'workflow.runRetentionDays', scope: 'GLOBAL' },
      })
    );
    if (days !== null) {
      await prisma.configSetting.create({
        data: { key: 'workflow.runRetentionDays', scope: 'GLOBAL', value: days },
      });
    }
    _resetConfigCacheForTests();
  }

  beforeAll(async () => {
    templateId = (await prisma.workflowTemplate.create({ data: { name: `rr-pg-${suffix}` } })).id;
    // Interleave: every fourth run is a kept one, the rest are deletable, 3 full batches in all.
    const total = RUN_PRUNE_BATCH * 3 + 40;
    let k = 0;
    for (let i = 0; i < total; i++) {
      if (i % 4 === 3 && k < KINDS.length * 3) {
        const kind = KINDS[k % KINDS.length] as Kind;
        k += 1;
        const id = await seedRun({ kind });
        kept[kind] = [...(kept[kind] ?? []), id];
      } else {
        deletable.push(
          await seedRun({ status: i % 2 ? 'FAILED' : 'SUCCESS', withChildren: i === 0 })
        );
      }
    }
    // A terminal status of each other kind, so the whole terminal set is exercised.
    deletable.push(await seedRun({ status: 'CANCELLED' }));
  }, 300_000);

  beforeEach(() => {
    _resetConfigCacheForTests();
  });

  afterAll(async () => {
    const all = [...deletable, ...Object.values(kept).flat()];
    await prisma.pullRequest.deleteMany({
      where: { workflow: { temporalWorkflowId: { in: workflowIds } } },
    });
    await prisma.activeWorkflow.deleteMany({ where: { temporalWorkflowId: { in: workflowIds } } });
    await unscoped(() => prisma.agentTraceDailyUsage.deleteMany({ where: { runId: { in: all } } }));
    await unscoped(() =>
      prisma.agentTranscript.deleteMany({ where: { workflowId: { in: workflowIds } } })
    );
    await unscoped(() =>
      prisma.memoryItem.deleteMany({ where: { lessonSummary: `rr-pg-${suffix}` } })
    );
    await prisma.workflowRun.deleteMany({ where: { id: { in: all } } });
    await unscoped(() =>
      prisma.configSetting.deleteMany({
        where: { key: 'workflow.runRetentionDays', scope: 'GLOBAL' },
      })
    );
    await prisma.workflowTemplate.delete({ where: { id: templateId } });
    await prisma.$disconnect();
  });

  it('deletes nothing when retention is 0 (the default)', async () => {
    await setRetention(null);
    const all = [...deletable, ...Object.values(kept).flat()];
    await expect(pruneRunHistory(NOW)).resolves.toMatchObject({ deleted: 0, retentionDays: 0 });
    expect(await runIdsPresent(all)).toHaveLength(all.length);
    expect(await count.steps(all)).toBe(all.length);
  });

  it('deletes every deletable run in one sweep and keeps the rest with their children', async () => {
    expect(deletable.length).toBeGreaterThan(RUN_PRUNE_BATCH * 2);
    const keptIds = Object.values(kept).flat();
    expect(keptIds.length).toBe(KINDS.length * 3);
    await setRetention(RETENTION_DAYS);

    const result = await pruneRunHistory(NOW);

    // The sweep is deployment-wide, so other suites' old runs may add to the count: assert on ours.
    expect(result.deleted).toBeGreaterThanOrEqual(deletable.length);
    expect(await runIdsPresent(deletable)).toEqual([]);
    for (const [kind, ids] of Object.entries(kept)) {
      expect(await runIdsPresent(ids), kind).toHaveLength(ids.length);
    }
    // The kept runs keep their children.
    expect(await count.steps(keptIds)).toBe(keptIds.length);
    expect(await count.traces(keptIds)).toBe(keptIds.length);
    expect(
      await prisma.outboundDelivery.count({
        where: { workflowRunId: { in: kept.pendingCallback ?? [] } },
      })
    ).toBe(3);
    expect(result.kept.held).toBeGreaterThanOrEqual(6);
    expect(result.kept.pendingCallback).toBeGreaterThanOrEqual(3);
    expect(result.kept.unrolledSpend).toBeGreaterThanOrEqual(3);
  });

  it('cascades the deleted runs children, and unlinks memory and transcripts', async () => {
    // The first deletable run carried one of every cascaded child, a memory item and a transcript.
    const first = deletable[0] as string;
    expect(await count.steps(deletable)).toBe(0);
    expect(await count.traces(deletable)).toBe(0);
    const where = { runId: first };
    expect(await prisma.workflowHumanStep.count({ where })).toBe(0);
    expect(await prisma.autonomyDecision.count({ where })).toBe(0);
    expect(await prisma.evalResult.count({ where })).toBe(0);
    expect(await prisma.workflowOutcomeReference.count({ where })).toBe(0);
    expect(await prisma.workflowArtifact.count({ where })).toBe(0);
    expect(await prisma.outboundDelivery.count({ where: { workflowRunId: first } })).toBe(0);
    const memory = await unscoped(() =>
      prisma.memoryItem.findMany({ where: { lessonSummary: `rr-pg-${suffix}` } })
    );
    expect(memory).toHaveLength(1);
    expect(memory[0]?.workflowRunId).toBeNull();
    const transcripts = await unscoped(() =>
      prisma.agentTranscript.findMany({
        where: { workflowId: `rr-pg-${suffix}-0` },
      })
    );
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.runId).toBeNull();
    // Rollup rows have no foreign key to a run: spend history survives the deletion.
    expect(
      await unscoped(() =>
        prisma.agentTraceDailyUsage.count({ where: { runId: { in: deletable } } })
      )
    ).toBe(deletable.length);
  });

  it('deletes a kept run once what held it is gone', async () => {
    const [pending] = kept.pendingCallback ?? [];
    await prisma.outboundDelivery.updateMany({
      data: { status: 'DELIVERED' },
      where: { workflowRunId: pending },
    });
    const result = await pruneRunHistory(NOW);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await runIdsPresent([pending as string])).toEqual([]);
  });
});
