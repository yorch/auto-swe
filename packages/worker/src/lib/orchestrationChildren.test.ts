import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  artifactBody: '' as string,
  artifactFails: false,
  artifactRow: true,
  childStatus: 'RUNNING',
  created: [] as Array<Record<string, unknown>>,
  finishedChildren: [] as Array<{ endedAt: Date; id: string; status: string }>,
  known: new Set<string>(),
  messageRows: [] as Array<{ childId: string; id: string; payload: unknown }>,
  notices: [] as Array<{ code: string; body: string }>,
  runIdSet: null as string | null,
  signal: vi.fn(),
  snapshotOverride: null as unknown,
  updates: [] as Array<Record<string, unknown>>,
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    orchestrationChild: {
      findFirst: vi.fn(
        async ({ where }: { where: { orchestrationId: string; workRequestId: string } }) =>
          m.known.has(`${where.orchestrationId}:${where.workRequestId}`)
            ? { id: 'child-1', status: m.childStatus }
            : null
      ),
      findMany: vi.fn(async () => m.finishedChildren),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: { status: { in: string[] } };
        }) => {
          if (!where.status.in.includes(m.childStatus)) {
            return { count: 0 };
          }
          m.updates.push(data);
          m.childStatus = String(data.status);
          if (typeof data.runId === 'string') {
            m.runIdSet = data.runId;
          }
          return { count: 1 };
        }
      ),
    },
    orchestrationMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        m.created.push(data);
        return data;
      }),
      findMany: vi.fn(async () => m.messageRows),
      update: vi.fn(async () => ({})),
    },
    workflowArtifact: { findFirst: vi.fn(async () => (m.artifactRow ? { id: 'art' } : null)) },
    workflowRun: {
      findUnique: vi.fn(async () => ({
        contextSnapshot: m.snapshotOverride ?? {
          result: {
            branch: 'auto/agent-1',
            filesChanged: [
              { linesAdded: 4, linesRemoved: 2, operation: 'MODIFY', path: 'src/a.ts' },
            ],
            gate: 'passed',
            prUrl: 'https://github.com/o/r/pull/9',
            stoppedReason: 'max_steps',
            text: 'Done. token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
          },
        },
        costUsdAccrued: 1.25,
        endedAt: new Date(),
        id: 'run-1',
        orchestrationId: 'orch-1',
        status: 'SUCCESS',
        steps: [],
        workRequestId: 'wr-1',
      })),
    },
  },
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  getArtifactStream: vi.fn(async () => {
    if (m.artifactFails) {
      throw new Error('store down');
    }
    const { Readable } = await import('node:stream');
    return { ref: {}, sizeBytes: m.artifactBody.length, stream: Readable.from([m.artifactBody]) };
  }),
}));
vi.mock('./orchestrationState.js', () => ({
  writeNotice: vi.fn(async (_o: string, code: string, body: string) => {
    m.notices.push({ body, code });
  }),
}));
vi.mock('./temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { getHandle: () => ({ signal: m.signal }) } }),
}));

import {
  buildChildResult,
  childOrchestrationIdOf,
  completeOrchestrationChild,
  findUnseenChildResults,
  markChildResultsSeen,
  markChildRunStarted,
  onOrchestrationRunFinalized,
  unreadChildIds,
} from './orchestrationChildren.js';

const ORCH = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

beforeEach(() => {
  m.known = new Set(['orch-1:wr-1', `${ORCH}:wr-1`]);
  m.runIdSet = null;
  m.childStatus = 'RUNNING';
  m.created = [];
  m.updates = [];
  m.artifactBody = '';
  m.artifactFails = false;
  m.artifactRow = true;
  m.finishedChildren = [];
  m.messageRows = [];
  m.notices = [];
  m.snapshotOverride = null;
  m.signal.mockReset();
  m.signal.mockResolvedValue(undefined);
});

describe('buildChildResult', () => {
  it('builds the structured result from the run output', () => {
    const r = buildChildResult({
      costUsd: 2,
      snapshot: {
        result: {
          branch: 'b',
          filesChanged: [{ linesAdded: 1, linesRemoved: 0, path: 'a.ts' }],
          gate: 'passed',
          prUrl: 'https://x.test/pr/1',
          text: 'hello',
        },
      },
      status: 'SUCCESS',
    });
    expect(r).toMatchObject({
      branch: 'b',
      costUsd: 2,
      filesChanged: [{ added: 1, path: 'a.ts', removed: 0 }],
      gate: 'passed',
      prUrl: 'https://x.test/pr/1',
      status: 'COMPLETED',
      summary: 'hello',
    });
  });

  it('stores an https pull request URL only', () => {
    const r = buildChildResult({
      costUsd: 0,
      snapshot: { result: { prUrl: 'javascript:alert(1)', text: 't' } },
      status: 'SUCCESS',
    });
    expect(r.prUrl).toBeUndefined();
    expect(
      buildChildResult({
        costUsd: 0,
        snapshot: { result: { prUrl: 'http://x.test/1' } },
        status: 'SUCCESS',
      }).prUrl
    ).toBeUndefined();
  });

  it.each([
    ['FAILED', 'FAILED'],
    ['TIMED_OUT', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
    ['SKIPPED', 'COMPLETED'],
  ])('maps run status %s to %s and explains a failure', (run, child) => {
    const r = buildChildResult({
      costUsd: 0,
      failure: 'gate refused the push',
      snapshot: {},
      status: run,
    });
    expect(r.status).toBe(child);
    if (child === 'FAILED') {
      expect(r.summary).toContain('gate refused the push');
      expect(r.gate).toBe('failed');
    }
  });

  it('truncates a very long summary', () => {
    const r = buildChildResult({
      costUsd: 0,
      snapshot: { result: { text: 'x'.repeat(100_000) } },
      status: 'SUCCESS',
    });
    expect(r.summary.length).toBeLessThanOrEqual(20_000);
  });
});

describe('completing a child', () => {
  it('stores a redacted result once and leaves an unread CHILD_RESULT message', async () => {
    const done = await completeOrchestrationChild('run-1');
    expect(done).toEqual({ childId: 'child-1', orchestrationId: 'orch-1' });
    expect(m.updates[0]).toMatchObject({ costUsd: 1.25, runId: 'run-1', status: 'COMPLETED' });
    expect(JSON.stringify(m.updates[0])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(m.created[0]).toMatchObject({
      kind: 'CHILD_RESULT',
      payload: { childId: 'child-1', seen: false, status: 'COMPLETED' },
    });
    // A second report of the same finish does nothing.
    expect(await completeOrchestrationChild('run-1')).toBeNull();
    expect(m.created).toHaveLength(1);
  });

  it('signals the orchestrator workflow when it moved the child', async () => {
    await onOrchestrationRunFinalized('run-1');
    expect(m.signal).toHaveBeenCalledWith('childFinished', { childId: 'child-1' });
  });

  it('tolerates a failed signal: nothing throws and the result stays recorded', async () => {
    m.signal.mockRejectedValue(new Error('workflow not found'));
    await expect(onOrchestrationRunFinalized('run-1')).resolves.toBeUndefined();
    expect(m.childStatus).toBe('COMPLETED');
  });
});

describe('child lifecycle: run creation to finalization', () => {
  it('confirms the payload orchestration against the child row, never the payload alone', async () => {
    await expect(childOrchestrationIdOf({ orchestrationId: ORCH }, 'wr-1')).resolves.toBe(ORCH);
    // Another request id, a forged orchestration id, a malformed id and a missing payload.
    await expect(childOrchestrationIdOf({ orchestrationId: ORCH }, 'wr-9')).resolves.toBeNull();
    await expect(
      childOrchestrationIdOf({ orchestrationId: '11111111-4f5a-4b6c-8d7e-9f0a1b2c3d4e' }, 'wr-1')
    ).resolves.toBeNull();
    await expect(childOrchestrationIdOf({ orchestrationId: 'nope' }, 'wr-1')).resolves.toBeNull();
    await expect(childOrchestrationIdOf(null, 'wr-1')).resolves.toBeNull();
    await expect(childOrchestrationIdOf({ orchestrationId: ORCH }, undefined)).resolves.toBeNull();
  });

  it('reaches RUNNING with a runId, then finalization stores the result, the message and the signal', async () => {
    m.childStatus = 'STARTING';
    const started = await markChildRunStarted({
      orchestrationId: 'orch-1',
      runId: 'run-1',
      workRequestId: 'wr-1',
    });
    expect(started).toBe(true);
    expect(m.childStatus).toBe('RUNNING');
    expect(m.runIdSet).toBe('run-1');
    // Idempotent while it runs.
    await expect(
      markChildRunStarted({ orchestrationId: 'orch-1', runId: 'run-1', workRequestId: 'wr-1' })
    ).resolves.toBe(true);

    await onOrchestrationRunFinalized('run-1');

    const finished = m.updates.at(-1) as { resultJson: { status: string }; status: string };
    expect(finished.status).toBe('COMPLETED');
    expect(finished.resultJson.status).toBe('COMPLETED');
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({ childId: 'child-1', kind: 'CHILD_RESULT' });
    expect(m.signal).toHaveBeenCalledWith('childFinished', { childId: 'child-1' });
    // A finished child never moves back to RUNNING.
    await expect(
      markChildRunStarted({ orchestrationId: 'orch-1', runId: 'run-1', workRequestId: 'wr-1' })
    ).resolves.toBe(false);
    expect(m.childStatus).toBe('COMPLETED');
  });
});

const storedSummary = (): string =>
  (m.updates[0] as { resultJson: { summary: string } }).resultJson.summary;
const marker = (id: string, bytes: number) => `[stored as artifact ${id} \u2014 ${bytes} bytes]`;
const ART = '11111111-2222-4333-8444-555555555555';

describe('a result the snapshot spilled to an artifact', () => {
  const spilled = (text: string) => ({ result: { gate: 'not_applicable', text } });

  it('reads the real 12k-character text back instead of storing the placeholder', async () => {
    const full = `${'finding. '.repeat(1500)}END`;
    expect(full.length).toBeGreaterThan(12_000);
    m.artifactBody = full;
    m.snapshotOverride = spilled(marker(ART, full.length));
    await completeOrchestrationChild('run-1');
    const stored = { summary: storedSummary() };
    expect(stored.summary).not.toContain('stored as artifact');
    expect(stored.summary.startsWith('finding. finding.')).toBe(true);
    expect(stored.summary.length).toBe(full.length);
  });

  it('bounds the text read back to the result limit', async () => {
    m.artifactBody = 'x'.repeat(200_000);
    m.snapshotOverride = spilled(marker(ART, 200_000));
    await completeOrchestrationChild('run-1');
    expect(storedSummary().length).toBe(20_000);
  });

  it.each([
    [
      "the artifact is not this run's ready spill",
      () => {
        m.artifactRow = false;
      },
    ],
    [
      'the store cannot be read',
      () => {
        m.artifactFails = true;
      },
    ],
  ])('falls back to the placeholder with an explicit note when %s', async (_n, arrange) => {
    arrange();
    m.snapshotOverride = spilled(marker(ART, 12_000));
    await completeOrchestrationChild('run-1');
    const summary = storedSummary();
    expect(summary).toContain(`stored as artifact ${ART}`);
    expect(summary).toContain('could not be read');
  });

  it('does not touch the store for ordinary text', async () => {
    m.snapshotOverride = spilled('plain text');
    await completeOrchestrationChild('run-1');
    expect(storedSummary()).toBe('plain text');
  });
});

describe('a result that breaks the contract', () => {
  it('still finishes the child, as a FAILED result that names fields and no values', async () => {
    const built = buildChildResult({
      costUsd: 1,
      snapshot: { result: { branch: 'bad..branch name', text: 'fine' } },
      status: 'SUCCESS',
    });
    expect(built.status).toBe('FAILED');
    expect(built.summary).toContain('branch');
    expect(built.summary).not.toContain('bad..branch name');
    expect(built.costUsd).toBe(1);
  });

  it('completes the child and leaves a notice', async () => {
    m.snapshotOverride = { result: { branch: 'bad..branch name', text: 'fine' } };
    const done = await completeOrchestrationChild('run-1');
    expect(done).toEqual({ childId: 'child-1', orchestrationId: 'orch-1' });
    expect(m.childStatus).toBe('FAILED');
    expect(m.notices[0]).toMatchObject({ code: 'CHILD_RESULT_INVALID' });
  });
});

describe('the result message is not the only record', () => {
  it('re-creates a CHILD_RESULT message from the stored result when the write was lost', async () => {
    m.finishedChildren = [{ endedAt: new Date(0), id: 'c-lost', status: 'COMPLETED' }];
    m.messageRows = [];
    await expect(findUnseenChildResults('orch-1', 0)).resolves.toEqual(['c-lost']);
    expect(m.created).toContainEqual(
      expect.objectContaining({
        childId: 'c-lost',
        kind: 'CHILD_RESULT',
        payload: { childId: 'c-lost', seen: false, status: 'COMPLETED' },
      })
    );
  });

  it('skips a child whose result a turn has read', async () => {
    m.finishedChildren = [{ endedAt: new Date(0), id: 'c1', status: 'COMPLETED' }];
    m.messageRows = [{ childId: 'c1', id: 'm1', payload: { seen: true } }];
    await expect(findUnseenChildResults('orch-1', 0)).resolves.toEqual([]);
    expect(m.created).toHaveLength(0);
  });

  it('counts a child with no message as unread, and marking it seen writes the message', async () => {
    m.messageRows = [];
    await expect(unreadChildIds('orch-1', ['c-lost'])).resolves.toEqual(new Set(['c-lost']));
    await markChildResultsSeen('orch-1', ['c-lost']);
    expect(m.created).toContainEqual(
      expect.objectContaining({
        childId: 'c-lost',
        payload: expect.objectContaining({ seen: true }),
      })
    );
  });
});
