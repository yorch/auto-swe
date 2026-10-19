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
    status: { not: string };
  };
}) =>
  h.transcripts
    .filter(
      (t) =>
        t.createdAt < where.createdAt.lt &&
        t.legalHold === where.legalHold &&
        t.status !== where.status.not &&
        (t.runId === null || t.run?.transcriptLegalHold === false)
    )
    .slice(0, take)
    .map((t) => ({ id: t.id, parts: t.parts }));

const h = vi.hoisted(() => ({
  deletedArtifacts: [] as string[],
  deletedTranscripts: [] as string[],
  orphanArtifacts: [] as { id: string }[],
  transcripts: [] as {
    createdAt: Date;
    id: string;
    legalHold: boolean;
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
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        h.deletedTranscripts.push(where.id);
        return {};
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
    workflowArtifact: {
      findMany: vi.fn(async () => h.orphanArtifacts),
    },
  },
}));

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact: vi.fn(async (id: string) => {
    h.deletedArtifacts.push(id);
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
  h.deletedArtifacts.length = 0;
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

  it('reads and writes AgentTranscript only inside runUnscoped', async () => {
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

    expect(h.unscopedCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of h.unscopedCalls) {
      expect(call.models).toEqual(['AgentTranscript']);
    }
  });
});
