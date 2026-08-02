import { beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseChannelBudgetHolds } from './channelBudget.js';

/**
 * The refund protocol used to live twice — once in the worker's TTL sweep, once
 * in the gateway's admin reset — and the two had already diverged on which
 * month to credit. These cover the three rules that divergence can break.
 */
function mockClient() {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
    channelBudgetHold: {
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    channelMonthlyUsage: { update: vi.fn().mockResolvedValue({}) },
  };
  return client;
}

type Client = ReturnType<typeof mockClient>;
type UpdateArgs = {
  data: { costUsdAccrued: { decrement: number }; runsCompleted?: unknown };
  where: { channelId_yearMonth: { channelId: string; yearMonth: string } };
};

const updateArgs = (client: Client, i = 0) => client.channelMonthlyUsage.update.mock.calls[i]?.[0];

let client: Client;
beforeEach(() => {
  client = mockClient();
});

describe('releaseChannelBudgetHolds', () => {
  it('credits each hold to the month it was taken in, not the current one', async () => {
    // A hold taken at 23:59 on the last of the month expires in the next one.
    // Crediting "now" leaks it on the old row and drives the new one negative —
    // the exact way the two hand-written copies of this had diverged.
    client.channelBudgetHold.findMany.mockResolvedValue([
      { amountUsd: '0.0775', id: 'h-may', yearMonth: '2026-05' },
      { amountUsd: '0.02', id: 'h-jun', yearMonth: '2026-06' },
    ]);

    const result = await releaseChannelBudgetHolds(client as never, 'chan-1', {
      expiredOnly: true,
    });

    expect(result).toEqual({ reclaimedUsd: 0.0975, released: 2 });
    expect((updateArgs(client, 0) as UpdateArgs).where.channelId_yearMonth.yearMonth).toBe(
      '2026-05'
    );
    expect((updateArgs(client, 1) as UpdateArgs).where.channelId_yearMonth.yearMonth).toBe(
      '2026-06'
    );
  });

  it('refunds only the holds whose delete actually won', async () => {
    // The delete IS the claim. A settling turn that beat us to a row has already
    // accounted for that reservation; refunding it again erases real spend.
    client.channelBudgetHold.findMany.mockResolvedValue([
      { amountUsd: '0.0775', id: 'h-1', yearMonth: '2026-06' },
      { amountUsd: '0.0775', id: 'h-2', yearMonth: '2026-06' },
    ]);
    client.channelBudgetHold.delete.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'h-2') {
        throw Object.assign(new Error('Record to delete does not exist'), { code: 'P2025' });
      }
      return {};
    });

    const result = await releaseChannelBudgetHolds(client as never, 'chan-1', {
      expiredOnly: true,
    });

    expect(result).toEqual({ reclaimedUsd: 0.0775, released: 1 });
    expect(client.channelMonthlyUsage.update).toHaveBeenCalledTimes(1);
  });

  it('never touches runsCompleted — a refund is not a turn that happened', async () => {
    client.channelBudgetHold.findMany.mockResolvedValue([
      { amountUsd: '0.0775', id: 'h-1', yearMonth: '2026-06' },
    ]);

    await releaseChannelBudgetHolds(client as never, 'chan-1', { expiredOnly: true });

    expect((updateArgs(client) as UpdateArgs).data).not.toHaveProperty('runsCompleted');
  });

  it('filters on expiry for the sweep and on the month for the admin reset', async () => {
    await releaseChannelBudgetHolds(client as never, 'chan-1', { expiredOnly: true });
    const sweepWhere = client.channelBudgetHold.findMany.mock.calls[0]?.[0] as {
      where: { expiresAt?: unknown; yearMonth?: string };
    };
    expect(sweepWhere.where.expiresAt).toBeDefined();
    expect(sweepWhere.where.yearMonth).toBeUndefined();

    await releaseChannelBudgetHolds(client as never, 'chan-1', {
      expiredOnly: false,
      yearMonth: '2026-06',
    });
    const resetWhere = client.channelBudgetHold.findMany.mock.calls[1]?.[0] as {
      where: { expiresAt?: unknown; yearMonth?: string };
    };
    // The reset takes live holds too — that is the point of it.
    expect(resetWhere.where.expiresAt).toBeUndefined();
    expect(resetWhere.where.yearMonth).toBe('2026-06');
  });

  it('reports nothing reclaimed when the listing itself fails', async () => {
    // Best-effort: a sweep that cannot read must not stop the turn that
    // triggered it.
    client.channelBudgetHold.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(
      releaseChannelBudgetHolds(client as never, 'chan-1', { expiredOnly: true })
    ).resolves.toEqual({ reclaimedUsd: 0, released: 0 });
  });
});
