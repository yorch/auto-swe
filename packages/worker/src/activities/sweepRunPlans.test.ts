import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
  expire: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { configAuditLog: { createMany: m.createMany } },
}));
vi.mock('@auto-swe/shared/lib/runPlanSweep', () => ({ expireRunPlans: m.expire }));
vi.mock('../lib/activityLog.js', () => ({ logWarn: m.warn }));

import { sweepRunPlans } from './sweepRunPlans.js';

const NOW = new Date('2026-11-17T12:00:00Z');

beforeEach(() => {
  m.createMany.mockClear();
  m.expire.mockReset();
  m.warn.mockClear();
});

describe('sweepRunPlans', () => {
  it('writes one system audit row per expired plan, by id only', async () => {
    m.expire.mockResolvedValueOnce({
      deleted: 4,
      expired: 2,
      expiredIds: ['p1', 'p2'],
      scrubbed: [],
    });
    expect(await sweepRunPlans(NOW)).toEqual({ deleted: 4, expired: 2, scrubbed: 0 });
    expect(m.expire).toHaveBeenCalledWith(expect.anything(), NOW);
    const [args] = m.createMany.mock.calls[0] ?? [];
    const data = (args as { data: Array<Record<string, unknown>> }).data;
    expect(data.map((r) => r.entityId)).toEqual(['p1', 'p2']);
    expect(data.every((r) => r.actorId === null && r.entityType === 'RunPlan')).toBe(true);
    expect(JSON.stringify(data)).toContain('run_plan.expired');
  });

  it('writes nothing when nothing expired', async () => {
    m.expire.mockResolvedValueOnce({ deleted: 0, expired: 0, expiredIds: [], scrubbed: [] });
    await sweepRunPlans(NOW);
    expect(m.createMany).not.toHaveBeenCalled();
  });

  it('does not fail the sweep when the audit write fails', async () => {
    m.expire.mockResolvedValueOnce({ deleted: 0, expired: 1, expiredIds: ['p1'], scrubbed: [] });
    m.createMany.mockRejectedValueOnce(new Error('db'));
    await expect(sweepRunPlans(NOW)).resolves.toEqual({ deleted: 0, expired: 1, scrubbed: 0 });
    expect(m.warn).toHaveBeenCalled();
  });

  it('writes one system audit row per scrubbed plan, with ids, mode and team and no text', async () => {
    m.expire.mockResolvedValueOnce({
      deleted: 0,
      expired: 0,
      expiredIds: [],
      scrubbed: [
        { id: 'p9', mode: 'delivering', teamId: 't1' },
        { id: 'p8', mode: 'output-only', teamId: 't2' },
      ],
    });
    expect(await sweepRunPlans(NOW)).toEqual({ deleted: 0, expired: 0, scrubbed: 2 });
    const [args] = m.createMany.mock.calls[0] ?? [];
    const data = (args as { data: Array<Record<string, unknown>> }).data;
    expect(data.map((r) => r.entityId)).toEqual(['p9', 'p8']);
    expect(data.every((r) => r.actorId === null && r.entityType === 'RunPlan')).toBe(true);
    expect(data[0]?.afterJson).toEqual({
      event: 'run_plan.scrubbed',
      mode: 'delivering',
      status: 'LAUNCHED',
      teamId: 't1',
    });
  });

  it('does not fail the sweep when the scrub audit write fails', async () => {
    m.expire.mockResolvedValueOnce({
      deleted: 0,
      expired: 0,
      expiredIds: [],
      scrubbed: [{ id: 'p9', mode: 'delivering', teamId: 't1' }],
    });
    m.createMany.mockRejectedValueOnce(new Error('db'));
    await expect(sweepRunPlans(NOW)).resolves.toEqual({ deleted: 0, expired: 0, scrubbed: 1 });
    expect(m.warn).toHaveBeenCalled();
  });
});
