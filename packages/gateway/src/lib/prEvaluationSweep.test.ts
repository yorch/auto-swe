import type { FastifyBaseLogger } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_SWEEP_CAP,
  REPOSITORY_SWEEP_CAP,
  resetSweepDebounceForTests,
  SWEEP_DEBOUNCE_MS,
  sweepArmedPullRequests,
} from './prEvaluationSweep.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

type Latest = {
  autoMergeEnabled: boolean;
  closedAt: Date | null;
  connectionId: string;
  mergedAt: Date | null;
  prNumber: number;
};

function setup() {
  const findMany = vi.fn();
  const start = vi.fn(async (_id: string, _input: unknown) => {});
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const fastify = {
    prisma: { prEvaluation: { findMany } },
    temporal: { startPrEvaluationWorkflow: start },
  } as unknown as Parameters<typeof sweepArmedPullRequests>[0];
  const run = (opts: Parameters<typeof sweepArmedPullRequests>[2]) =>
    sweepArmedPullRequests(fastify, log as unknown as FastifyBaseLogger, opts);
  return { findMany, log, run, start };
}

const armedRow = (connectionId: string, prNumber: number): Latest => ({
  autoMergeEnabled: true,
  closedAt: null,
  connectionId,
  mergedAt: null,
  prNumber,
});

describe('sweepArmedPullRequests', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    resetSweepDebounceForTests();
    t = setup();
  });

  it('starts a disarm-sweep evaluation per armed open pull request, with ids unique per sweep', async () => {
    t.findMany
      .mockResolvedValueOnce([
        { connectionId: CONN, prNumber: 1 },
        { connectionId: OTHER, prNumber: 1 },
      ])
      .mockResolvedValueOnce([armedRow(CONN, 1), armedRow(OTHER, 1)]);
    const first = await t.run({ cap: 200 });
    expect(first).toEqual({ failed: 0, found: 2, started: 2, truncated: false });
    expect(t.start.mock.calls.map((c) => c[1])).toEqual([
      { connectionId: CONN, prNumber: 1, trigger: 'disarm-sweep' },
      { connectionId: OTHER, prNumber: 1, trigger: 'disarm-sweep' },
    ]);
    t.findMany
      .mockResolvedValueOnce([{ connectionId: CONN, prNumber: 1 }])
      .mockResolvedValueOnce([armedRow(CONN, 1)]);
    await t.run({ cap: 200 });
    // The same pull request in two sweeps never shares a workflow id.
    expect(t.start.mock.calls[0][0]).not.toBe(t.start.mock.calls[2][0]);
  });

  it('scopes the candidate read to one repository when asked', async () => {
    t.findMany.mockResolvedValueOnce([]);
    await t.run({ cap: REPOSITORY_SWEEP_CAP, connectionId: CONN });
    expect(t.findMany.mock.calls[0][0].where).toMatchObject({
      closedAt: null,
      connectionId: CONN,
      mergedAt: null,
      OR: [{ autoMergeEnabled: true }, { botApproved: true }],
    });
    expect(t.start).not.toHaveBeenCalled();
  });

  it('selects, deployment-wide, armed pull requests and those of repositories with bot approval', async () => {
    t.findMany.mockResolvedValueOnce([]);
    await t.run({ cap: GLOBAL_SWEEP_CAP });
    const where = t.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ closedAt: null, mergedAt: null });
    expect(where.OR).toEqual([
      { autoMergeEnabled: true },
      { botApproved: true },
      { connection: { prEvaluationBotApproval: true } },
    ]);
    expect(where).not.toHaveProperty('autoMergeEnabled');
  });

  it('selects every open pull request of one repository when asked, armed or not', async () => {
    t.findMany
      .mockResolvedValueOnce([{ connectionId: CONN, prNumber: 4 }])
      .mockResolvedValueOnce([{ ...armedRow(CONN, 4), autoMergeEnabled: false }]);
    const res = await t.run({ allOpen: true, cap: REPOSITORY_SWEEP_CAP, connectionId: CONN });
    const where = t.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ closedAt: null, connectionId: CONN, mergedAt: null });
    expect(res).toMatchObject({ found: 1, started: 1 });
  });

  it('sweeps a pull request whose newest row is unarmed but an older row armed it', async () => {
    // Concurrent evaluations can leave the newest row unarmed while GitHub is still armed.
    t.findMany
      .mockResolvedValueOnce([{ connectionId: CONN, prNumber: 2 }])
      .mockResolvedValueOnce([
        { ...armedRow(CONN, 2), autoMergeEnabled: false },
        armedRow(CONN, 2),
      ]);
    const res = await t.run({ cap: 200 });
    expect(res).toMatchObject({ found: 1, started: 1 });
  });

  it('skips a pull request whose newest row is closed or merged', async () => {
    t.findMany
      .mockResolvedValueOnce([1, 2, 3].map((n) => ({ connectionId: CONN, prNumber: n })))
      .mockResolvedValueOnce([
        armedRow(CONN, 1),
        { ...armedRow(CONN, 2), mergedAt: new Date() },
        { ...armedRow(CONN, 3), closedAt: new Date() },
      ]);
    const res = await t.run({ cap: 200 });
    expect(res.found).toBe(1);
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('skips a repository whose sweep started less than a minute ago, and not another', async () => {
    vi.useFakeTimers();
    try {
      t.findMany
        .mockResolvedValue([{ connectionId: CONN, prNumber: 1 }])
        .mockResolvedValueOnce([{ connectionId: CONN, prNumber: 1 }])
        .mockResolvedValueOnce([armedRow(CONN, 1)]);
      expect(await t.run({ cap: 200, connectionId: CONN })).toMatchObject({ started: 1 });
      const again = await t.run({ cap: 200, connectionId: CONN });
      expect(again).toMatchObject({ debounced: true, started: 0 });
      expect(t.start).toHaveBeenCalledTimes(1);
      expect(t.log.info.mock.calls[0][0]).toMatchObject({ connectionId: CONN });
      // Another repository, and a deployment-wide sweep, are not held back.
      t.findMany.mockResolvedValueOnce([]);
      expect(await t.run({ cap: 200, connectionId: OTHER })).not.toHaveProperty('debounced');
      t.findMany.mockResolvedValueOnce([]);
      expect(await t.run({ cap: 200 })).not.toHaveProperty('debounced');
      // After the window it runs again.
      vi.advanceTimersByTime(SWEEP_DEBOUNCE_MS + 1);
      t.findMany
        .mockResolvedValueOnce([{ connectionId: CONN, prNumber: 1 }])
        .mockResolvedValueOnce([armedRow(CONN, 1)]);
      expect(await t.run({ cap: 200, connectionId: CONN })).toMatchObject({ started: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the sweep, starts only cap pull requests and logs the truncation', async () => {
    const cap = 3;
    const nums = [1, 2, 3, 4, 5];
    t.findMany
      .mockResolvedValueOnce(nums.map((n) => ({ connectionId: CONN, prNumber: n })))
      .mockResolvedValueOnce(nums.map((n) => armedRow(CONN, n)));
    const res = await t.run({ cap });
    expect(res).toMatchObject({ found: 3, started: 3, truncated: true });
    expect(t.start).toHaveBeenCalledTimes(3);
    expect(t.log.warn).toHaveBeenCalledOnce();
  });

  it('reads at most a bounded number of candidates', async () => {
    t.findMany.mockResolvedValueOnce([]);
    await t.run({ cap: GLOBAL_SWEEP_CAP });
    expect(t.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(GLOBAL_SWEEP_CAP * 3);
  });

  it('isolates a failed start and logs it with the connection id', async () => {
    t.findMany
      .mockResolvedValueOnce([1, 2, 3].map((n) => ({ connectionId: CONN, prNumber: n })))
      .mockResolvedValueOnce([1, 2, 3].map((n) => armedRow(CONN, n)));
    t.start.mockRejectedValueOnce(new Error('temporal unreachable'));
    const res = await t.run({ cap: 200 });
    expect(res).toMatchObject({ failed: 1, found: 3, started: 2 });
    expect(t.start).toHaveBeenCalledTimes(3);
    expect(t.log.error.mock.calls[0][0]).toMatchObject({ connectionId: CONN, prNumber: 1 });
  });

  it('never throws when the database fails', async () => {
    t.findMany.mockRejectedValueOnce(new Error('db down'));
    const res = await t.run({ cap: 200, connectionId: CONN });
    expect(res).toEqual({ failed: 0, found: 0, started: 0, truncated: false });
    expect(t.log.error).toHaveBeenCalledOnce();
  });
});
