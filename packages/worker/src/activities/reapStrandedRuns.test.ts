import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findMany, updateMany } } }));

const describeWf = vi.fn();
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({
    workflow: { getHandle: (id: string) => ({ describe: () => describeWf(id) }) },
  }),
}));
const logWarn = vi.fn();
vi.mock('../lib/activityLog.js', () => ({ logWarn: (...a: unknown[]) => logWarn(...a) }));

const finalizeRun = vi.fn();
vi.mock('./templates.js', () => ({ finalizeRun: (...a: unknown[]) => finalizeRun(...a) }));
const finalizeChannelRun = vi.fn();
vi.mock('./channelRun.js', () => ({
  finalizeChannelRun: (...a: unknown[]) => finalizeChannelRun(...a),
}));

const { NotFound } = vi.hoisted(() => ({ NotFound: class extends Error {} }));
vi.mock('@temporalio/client', () => ({ WorkflowNotFoundError: NotFound }));

import { closedLedgerStatusFor } from '@auto-swe/shared/lib/agentRunAdmission';
import { REAPER_GRACE_MS, reapedStatusFor, reapStrandedRuns } from './reapStrandedRuns.js';

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  channelId: null,
  id,
  reapCheckedAt: null,
  workflowId: `wf-${id}`,
  workRequestId: 'wr',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reapedStatusFor and the ledger mapping', () => {
  it('agree for every Temporal state, COMPLETED reading SUCCESS on the run', () => {
    for (const state of ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'X']) {
      const run = reapedStatusFor(state);
      expect(closedLedgerStatusFor(state === 'X' ? 'FAILED' : state)).toBe(
        run === 'SUCCESS' ? 'COMPLETED' : run
      );
    }
  });
});

describe('reapedStatusFor', () => {
  it('maps a finished Temporal status to a run status', () => {
    expect(reapedStatusFor('COMPLETED')).toBe('SUCCESS');
    expect(reapedStatusFor('FAILED')).toBe('FAILED');
    expect(reapedStatusFor('TIMED_OUT')).toBe('TIMED_OUT');
    expect(reapedStatusFor('TERMINATED')).toBe('CANCELLED');
    expect(reapedStatusFor('CANCELLED')).toBe('CANCELLED');
  });
});

describe('reapStrandedRuns', () => {
  it('asks only for old unfinalized runs, never-checked first, then the longest unchecked', async () => {
    findMany.mockResolvedValue([]);
    const now = new Date('2026-10-04T12:00:00Z');
    await reapStrandedRuns(now);
    const args = findMany.mock.calls[0]?.[0];
    expect(args.orderBy).toEqual([
      { reapCheckedAt: { nulls: 'first', sort: 'asc' } },
      { startedAt: 'asc' },
    ]);
    expect(args.where).toEqual({
      endedAt: null,
      startedAt: { lt: new Date(now.getTime() - REAPER_GRACE_MS) },
    });
    expect(args.take).toBeGreaterThan(0);
  });

  it('finalizes finished and vanished executions through the billing core, never a live one', async () => {
    findMany.mockResolvedValue([run('live'), run('term'), run('gone'), run('done')]);
    const status: Record<string, string | Error> = {
      'wf-done': 'COMPLETED',
      'wf-gone': new NotFound('gone'),
      'wf-live': 'RUNNING',
      'wf-term': 'TERMINATED',
    };
    describeWf.mockImplementation(async (id: string) => {
      const s = status[id];
      if (s instanceof Error) {
        throw s;
      }
      return { closeTime: new Date(), status: { name: s } };
    });

    const result = await reapStrandedRuns();

    expect(result).toEqual({ checked: 4, reaped: 3, unreachable: 0 });
    expect(finalizeRun.mock.calls).toEqual([
      // A just-closed execution still notifies; a vanished one cannot say when it ended.
      ['term', 'CANCELLED', undefined, 'reaper', true],
      ['gone', 'FAILED', undefined, 'reaper', false],
      ['done', 'SUCCESS', undefined, 'reaper', true],
    ]);
  });

  it('stamps the runs it found live, so they rotate behind newer ones', async () => {
    findMany.mockResolvedValue([run('live1'), run('live2'), run('dead')]);
    describeWf.mockImplementation(async (id: string) => ({
      status: { name: id === 'wf-dead' ? 'FAILED' : 'RUNNING' },
    }));
    const now = new Date('2026-10-04T12:00:00Z');
    await reapStrandedRuns(now);
    expect(updateMany).toHaveBeenCalledWith({
      data: { reapCheckedAt: now },
      where: { endedAt: null, id: { in: ['live1', 'live2'] } },
    });
  });

  it('does not stamp a run whose lookup failed: it must stay first in line', async () => {
    findMany.mockResolvedValue([run('a')]);
    describeWf.mockRejectedValue(new Error('unavailable'));
    await reapStrandedRuns();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('suppresses notices for an execution that closed more than an hour ago, and keeps them within it', async () => {
    findMany.mockResolvedValue([run('old'), run('recent'), run('noclose')]);
    const now = new Date('2026-10-04T12:00:00Z');
    const closes: Record<string, Date | undefined> = {
      'wf-noclose': undefined,
      'wf-old': new Date('2026-10-04T10:59:00Z'),
      'wf-recent': new Date('2026-10-04T11:30:00Z'),
    };
    describeWf.mockImplementation(async (id: string) => ({
      closeTime: closes[id],
      status: { name: 'FAILED' },
    }));
    await reapStrandedRuns(now);
    expect(finalizeRun.mock.calls).toEqual([
      ['old', 'FAILED', undefined, 'reaper', false],
      ['recent', 'FAILED', undefined, 'reaper', true],
      ['noclose', 'FAILED', undefined, 'reaper', false],
    ]);
  });

  it('keeps the window open for a run last seen live, up to a day', async () => {
    findMany.mockResolvedValue([
      // Seen live 3 h ago, closed 2 h ago: reached late by the rotation, not neglected.
      run('rotated', { reapCheckedAt: new Date('2026-10-04T09:00:00Z') }),
      // Closed before the check that found it live: the window stays one hour.
      run('before-check', { reapCheckedAt: new Date('2026-10-04T09:00:00Z') }),
      // Last seen live two days ago (the reaper was off): no longer evidence.
      run('stale-check', { reapCheckedAt: new Date('2026-10-02T09:00:00Z') }),
      run('never-seen'),
    ]);
    const now = new Date('2026-10-04T12:00:00Z');
    const closes: Record<string, Date> = {
      'wf-before-check': new Date('2026-10-04T08:00:00Z'),
      'wf-never-seen': new Date('2026-10-04T10:00:00Z'),
      'wf-rotated': new Date('2026-10-04T10:00:00Z'),
      'wf-stale-check': new Date('2026-10-04T10:00:00Z'),
    };
    describeWf.mockImplementation(async (id: string) => ({
      closeTime: closes[id],
      status: { name: 'FAILED' },
    }));
    await reapStrandedRuns(now);
    expect(finalizeRun.mock.calls).toEqual([
      ['rotated', 'FAILED', undefined, 'reaper', true],
      ['before-check', 'FAILED', undefined, 'reaper', false],
      ['stale-check', 'FAILED', undefined, 'reaper', false],
      ['never-seen', 'FAILED', undefined, 'reaper', false],
    ]);
  });

  it('does not stamp a failed finalize while a notice is still owed, so the retry is next sweep', async () => {
    findMany.mockResolvedValue([run('bad')]);
    describeWf.mockResolvedValue({ closeTime: new Date(), status: { name: 'FAILED' } });
    finalizeRun.mockRejectedValueOnce(new Error('db'));
    await reapStrandedRuns();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('stamps a failed finalize once no notice is owed, so it cannot sit first in every sweep', async () => {
    findMany.mockResolvedValue([run('bad'), run('lookup')]);
    describeWf.mockImplementation(async (id: string) => {
      if (id === 'wf-lookup') {
        throw new Error('unavailable');
      }
      return { closeTime: new Date('2026-10-04T08:00:00Z'), status: { name: 'FAILED' } };
    });
    finalizeRun.mockRejectedValueOnce(new Error('db'));
    const now = new Date('2026-10-04T12:00:00Z');
    await reapStrandedRuns(now);
    expect(updateMany).toHaveBeenCalledWith({
      data: { reapCheckedAt: now },
      where: { endedAt: null, id: { in: ['bad'] } },
    });
  });

  it('stamps a failed finalize once its execution closed over an hour ago, though the widened window is still open', async () => {
    const now = new Date('2026-10-04T12:00:00Z');
    // Last seen running 3 h ago, closed 2 h ago: notify is true by the widened
    // window, but the notice is no longer timely, so the failure must not pin it.
    findMany.mockResolvedValue([run('bad', { reapCheckedAt: new Date('2026-10-04T09:00:00Z') })]);
    describeWf.mockResolvedValue({
      closeTime: new Date('2026-10-04T10:00:00Z'),
      status: { name: 'FAILED' },
    });
    finalizeRun.mockRejectedValueOnce(new Error('db'));
    await reapStrandedRuns(now);
    expect(finalizeRun).toHaveBeenCalledWith('bad', 'FAILED', undefined, 'reaper', true);
    expect(updateMany).toHaveBeenCalledWith({
      data: { reapCheckedAt: now },
      where: { endedAt: null, id: { in: ['bad'] } },
    });
  });

  it('logs "without notifying" only when this call really finalized a suppressed run', async () => {
    const old = { closeTime: new Date('2026-10-04T08:00:00Z'), status: { name: 'FAILED' } };
    const said = () =>
      logWarn.mock.calls.some(([m]) => String(m).includes('ended a run without notifying'));
    const now = new Date('2026-10-04T12:00:00Z');
    describeWf.mockResolvedValue(old);

    // Finalized concurrently by someone else: nothing was suppressed by us.
    findMany.mockResolvedValue([run('raced')]);
    finalizeRun.mockResolvedValueOnce(false);
    await reapStrandedRuns(now);
    expect(said()).toBe(false);

    // A channel turn takes no notify at all.
    findMany.mockResolvedValue([run('c', { channelId: 'chan', workRequestId: null })]);
    await reapStrandedRuns(now);
    expect(said()).toBe(false);

    // A real finalize that suppressed.
    findMany.mockResolvedValue([run('real')]);
    finalizeRun.mockResolvedValueOnce(true);
    await reapStrandedRuns(now);
    expect(said()).toBe(true);
  });

  it('leaves a run alone when Temporal cannot be asked', async () => {
    findMany.mockResolvedValue([run('a')]);
    describeWf.mockRejectedValue(new Error('unavailable'));
    const result = await reapStrandedRuns();
    expect(result).toEqual({ checked: 1, reaped: 0, unreachable: 1 });
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(finalizeChannelRun).not.toHaveBeenCalled();
  });

  it('ends a channel turn through the channel path, which bills no org', async () => {
    findMany.mockResolvedValue([run('c', { channelId: 'chan', workRequestId: null })]);
    describeWf.mockResolvedValue({ status: { name: 'TIMED_OUT' } });
    await reapStrandedRuns();
    expect(finalizeChannelRun).toHaveBeenCalledWith({
      source: 'reaper',
      status: 'TIMED_OUT',
      workflowId: 'wf-c',
    });
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it('routes a channel task run (it has a work request) through the core', async () => {
    findMany.mockResolvedValue([run('t', { channelId: 'chan', workRequestId: 'wr' })]);
    describeWf.mockResolvedValue({ closeTime: new Date(), status: { name: 'FAILED' } });
    await reapStrandedRuns();
    expect(finalizeRun).toHaveBeenCalledWith('t', 'FAILED', undefined, 'reaper', true);
    expect(finalizeChannelRun).not.toHaveBeenCalled();
  });

  it('one run failing to finalize does not stop the others', async () => {
    findMany.mockResolvedValue([run('x'), run('y')]);
    describeWf.mockResolvedValue({ status: { name: 'FAILED' } });
    finalizeRun.mockRejectedValueOnce(new Error('db'));
    const result = await reapStrandedRuns();
    expect(result).toEqual({ checked: 2, reaped: 1, unreachable: 1 });
  });
});
