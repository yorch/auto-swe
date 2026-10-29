import type { Prisma } from '@auto-swe/shared';
import type { prisma as PrismaClient } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RunDetection from './runDetection.js';

/**
 * The run's stack-detection pin against real Postgres: which rows `pinDetectionsOnRun` writes is a
 * `WHERE (pinned_detections IS NULL OR temporal_run_id <> $execution)` over a nullable JSON column
 * and a nullable text column, and `detectedStackForRun` reads by the run's unique workflow id. A
 * mocked client evaluates neither.
 *
 * Opt in with `RUN_DETECTION_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one):
 *
 *   docker run -d --rm --name rdet-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55533:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55533/t yarn workspace @auto-swe/shared db:deploy
 *   RUN_DETECTION_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/worker/src/lib/runDetection.pg.test.ts
 *
 * The Temporal context is stubbed: each test chooses the workflow id and execution id the
 * "activity" runs under.
 */
const enabled = process.env.RUN_DETECTION_PG_TEST === '1';

const ctx = vi.hoisted(() => ({
  temporalRunId: null as string | null,
  workflowId: 'unset',
}));
vi.mock('./activityContext.js', () => ({
  currentTemporalRunId: () => ctx.temporalRunId,
  currentWorkflowId: () => ctx.workflowId,
}));

const ORG = '7c000000-0000-4000-8000-000000000001';
const TEAM = '7c000000-0000-4000-8000-000000000002';
const CONN_A = '7c000000-0000-4000-8000-000000000003';
const CONN_B = '7c000000-0000-4000-8000-000000000004';
const UNKNOWN = '7c000000-0000-4000-8000-0000000000ff';

const STACK_A = { stacks: ['python'] };
const STACK_B = { stacks: ['node'] };

let prisma: typeof PrismaClient;
let detection: typeof RunDetection;

describe.skipIf(!enabled)('run stack-detection pin against Postgres', () => {
  const suffix = Math.random().toString(36).slice(2);
  let templateId = '';
  const runIds: string[] = [];

  async function createRun(temporalRunId: string | null, pinned?: Prisma.InputJsonObject) {
    const workflowId = `rdet-pg-${suffix}-${runIds.length}`;
    const run = await prisma.workflowRun.create({
      data: {
        ...(pinned ? { pinnedDetections: pinned } : {}),
        specSnapshot: {},
        templateId,
        templateVersion: 1,
        temporalRunId,
        workflowId,
      },
    });
    runIds.push(run.id);
    return { runId: run.id, workflowId };
  }

  const stored = async (id: string) =>
    (await prisma.workflowRun.findUniqueOrThrow({ where: { id } })).pinnedDetections;

  async function setLiveDetection(id: string, detectedStack: Prisma.InputJsonValue) {
    await runUnscoped('test fixture rows', ['Connection'], () =>
      prisma.connection.update({ data: { detectedStack }, where: { id } })
    );
  }

  beforeAll(async () => {
    ({ prisma } = await import('@auto-swe/shared/db'));
    detection = await import('./runDetection.js');
    await cleanup();
    await prisma.organization.create({ data: { id: ORG, name: 'rdet-pg', slug: 'rdet-pg' } });
    await prisma.team.create({ data: { id: TEAM, name: 'rdet-pg', orgId: ORG, slug: 'rdet-pg' } });
    await prisma.connection.createMany({
      data: [
        { detectedStack: STACK_A, id: CONN_A, teamId: TEAM },
        { id: CONN_B, teamId: TEAM },
      ],
    });
    templateId = (await prisma.workflowTemplate.create({ data: { name: `rdet-pg-${suffix}` } })).id;
  });

  beforeEach(async () => {
    await setLiveDetection(CONN_A, STACK_A);
  });

  afterAll(async () => {
    await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.workflowTemplate.delete({ where: { id: templateId } });
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await runUnscoped('test fixture rows', ['Connection', 'Team'], async () => {
      await prisma.connection.deleteMany({ where: { id: { in: [CONN_A, CONN_B] } } });
      await prisma.team.deleteMany({ where: { id: TEAM } });
      await prisma.organization.deleteMany({ where: { id: ORG } });
    });
  }

  describe('snapshotDetections', () => {
    it('maps a detection to itself, a connection without one to null, and omits an unknown id', async () => {
      await expect(detection.snapshotDetections([CONN_A, CONN_B, UNKNOWN])).resolves.toEqual({
        [CONN_A]: STACK_A,
        [CONN_B]: null,
      });
    });
  });

  describe('pinDetectionsOnRun', () => {
    it('pins { id: detection | null } on a fresh row', async () => {
      const { runId } = await createRun('exec-1');
      ctx.temporalRunId = 'exec-1';
      await detection.pinDetectionsOnRun(runId, [CONN_A, CONN_B]);
      expect(await stored(runId)).toEqual({ [CONN_A]: STACK_A, [CONN_B]: null });
    });

    it('changes nothing on a second call in the same execution', async () => {
      const { runId } = await createRun('exec-1');
      ctx.temporalRunId = 'exec-1';
      await detection.pinDetectionsOnRun(runId, [CONN_A]);
      await setLiveDetection(CONN_A, STACK_B);
      await detection.pinDetectionsOnRun(runId, [CONN_A]);
      expect(await stored(runId)).toEqual({ [CONN_A]: STACK_A });
    });

    it('overwrites from a different execution that reuses the workflow id', async () => {
      const { runId } = await createRun('exec-1');
      ctx.temporalRunId = 'exec-1';
      await detection.pinDetectionsOnRun(runId, [CONN_A]);
      await setLiveDetection(CONN_A, STACK_B);
      ctx.temporalRunId = 'exec-2';
      await detection.pinDetectionsOnRun(runId, [CONN_A]);
      expect(await stored(runId)).toEqual({ [CONN_A]: STACK_B });
    });

    it('fills a row that has no pin and names another execution', async () => {
      const { runId } = await createRun('exec-1');
      ctx.temporalRunId = 'exec-2';
      await detection.pinDetectionsOnRun(runId, [CONN_A]);
      expect(await stored(runId)).toEqual({ [CONN_A]: STACK_A });
    });

    it('fills an unpinned row whose temporal run id is NULL, but never overwrites a pinned one', async () => {
      const unpinned = await createRun(null);
      const pinned = await createRun(null, { [CONN_A]: STACK_B });
      ctx.temporalRunId = 'exec-2';
      await detection.pinDetectionsOnRun(unpinned.runId, [CONN_A]);
      await detection.pinDetectionsOnRun(pinned.runId, [CONN_A]);
      expect(await stored(unpinned.runId)).toEqual({ [CONN_A]: STACK_A });
      // `NULL <> 'exec-2'` is not true, so the second clause never matches a NULL temporal run id.
      expect(await stored(pinned.runId)).toEqual({ [CONN_A]: STACK_B });
    });

    it('writes only a NULL column outside an activity', async () => {
      const unpinned = await createRun('exec-1');
      const pinned = await createRun('exec-1', { [CONN_A]: STACK_B });
      ctx.temporalRunId = null;
      await detection.pinDetectionsOnRun(unpinned.runId, [CONN_A]);
      await detection.pinDetectionsOnRun(pinned.runId, [CONN_A]);
      expect(await stored(unpinned.runId)).toEqual({ [CONN_A]: STACK_A });
      expect(await stored(pinned.runId)).toEqual({ [CONN_A]: STACK_B });
    });
  });

  describe('detectedStackForRun', () => {
    it('returns the pinned detection over a different live one, found by workflow id', async () => {
      // The row names exec-1; the reader runs under exec-3. The lookup does not care.
      const { workflowId } = await createRun('exec-1', { [CONN_A]: STACK_B });
      ctx.workflowId = workflowId;
      ctx.temporalRunId = 'exec-3';
      await expect(
        detection.detectedStackForRun({ detectedStack: STACK_A, id: CONN_A })
      ).resolves.toEqual(STACK_B);
    });

    it('returns a pinned null over a live detection', async () => {
      const { workflowId } = await createRun('exec-1', { [CONN_B]: null });
      ctx.workflowId = workflowId;
      await expect(
        detection.detectedStackForRun({ detectedStack: STACK_A, id: CONN_B })
      ).resolves.toBeNull();
    });

    it('reads live for an unpinned connection and for a run with no pin', async () => {
      const pinned = await createRun('exec-1', { [CONN_A]: STACK_B });
      ctx.workflowId = pinned.workflowId;
      await expect(
        detection.detectedStackForRun({ detectedStack: STACK_A, id: CONN_B })
      ).resolves.toEqual(STACK_A);
      const bare = await createRun('exec-1');
      ctx.workflowId = bare.workflowId;
      await expect(
        detection.detectedStackForRun({ detectedStack: STACK_A, id: CONN_A })
      ).resolves.toEqual(STACK_A);
    });
  });
});
