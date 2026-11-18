import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_RETENTION_MS, EXPIRE_BATCH, expireRunPlans } from './runPlanSweep.js';

const NOW = new Date('2026-11-17T12:00:00Z');

function fake(due: string[], stillExpired: string[], deleted = 0) {
  return {
    runPlan: {
      deleteMany: vi.fn(async (_args: unknown) => ({ count: deleted })),
      findMany: vi
        .fn()
        .mockResolvedValueOnce(due.map((id) => ({ id })))
        .mockResolvedValueOnce(stillExpired.map((id) => ({ id }))),
      updateMany: vi.fn(async (_args: unknown) => ({ count: due.length })),
    },
  };
}

describe('expireRunPlans', () => {
  it('expires the due plans by id and reports only the ones that are now EXPIRED', async () => {
    // p2 was approved (its expiry extended) between the read and the write.
    const prisma = fake(['p1', 'p2'], ['p1'], 3);
    const result = await expireRunPlans(prisma as never, NOW);
    expect(result).toEqual({ deleted: 3, expired: 1, expiredIds: ['p1'] });
    expect(prisma.runPlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'EXPIRED' },
      where: {
        expiresAt: { lte: NOW },
        id: { in: ['p1', 'p2'] },
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    expect(prisma.runPlan.findMany.mock.calls[0]?.[0]).toMatchObject({ take: EXPIRE_BATCH });
  });

  it('deletes expired and rejected plans past retention, and never names LAUNCHED', async () => {
    const prisma = fake([], []);
    await expireRunPlans(prisma as never, NOW);
    expect(prisma.runPlan.updateMany).not.toHaveBeenCalled();
    expect(prisma.runPlan.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date(NOW.getTime() - DEFAULT_PLAN_RETENTION_MS) },
        status: { in: ['EXPIRED', 'REJECTED'] },
      },
    });
    expect(
      JSON.stringify([prisma.runPlan.findMany.mock.calls, prisma.runPlan.deleteMany.mock.calls])
    ).not.toContain('LAUNCHED');
  });
});
