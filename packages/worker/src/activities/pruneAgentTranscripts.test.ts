import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentTranscriptFindMany = async ({
  take,
  where,
}: {
  take: number;
  where: {
    OR: ({ runId: null } | { run: { transcriptLegalHold: boolean } })[];
    createdAt: { lt: Date };
    legalHold: boolean;
    runLegalHold: boolean;
    status: { not: string };
  };
}) =>
  h.transcripts
    .filter(
      (t) =>
        t.createdAt < where.createdAt.lt &&
        t.legalHold === where.legalHold &&
        (t.runLegalHold ?? false) === where.runLegalHold &&
        t.status !== where.status.not &&
        (t.runId === null || t.run?.transcriptLegalHold === false)
    )
    .slice(0, take)
    .map((t) => ({ id: t.id, parts: t.parts }));

const h = vi.hoisted(() => ({
  accessLog: [] as { createdAt: Date; id: string; outcome?: string; completedAt?: Date }[],
  deletedArtifacts: [] as string[],
  deletedPending: [] as string[],
  deletedTranscripts: [] as string[],
  failingPending: new Set<string>(),
  orphanArtifacts: [] as { id: string }[],
  pendingArtifacts: [] as { createdAt: Date; id: string }[],
  transcripts: [] as {
    createdAt: Date;
    id: string;
    legalHold: boolean;
    runLegalHold?: boolean;
    parts: { artifactId: string }[];
    run?: { transcriptLegalHold: boolean };
    runId: string | null;
    status: string;
    updatedAt: Date;
  }[],
  unscopedCalls: [] as { models: readonly string[]; reason: string }[],
  updates: [] as { data: Record<string, unknown>; where: Record<string, unknown> }[],
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agentTranscript: {
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        h.deletedTranscripts.push(where.id);
        return { count: 1 };
      }),
      findMany: vi.fn((args: Parameters<typeof agentTranscriptFindMany>[0]) =>
        agentTranscriptFindMany(args)
      ),
      updateMany: vi.fn(
        async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
          h.updates.push(args);
          const cutoff = (args.where.updatedAt as { lt: Date }).lt;
          let count = 0;
          for (const t of h.transcripts) {
            if (t.status === 'open' && t.updatedAt < cutoff) {
              t.status = 'abandoned';
              count += 1;
            }
          }
          return { count };
        }
      ),
    },
    configSetting: { findMany: vi.fn(async () => []) },
    transcriptAccessLog: {
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = h.accessLog.length;
        h.accessLog = h.accessLog.filter((r) => !where.id.in.includes(r.id));
        return { count: before - h.accessLog.length };
      }),
      findMany: vi.fn(
        async ({ take, where }: { take: number; where: { createdAt: { lt: Date } } }) =>
          h.accessLog
            .filter((r) => r.createdAt < where.createdAt.lt)
            .slice(0, take)
            .map((r) => ({ id: r.id }))
      ),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: { completedAt: Date; outcome: string };
          where: { createdAt: { lt: Date }; outcome: string };
        }) => {
          let count = 0;
          for (const r of h.accessLog) {
            if ((r.outcome ?? 'ok') === where.outcome && r.createdAt < where.createdAt.lt) {
              Object.assign(r, data);
              count += 1;
            }
          }
          return { count };
        }
      ),
    },
    workflowArtifact: {
      findMany: vi.fn(
        async ({
          take,
          where,
        }: {
          take: number;
          where: { status?: string; createdAt: { lt: Date }; id?: { gt: string } };
        }) =>
          where.status === 'pending'
            ? h.pendingArtifacts
                .filter((a) => a.createdAt < where.createdAt.lt)
                .filter((a) => !where.id || a.id > where.id.gt)
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, take)
                .map((a) => ({ id: a.id }))
            : h.orphanArtifacts
      ),
    },
    workflowHttpCall: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact: vi.fn(async (id: string) => {
    h.deletedArtifacts.push(id);
  }),
  deletePendingArtifact: vi.fn(async (id: string) => {
    if (h.failingPending.has(id)) {
      throw new Error('store down');
    }
    h.deletedPending.push(id);
    return true;
  }),
}));

// The real runUnscoped, wrapped so the test can see the sweep asking for the
// exemption the tenant guard would otherwise deny it.
vi.mock('@auto-swe/shared/lib/tenantGuard', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@auto-swe/shared/lib/tenantGuard')>();
  return {
    ...orig,
    runUnscoped: (reason: string, models: readonly string[], fn: () => unknown) => {
      h.unscopedCalls.push({ models, reason });
      return orig.runUnscoped(reason, models, fn);
    },
  };
});

vi.mock('../lib/activityLog.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { pruneAgentTranscripts } from './pruneAgentTranscripts.js';
import { PRUNE_BATCH, PRUNE_MAX_BATCHES } from './pruneAutomationDecisions.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

beforeEach(() => {
  h.accessLog = [];
  h.failingPending.clear();
  h.deletedArtifacts.length = 0;
  h.deletedPending.length = 0;
  h.pendingArtifacts.length = 0;
  h.deletedTranscripts.length = 0;
  h.orphanArtifacts.length = 0;
  h.transcripts.length = 0;
  h.unscopedCalls.length = 0;
  h.updates.length = 0;
  vi.mocked(prisma.agentTranscript.findMany).mockImplementation(agentTranscriptFindMany as never);
});

describe('pruneAgentTranscripts', () => {
  it('deletes an expired transcript row first, then its parts’ artifacts', async () => {
    h.transcripts.push({
      createdAt: ago(400),
      id: 'tx-1',
      legalHold: false,
      parts: [{ artifactId: 'a1' }, { artifactId: 'a2' }],
      runId: null,
      status: 'complete',
      updatedAt: ago(400),
    });

    const result = await pruneAgentTranscripts(NOW);

    // The transcript (and its cascading parts) goes first: artifactId is
    // Restrict, so an artifact cannot leave while its part row exists.
    expect(h.deletedTranscripts).toEqual(['tx-1']);
    expect(h.deletedArtifacts).toEqual(['a1', 'a2']);
    expect(result.deleted).toBe(1);
    expect(result.more).toBe(false);
  });

  it('keeps an expired transcript under legal hold, and one inside retention', async () => {
    h.transcripts.push(
      {
        createdAt: ago(400),
        id: 'held',
        legalHold: true,
        parts: [{ artifactId: 'a1' }],
        runId: null,
        status: 'complete',
        updatedAt: ago(400),
      },
      {
        createdAt: ago(10),
        id: 'fresh',
        legalHold: false,
        parts: [],
        runId: null,
        status: 'complete',
        updatedAt: ago(10),
      }
    );

    const result = await pruneAgentTranscripts(NOW);

    expect(h.deletedTranscripts).toEqual([]);
    expect(h.deletedArtifacts).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  it('keeps an expired transcript while its run carries a legal hold, and never deletes an open one', async () => {
    // The run hold can land between the recorder's run read and its row
    // insert, so the row's own legalHold is false — the relation wins.
    h.transcripts.push(
      {
        createdAt: ago(400),
        id: 'run-held',
        legalHold: false,
        parts: [{ artifactId: 'a1' }],
        run: { transcriptLegalHold: true },
        runId: 'r-1',
        status: 'complete',
        updatedAt: ago(400),
      },
      {
        createdAt: ago(400),
        id: 'still-open',
        legalHold: false,
        parts: [{ artifactId: 'a2' }],
        runId: null,
        status: 'open',
        updatedAt: ago(400),
      },
      {
        createdAt: ago(400),
        id: 'gone',
        legalHold: false,
        parts: [{ artifactId: 'a3' }],
        run: { transcriptLegalHold: false },
        runId: 'r-2',
        status: 'complete',
        updatedAt: ago(400),
      }
    );

    const result = await pruneAgentTranscripts(NOW);

    expect(h.deletedTranscripts).toEqual(['gone']);
    expect(h.deletedArtifacts).toEqual(['a3']);
    expect(result.deleted).toBe(1);
  });

  it('marks a stale open transcript abandoned and leaves a fresh one alone', async () => {
    h.transcripts.push(
      {
        createdAt: ago(30),
        id: 'stale',
        legalHold: false,
        parts: [],
        runId: null,
        status: 'open',
        updatedAt: ago(2),
      },
      {
        createdAt: ago(30),
        id: 'live',
        legalHold: false,
        parts: [],
        runId: null,
        status: 'open',
        updatedAt: new Date(NOW.getTime() - DAY / 4),
      }
    );

    const result = await pruneAgentTranscripts(NOW);

    // Neither is past the 365-day retention; the stale one is abandoned.
    expect(h.deletedTranscripts).toEqual([]);
    expect(result.abandoned).toBe(1);
    expect(h.transcripts.find((t) => t.id === 'stale')?.status).toBe('abandoned');
    expect(h.transcripts.find((t) => t.id === 'live')?.status).toBe('open');
    expect(h.updates[0]?.data).toEqual({ status: 'abandoned' });
  });

  it('deletes orphan part artifacts and reports the count', async () => {
    h.orphanArtifacts.push({ id: 'orphan-1' }, { id: 'orphan-2' });

    const result = await pruneAgentTranscripts(NOW);

    expect(h.deletedArtifacts.sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(result.orphanArtifacts).toBe(2);
  });

  it('deletes day-old pending artifacts through the write-ahead cleanup and reports the count', async () => {
    h.pendingArtifacts.push(
      { createdAt: ago(2), id: 'pending-old' },
      { createdAt: new Date(NOW.getTime() - DAY / 4), id: 'pending-fresh' }
    );

    const result = await pruneAgentTranscripts(NOW);

    // A fresh pending row may be an upload still in flight; only the stale one goes.
    expect(h.deletedPending).toEqual(['pending-old']);
    expect(result.pendingArtifacts).toBe(1);
    const pendingQuery = vi
      .mocked(prisma.workflowArtifact.findMany)
      .mock.calls.map((c) => c[0] as { where: Record<string, unknown> })
      .find((a) => a.where.status === 'pending');
    expect(pendingQuery?.where.createdAt).toEqual({ lt: ago(1) });
  });

  it('keeps sweeping after one pending artifact fails, and counts the failure', async () => {
    h.pendingArtifacts.push(
      { createdAt: ago(2), id: 'p-1' },
      { createdAt: ago(2), id: 'p-2' },
      { createdAt: ago(2), id: 'p-3' }
    );
    h.failingPending.add('p-2');
    h.orphanArtifacts.push({ id: 'orphan-1' });

    const result = await pruneAgentTranscripts(NOW);

    expect(h.deletedPending).toEqual(['p-1', 'p-3']);
    expect(result.pendingArtifacts).toBe(2);
    expect(result.pendingArtifactFailures).toBe(1);
    // The passes after it still ran.
    expect(h.deletedArtifacts).toEqual(['orphan-1']);
  });

  it('walks pending artifacts in batches by id and reports more at the limit', async () => {
    const total = PRUNE_BATCH + 3;
    for (let i = 0; i < total; i++) {
      h.pendingArtifacts.push({ createdAt: ago(2), id: `p-${String(i).padStart(6, '0')}` });
    }
    const result = await pruneAgentTranscripts(NOW);
    expect(result.pendingArtifacts).toBe(total);
    expect(result.more).toBe(false);
  });

  it('leaves pending parts to the pending pass, not the orphan pass', async () => {
    await pruneAgentTranscripts(NOW);
    const orphanQuery = vi
      .mocked(prisma.workflowArtifact.findMany)
      .mock.calls.map((c) => c[0] as { where: Record<string, unknown> })
      .find((a) => a.where.kind === 'agent-transcript-part');
    expect(orphanQuery?.where.status).toBe('ready');
  });

  it('marks access rows still started after an hour as aborted', async () => {
    h.accessLog.push(
      { createdAt: new Date(NOW.getTime() - 2 * 3_600_000), id: 'stale', outcome: 'started' },
      { createdAt: new Date(NOW.getTime() - 10 * 60_000), id: 'live', outcome: 'started' },
      { createdAt: new Date(NOW.getTime() - 2 * 3_600_000), id: 'done', outcome: 'ok' }
    );

    const result = await pruneAgentTranscripts(NOW);

    expect(result.accessLogReconciled).toBe(1);
    expect(h.accessLog.find((r) => r.id === 'stale')).toMatchObject({
      completedAt: NOW,
      outcome: 'aborted',
    });
    expect(h.accessLog.find((r) => r.id === 'live')?.outcome).toBe('started');
    expect(h.accessLog.find((r) => r.id === 'done')?.outcome).toBe('ok');
  });

  it('prunes access-log rows past their own retention, keeping younger ones', async () => {
    // Default retention is 2555 days.
    h.accessLog.push(
      { createdAt: ago(2600), id: 'old' },
      { createdAt: ago(2000), id: 'kept' },
      { createdAt: ago(1), id: 'new' }
    );

    const result = await pruneAgentTranscripts(NOW);

    expect(result.accessLogRetentionDays).toBe(2555);
    expect(result.accessLogDeleted).toBe(1);
    expect(h.accessLog.map((r) => r.id)).toEqual(['kept', 'new']);
  });

  it('prunes the access log in batches', async () => {
    h.accessLog = Array.from({ length: PRUNE_BATCH + 5 }, (_, i) => ({
      createdAt: ago(3000),
      id: `a-${i}`,
    }));
    vi.mocked(prisma.transcriptAccessLog.deleteMany).mockClear();

    const result = await pruneAgentTranscripts(NOW);

    expect(result.accessLogDeleted).toBe(PRUNE_BATCH + 5);
    expect(prisma.transcriptAccessLog.deleteMany).toHaveBeenCalledTimes(2);
    expect(result.more).toBe(false);
  });

  it('stops at its batch limit and reports more', async () => {
    // Every batch comes back full, so the sweep must stop itself at
    // PRUNE_MAX_BATCHES rather than draining the table in one pass.
    vi.mocked(prisma.agentTranscript.findMany).mockImplementation((async ({
      take,
    }: {
      take: number;
    }) => Array.from({ length: take }, (_, i) => ({ id: `tx-${i}`, parts: [] }))) as never);

    const result = await pruneAgentTranscripts(NOW);

    expect(result.deleted).toBe(PRUNE_BATCH * PRUNE_MAX_BATCHES);
    expect(result.more).toBe(true);
  });

  it('uses model-specific exemptions for transcript and HTTP retention', async () => {
    h.transcripts.push({
      createdAt: ago(30),
      id: 't',
      legalHold: false,
      parts: [],
      runId: null,
      status: 'open',
      updatedAt: ago(2),
    });
    await pruneAgentTranscripts(NOW);

    const transcriptCalls = h.unscopedCalls.filter((call) =>
      call.models.includes('AgentTranscript')
    );
    const httpCalls = h.unscopedCalls.filter((call) => call.models.includes('WorkflowHttpCall'));
    expect(transcriptCalls.length).toBeGreaterThanOrEqual(2);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.models).toEqual(['WorkflowHttpCall']);
    expect(h.unscopedCalls).toHaveLength(transcriptCalls.length + httpCalls.length);
    for (const call of transcriptCalls) {
      expect(call.models).toEqual(['AgentTranscript']);
    }
  });
});
