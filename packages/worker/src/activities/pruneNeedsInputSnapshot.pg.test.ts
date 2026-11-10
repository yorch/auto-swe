import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The `needs_input.snapshot` leg of the transcript retention sweep against real Postgres: a paused
 * run's saved working tree is expired once past retention only when its run is over (or it has
 * none). The snapshot of a run still RUNNING is kept however old, because the resume reads it.
 * The predicate is `OR: [{ runId: null }, { run: { status: { not: 'RUNNING' } } }]`, a relation
 * filter a mocked client does not evaluate.
 *
 * Opt in with `NEEDS_INPUT_SNAPSHOT_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy`
 * has been run against (the sweep is deployment-wide, so use a throwaway database).
 */
const enabled = process.env.NEEDS_INPUT_SNAPSHOT_PG_TEST === '1';

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: async () => 30,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!enabled)('needs-input snapshot retention against Postgres', () => {
  let prisma: typeof import('@auto-swe/shared/db').prisma;
  let sweep: typeof import('./pruneAgentTranscripts.js').pruneAgentTranscripts;
  const marker = `snapprune-${randomUUID()}`;
  let templateId = '';
  const runIds: string[] = [];
  const now = new Date();

  const run = async (status: 'RUNNING' | 'SUCCESS') => {
    const row = await prisma.workflowRun.create({
      data: {
        specSnapshot: {},
        status,
        templateId,
        templateVersion: 1,
        workflowId: `${marker}-${runIds.length}`,
      },
    });
    runIds.push(row.id);
    return row.id;
  };
  const snapshot = async (runId: string | null, ageDays: number, kind = 'needs_input.snapshot') =>
    (
      await prisma.workflowArtifact.create({
        data: {
          backend: 'pg',
          createdAt: new Date(now.getTime() - ageDays * DAY_MS),
          inlineBlob: Buffer.from('tree'),
          kind,
          runId,
          sizeBytes: 4,
        },
      })
    ).id;
  const exists = async (id: string) =>
    (await prisma.workflowArtifact.count({ where: { id } })) === 1;

  beforeAll(async () => {
    ({ prisma } = await import('@auto-swe/shared/db'));
    ({ pruneAgentTranscripts: sweep } = await import('./pruneAgentTranscripts.js'));
    templateId = (await prisma.workflowTemplate.create({ data: { name: marker } })).id;
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.workflowArtifact.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.workflowRun.deleteMany({ where: { templateId } });
    await runUnscoped('remove the snapshot test template', ['WorkflowTemplate'], () =>
      prisma.workflowTemplate.deleteMany({ where: { id: templateId } })
    );
    await prisma.$disconnect();
  });

  it('keeps an old snapshot of a RUNNING run and deletes the other expired ones', async () => {
    const running = await run('RUNNING');
    const finished = await run('SUCCESS');
    const keptRunning = await snapshot(running, 90);
    const deletedFinished = await snapshot(finished, 90);
    const deletedOwnerless = await snapshot(null, 90);
    const keptRecent = await snapshot(finished, 1);
    const keptOtherKind = await snapshot(finished, 90, 'other.kind');

    await sweep(now);

    expect(await exists(keptRunning)).toBe(true);
    expect(await exists(deletedFinished)).toBe(false);
    expect(await exists(deletedOwnerless)).toBe(false);
    expect(await exists(keptRecent)).toBe(true);
    expect(await exists(keptOtherKind)).toBe(true);
  });
});
