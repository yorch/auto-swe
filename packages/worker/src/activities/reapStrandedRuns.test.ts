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
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));

const finalizeRun = vi.fn();
vi.mock('./templates.js', () => ({ finalizeRun: (...a: unknown[]) => finalizeRun(...a) }));
const finalizeChannelRun = vi.fn();
vi.mock('./channelRun.js', () => ({
  finalizeChannelRun: (...a: unknown[]) => finalizeChannelRun(...a),
}));

const { NotFound } = vi.hoisted(() => ({ NotFound: class extends Error {} }));
vi.mock('@temporalio/client', () => ({ WorkflowNotFoundError: NotFound }));

import { REAPER_GRACE_MS, reapedStatusFor, reapStrandedRuns } from './reapStrandedRuns.js';

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  channelId: null,
  id,
  workflowId: `wf-${id}`,
  workRequestId: 'wr',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
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
      return { status: { name: s } };
    });

    const result = await reapStrandedRuns();

    expect(result).toEqual({ checked: 4, reaped: 3, unreachable: 0 });
    expect(finalizeRun.mock.calls).toEqual([
      ['term', 'CANCELLED', undefined, 'reaper'],
      ['gone', 'FAILED', undefined, 'reaper'],
      ['done', 'SUCCESS', undefined, 'reaper'],
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
    describeWf.mockResolvedValue({ status: { name: 'FAILED' } });
    await reapStrandedRuns();
    expect(finalizeRun).toHaveBeenCalledWith('t', 'FAILED', undefined, 'reaper');
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
