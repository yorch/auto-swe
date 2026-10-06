import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import { closedLedgerStatusFor } from './agentRunAdmission.js';
import { confirmInFlight, liveInFlightExecution, type SettledLookup } from './requestInFlight.js';

const OLD = new Date(Date.now() - 3_600_000);

function fakeDb(rows: { temporalWorkflowId: string; updatedAt: Date }[]) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findMany = vi.fn(async () => rows);
  const findUnique = vi.fn(
    async ({ where }: { where: { temporalWorkflowId: string } }) =>
      rows.find((r) => r.temporalWorkflowId === where.temporalWorkflowId) ?? null
  );
  return {
    db: { activeWorkflow: { findMany, findUnique, updateMany } } as unknown as PrismaClient,
    findMany,
    updateMany,
  };
}

const closedWith = (updateMany: ReturnType<typeof vi.fn>) =>
  updateMany.mock.calls.map(([arg]) => [
    (arg as { data: { currentStatus: string } }).data.currentStatus,
    (arg as { where: { temporalWorkflowId: { in: string[] } } }).where.temporalWorkflowId.in,
  ]);

describe('closedLedgerStatusFor', () => {
  it('maps a finished execution to its ledger status, and a running one to null', () => {
    expect(closedLedgerStatusFor('COMPLETED')).toBe('COMPLETED');
    expect(closedLedgerStatusFor('FAILED')).toBe('FAILED');
    expect(closedLedgerStatusFor('TIMED_OUT')).toBe('TIMED_OUT');
    expect(closedLedgerStatusFor('CANCELLED')).toBe('CANCELLED');
    expect(closedLedgerStatusFor('TERMINATED')).toBe('CANCELLED');
    expect(closedLedgerStatusFor('RUNNING')).toBeNull();
    expect(closedLedgerStatusFor('CONTINUED_AS_NEW')).toBeNull();
    expect(closedLedgerStatusFor(undefined)).toBeNull();
  });
});

describe('liveInFlightExecution', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops at the first live row and closes the finished one before it, each with its status', async () => {
    const { db, updateMany } = fakeDb([
      { temporalWorkflowId: 'a', updatedAt: OLD },
      { temporalWorkflowId: 'b', updatedAt: OLD },
      { temporalWorkflowId: 'c', updatedAt: OLD },
    ]);
    const settled = vi.fn<SettledLookup>(async (id) => (id === 'b' ? null : 'CANCELLED'));
    const res = await liveInFlightExecution(db, 'wr', { settled });
    expect(res).toEqual({ temporalWorkflowId: 'b', unconfirmed: false });
    expect(settled).not.toHaveBeenCalledWith('c');
    expect(closedWith(updateMany)).toEqual([['CANCELLED', ['a']]]);
  });

  it('closes every finished row when none is live', async () => {
    const { db, updateMany } = fakeDb([
      { temporalWorkflowId: 'a', updatedAt: OLD },
      { temporalWorkflowId: 'b', updatedAt: OLD },
    ]);
    const settled: SettledLookup = async (id) => (id === 'a' ? 'FAILED' : 'COMPLETED');
    expect(await liveInFlightExecution(db, 'wr', { settled })).toBeNull();
    expect(closedWith(updateMany)).toEqual([
      ['FAILED', ['a']],
      ['COMPLETED', ['b']],
    ]);
  });

  it('blocks as unconfirmed when a lookup never settles', async () => {
    const { db, updateMany } = fakeDb([{ temporalWorkflowId: 'a', updatedAt: OLD }]);
    const pending = liveInFlightExecution(db, 'wr', {
      settled: () => new Promise<never>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await pending).toEqual({ temporalWorkflowId: 'a', unconfirmed: true });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('blocks as unconfirmed when Temporal cannot be asked', async () => {
    const { db } = fakeDb([{ temporalWorkflowId: 'a', updatedAt: OLD }]);
    const settled: SettledLookup = async () => {
      throw new Error('down');
    };
    expect(await liveInFlightExecution(db, 'wr', { settled })).toEqual({
      temporalWorkflowId: 'a',
      unconfirmed: true,
    });
  });

  it('trusts a row written within the grace window without asking', async () => {
    const { db } = fakeDb([{ temporalWorkflowId: 'a', updatedAt: new Date() }]);
    const settled = vi.fn<SettledLookup>(async () => 'FAILED');
    expect(await liveInFlightExecution(db, 'wr', { settled })).toMatchObject({
      temporalWorkflowId: 'a',
    });
    expect(settled).not.toHaveBeenCalled();
  });
});

describe('confirmInFlight', () => {
  it('closes the named row when its execution is over, and keeps a missing row blocking', async () => {
    const { db, updateMany } = fakeDb([{ temporalWorkflowId: 'a', updatedAt: OLD }]);
    expect(await confirmInFlight(db, 'a', { settled: async () => 'TIMED_OUT' })).toBeNull();
    expect(closedWith(updateMany)).toEqual([['TIMED_OUT', ['a']]]);
    expect(await confirmInFlight(db, 'nope', { settled: async () => 'FAILED' })).toEqual({
      temporalWorkflowId: 'nope',
      unconfirmed: false,
    });
  });
});
