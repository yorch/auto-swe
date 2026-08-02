import { describe, expect, it, vi } from 'vitest';
import { launchTrackedWorkflow } from './workflowLaunch.js';

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

function alreadyStarted() {
  const err = new Error('already started');
  err.name = 'WorkflowExecutionAlreadyStartedError';
  return err;
}

/**
 * Minimal prisma double. `$transaction` resolves the queued create promises in
 * order, matching Prisma's array form.
 */
function mockPrisma(opts?: { activeWorkflowCreateError?: Error }) {
  const state = {
    activeWorkflowDeletes: [] as unknown[],
    runInputCreates: 0,
    runInputDeletes: [] as unknown[],
  };
  const prisma = {
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    activeWorkflow: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (opts?.activeWorkflowCreateError) {
          throw opts.activeWorkflowCreateError;
        }
        return { id: 'aw-1', ...args.data };
      }),
      delete: vi.fn(async (args: unknown) => {
        state.activeWorkflowDeletes.push(args);
        return {};
      }),
    },
    runInput: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.runInputCreates += 1;
        return { id: args.data.id ?? 'ri-1', ...args.data };
      }),
      delete: vi.fn(async (args: unknown) => {
        state.runInputDeletes.push(args);
        return {};
      }),
    },
  };
  return { prisma, state };
}

const ROWS = {
  activeWorkflow: { currentStatus: 'IMPLEMENTING', temporalWorkflowId: 'wf-1' },
  runInput: { id: 'ri-1' },
};

describe('launchTrackedWorkflow', () => {
  it('writes the ledger BEFORE starting the workflow', async () => {
    const { prisma } = mockPrisma();
    const order: string[] = [];
    prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => {
      order.push('ledger');
      return Promise.all(ops);
    });

    const res = await launchTrackedWorkflow(prisma as never, ROWS, async () => {
      order.push('start');
    });

    expect(res).toEqual({ activeWorkflowId: 'aw-1', ok: true });
    // The whole point of the change: rows exist before the workflow can run.
    expect(order).toEqual(['ledger', 'start']);
  });

  it('writes both rows in a single transaction', async () => {
    const { prisma } = mockPrisma();
    await launchTrackedWorkflow(prisma as never, ROWS, async () => {});
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.runInput.create).toHaveBeenCalledTimes(1);
    expect(prisma.activeWorkflow.create).toHaveBeenCalledTimes(1);
  });

  it('omits the RunInput write when re-running an existing request', async () => {
    const { prisma } = mockPrisma();
    const res = await launchTrackedWorkflow(
      prisma as never,
      { activeWorkflow: ROWS.activeWorkflow },
      async () => {}
    );
    expect(res.ok).toBe(true);
    expect(prisma.runInput.create).not.toHaveBeenCalled();
  });

  it('reports DUPLICATE and never starts when the ledger insert loses the unique race', async () => {
    const { prisma } = mockPrisma({ activeWorkflowCreateError: uniqueViolation() });
    const start = vi.fn(async () => {});

    const res = await launchTrackedWorkflow(prisma as never, ROWS, start);

    expect(res).toEqual({ ok: false, reason: 'DUPLICATE' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rolls the ledger back and reports DUPLICATE when the start says already-started', async () => {
    const { prisma, state } = mockPrisma();

    const res = await launchTrackedWorkflow(prisma as never, ROWS, async () => {
      throw alreadyStarted();
    });

    expect(res).toEqual({ ok: false, reason: 'DUPLICATE' });
    // Compensation: neither row is left behind to wedge the ticket.
    expect(state.activeWorkflowDeletes).toEqual([{ where: { id: 'aw-1' } }]);
    expect(state.runInputDeletes).toEqual([{ where: { id: 'ri-1' } }]);
  });

  it('rolls the ledger back and rethrows on any other start failure', async () => {
    const { prisma, state } = mockPrisma();

    await expect(
      launchTrackedWorkflow(prisma as never, ROWS, async () => {
        throw new Error('temporal unreachable');
      })
    ).rejects.toThrow('temporal unreachable');

    // A transient outage must not permanently block the ticket.
    expect(state.activeWorkflowDeletes).toHaveLength(1);
    expect(state.runInputDeletes).toHaveLength(1);
  });

  it('rethrows a non-unique ledger failure without starting', async () => {
    const { prisma } = mockPrisma({ activeWorkflowCreateError: new Error('db down') });
    const start = vi.fn(async () => {});

    await expect(launchTrackedWorkflow(prisma as never, ROWS, start)).rejects.toThrow('db down');
    expect(start).not.toHaveBeenCalled();
  });

  // PRD runs keep no ActiveWorkflow row — their spend is summed from AgentTrace
  // at finalize. They still need ledger-before-start ordering.
  describe('without an ActiveWorkflow row', () => {
    const PRD_ROWS = { runInput: { id: 'ri-prd' }, temporalWorkflowId: 'prd-x-1234abcd' };

    it('writes only the RunInput and reports a null activeWorkflowId', async () => {
      const { prisma } = mockPrisma();

      const res = await launchTrackedWorkflow(prisma as never, PRD_ROWS, async () => {});

      expect(res).toEqual({ activeWorkflowId: null, ok: true });
      expect(prisma.runInput.create).toHaveBeenCalledTimes(1);
      expect(prisma.activeWorkflow.create).not.toHaveBeenCalled();
    });

    it('still writes the ledger before starting', async () => {
      const { prisma } = mockPrisma();
      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => {
        order.push('ledger');
        return Promise.all(ops);
      });

      await launchTrackedWorkflow(prisma as never, PRD_ROWS, async () => {
        order.push('start');
      });

      expect(order).toEqual(['ledger', 'start']);
    });

    it('compensates the RunInput when the start fails', async () => {
      const { prisma, state } = mockPrisma();

      await expect(
        launchTrackedWorkflow(prisma as never, PRD_ROWS, async () => {
          throw new Error('temporal unreachable');
        })
      ).rejects.toThrow('temporal unreachable');

      expect(state.runInputDeletes).toEqual([{ where: { id: 'ri-prd' } }]);
      expect(prisma.activeWorkflow.delete).not.toHaveBeenCalled();
    });
  });

  it('cleans up the RunInput even when the ActiveWorkflow delete fails', async () => {
    // The two deletes are independent: a failure on the first must not strand
    // the second, or a failed rollback leaves a half-written ledger.
    const { prisma, state } = mockPrisma();
    prisma.activeWorkflow.delete.mockRejectedValue(new Error('cleanup failed'));

    await expect(
      launchTrackedWorkflow(prisma as never, ROWS, async () => {
        throw new Error('temporal unreachable');
      })
    ).rejects.toThrow('temporal unreachable');

    expect(state.runInputDeletes).toEqual([{ where: { id: 'ri-1' } }]);
  });

  it('logs and swallows a failed rollback, still surfacing the start error', async () => {
    const { prisma } = mockPrisma();
    prisma.activeWorkflow.delete.mockRejectedValue(new Error('cleanup failed'));
    const log = { error: vi.fn() };

    await expect(
      launchTrackedWorkflow(
        prisma as never,
        ROWS,
        async () => {
          throw new Error('temporal unreachable');
        },
        { log }
      )
      // The original start error wins — a stuck row is the recoverable outcome.
    ).rejects.toThrow('temporal unreachable');
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
