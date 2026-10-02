import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetReconcileCacheForTests,
  type AgentRunSlot,
  closeAgentRunLedgerRows,
  decideAdmission,
  isWorkflowStatusFinished,
  loadAgentRunSlots,
  RECONCILE_GRACE_MS,
  RECONCILE_MAX_CHECKS,
  reconcileAgentRunSlots,
  wouldAdmitNewRun,
} from './agentRunAdmission.js';

const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const slot = (id: string, team: string | null, t: number): AgentRunSlot => ({
  launchedAt: at(t),
  teamId: team,
  workflowId: id,
});

describe('decideAdmission (worker authority)', () => {
  const limits = { global: 3, perTeam: 2 };

  it('admits the oldest runs and refuses a newer one past the global cap', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't2', 2), slot('c', 't3', 3), slot('d', 't4', 4)];
    expect(decideAdmission(runs, { teamId: 't3', workflowId: 'c' }, limits).admitted).toBe(true);
    expect(decideAdmission(runs, { teamId: 't4', workflowId: 'd' }, limits)).toEqual({
      admitted: false,
      reason: 'global_limit',
    });
  });

  it('fails closed when the run is in flight but not under the team it claims', () => {
    const runs = [slot('a', 't1', 1)];
    expect(decideAdmission(runs, { teamId: 't2', workflowId: 'a' }, limits)).toEqual({
      admitted: false,
      reason: 'unknown_run',
    });
    expect(decideAdmission(runs, { teamId: null, workflowId: 'a' }, limits)).toEqual({
      admitted: false,
      reason: 'unknown_run',
    });
  });

  it('applies the per-team cap on the team’s own runs only', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't1', 2), slot('c', 't1', 3), slot('d', 't2', 4)];
    expect(decideAdmission(runs, { teamId: 't1', workflowId: 'c' }, limits)).toEqual({
      admitted: false,
      reason: 'team_limit',
    });
    // Another team is not held back by t1's backlog.
    expect(
      decideAdmission(runs, { teamId: 't2', workflowId: 'd' }, { global: 10, perTeam: 2 }).admitted
    ).toBe(true);
  });

  it('two racing launches at a limit of one: exactly one proceeds', () => {
    // Same launch instant; the workflow id breaks the tie deterministically.
    const runs = [slot('run-b', 't', 5), slot('run-a', 't', 5)];
    const one = { global: 1, perTeam: 1 };
    const a = decideAdmission(runs, { teamId: 't', workflowId: 'run-a' }, one).admitted;
    const b = decideAdmission(runs, { teamId: 't', workflowId: 'run-b' }, one).admitted;
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('0 disables agent runs outright, at either level', () => {
    const runs = [slot('a', 't', 1)];
    const self = { teamId: 't', workflowId: 'a' };
    expect(decideAdmission(runs, self, { global: 0, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'disabled',
    });
    expect(decideAdmission(runs, self, { global: 4, perTeam: 0 })).toEqual({
      admitted: false,
      reason: 'disabled',
    });
  });

  it('fails closed when the run cannot find itself', () => {
    expect(
      decideAdmission([slot('a', 't', 1)], { teamId: 't', workflowId: 'zzz' }, limits)
    ).toEqual({ admitted: false, reason: 'unknown_run' });
  });
});

describe('wouldAdmitNewRun (gateway friendliness)', () => {
  it('counts the global and team load', () => {
    const runs = [slot('a', 't1', 1), slot('b', 't1', 2)];
    expect(wouldAdmitNewRun(runs, 't1', { global: 5, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'team_limit',
    });
    expect(wouldAdmitNewRun(runs, 't2', { global: 2, perTeam: 2 })).toEqual({
      admitted: false,
      reason: 'global_limit',
    });
    expect(wouldAdmitNewRun(runs, 't2', { global: 5, perTeam: 2 }).admitted).toBe(true);
    expect(wouldAdmitNewRun([], 't1', { global: 0, perTeam: 2 }).admitted).toBe(false);
  });
});

describe('loadAgentRunSlots', () => {
  it('filters terminal runs in the database query, not in memory', async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      {
        currentStatus: 'IMPLEMENTING',
        repository: { teamId: 't1' },
        temporalWorkflowId: 'w1',
        workRequest: { createdAt: at(1) },
      },
    ]);
    const slots = await loadAgentRunSlots({ activeWorkflow: { findMany } }, 'tpl-1');
    expect(slots).toEqual([{ launchedAt: at(1), teamId: 't1', workflowId: 'w1' }]);
    const arg = findMany.mock.calls[0]?.[0] as unknown as {
      where: { currentStatus: { notIn: string[] }; workRequest: { templateId: string } };
    };
    expect(arg.where.currentStatus.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'])
    );
    expect(arg.where.workRequest.templateId).toBe('tpl-1');
  });
});

describe('isWorkflowStatusFinished', () => {
  it('is true only for a definitively finished status', () => {
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']) {
      expect(isWorkflowStatusFinished(s)).toBe(true);
    }
  });

  it('keeps the slot for anything else: running, continued-as-new, unspecified, unknown, absent', () => {
    for (const s of ['RUNNING', 'CONTINUED_AS_NEW', 'UNSPECIFIED', 'PAUSED', 'SOMETHING_NEW', '']) {
      expect(isWorkflowStatusFinished(s)).toBe(false);
    }
    expect(isWorkflowStatusFinished(undefined)).toBe(false);
  });
});

describe('reconcileAgentRunSlots', () => {
  beforeEach(() => __resetReconcileCacheForTests());
  const NOW = new Date(at(0).getTime() + 60 * 60_000);
  /** Launched `ageMs` ago. */
  const old = (id: string, team: string, ageMs = 30 * 60_000): AgentRunSlot => ({
    launchedAt: new Date(NOW.getTime() - ageMs),
    teamId: team,
    workflowId: id,
  });
  const make = (running: Record<string, boolean | Error>) => {
    const isRunning = vi.fn(async (id: string) => {
      const v = running[id];
      if (v instanceof Error) {
        throw v;
      }
      return v ?? true;
    });
    const close = vi.fn(async (_ids: string[]) => {});
    return { close, isRunning };
  };

  it('frees a crashed row (workflow terminal or gone) and closes it', async () => {
    const { isRunning, close } = make({ crashed: false });
    const slots = [old('crashed', 't1'), old('live', 't1')];
    const out = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(out.map((s) => s.workflowId)).toEqual(['live']);
    expect(close).toHaveBeenCalledWith(['crashed']);
  });

  it('keeps a row whose workflow is still running, and closes nothing', async () => {
    const { isRunning, close } = make({});
    const slots = [old('a', 't1'), old('b', 't1')];
    const out = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(out).toHaveLength(2);
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps the slot, and reports it, when Temporal cannot be reached', async () => {
    const { isRunning, close } = make({ a: new Error('temporal down') });
    const onUnreachable = vi.fn();
    const out = await reconcileAgentRunSlots([old('a', 't1')], {
      close,
      isRunning,
      now: NOW,
      onUnreachable,
    });
    expect(out.map((s) => s.workflowId)).toEqual(['a']);
    expect(close).not.toHaveBeenCalled();
    expect(onUnreachable).toHaveBeenCalledWith('a', expect.any(Error));
  });

  it('bounds the Temporal lookups of one admission call, oldest launch first', async () => {
    const { isRunning, close } = make({});
    const slots = Array.from({ length: 20 }, (_, i) =>
      old(`w${String(i).padStart(2, '0')}`, 't1', (100 - i) * 60_000)
    );
    await reconcileAgentRunSlots(slots, { close, isRunning, maxChecks: 3, now: NOW });
    expect(isRunning).toHaveBeenCalledTimes(3);
    // w00 is the oldest launch.
    expect(isRunning.mock.calls.map((c) => c[0])).toEqual(['w00', 'w01', 'w02']);
  });

  it('reaches stale rows hidden behind long-running live ones, over successive admissions', async () => {
    // Eight live runs are the oldest rows; two stranded rows sit behind them. A
    // fixed "oldest eight" window would re-describe the live ones forever.
    const live = Array.from({ length: 8 }, (_, i) => old(`live${i}`, 't1', (200 - i) * 60_000));
    const stale = [old('stale1', 't1', 20 * 60_000), old('stale2', 't1', 10 * 60_000)];
    const slots = [...live, ...stale];
    const { isRunning, close } = make({ stale1: false, stale2: false });

    const first = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(first).toHaveLength(10); // the window was spent on the live rows
    const second = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(second.map((s) => s.workflowId)).toEqual(live.map((s) => s.workflowId));
    expect(close).toHaveBeenCalledWith(['stale1', 'stale2']);
    // Live rows were not re-described in the second call.
    expect(
      isRunning.mock.calls
        .slice(8)
        .map((c) => c[0])
        .sort()
    ).toEqual(['stale1', 'stale2']);
  });

  it('asks about a confirmed-running row again once the recheck window has passed', async () => {
    const { isRunning, close } = make({});
    const slots = [old('a', 't1')];
    await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(isRunning).toHaveBeenCalledTimes(1);
    await reconcileAgentRunSlots(slots, {
      close,
      isRunning,
      now: new Date(NOW.getTime() + 61_000),
    });
    expect(isRunning).toHaveBeenCalledTimes(2);
  });

  it('abandons a lookup that hangs, and keeps the slot', async () => {
    const isRunning = vi.fn(() => new Promise<boolean>(() => {}));
    const close = vi.fn(async (_ids: string[]) => {});
    const onUnreachable = vi.fn();
    const out = await reconcileAgentRunSlots([old('a', 't1')], {
      close,
      isRunning,
      lookupTimeoutMs: 20,
      now: NOW,
      onUnreachable,
    });
    expect(out.map((s) => s.workflowId)).toEqual(['a']);
    expect(onUnreachable).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ message: expect.stringContaining('timed out') })
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('uses the default bound when none is given', async () => {
    const { isRunning, close } = make({});
    const slots = Array.from({ length: 30 }, (_, i) => old(`w${i}`, 't1'));
    await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW });
    expect(isRunning).toHaveBeenCalledTimes(RECONCILE_MAX_CHECKS);
  });

  it('never looks up the calling run, nor one still inside the launch grace window', async () => {
    const { isRunning, close } = make({ fresh: false, self: false, stale: false });
    const slots = [
      old('self', 't1'),
      old('fresh', 't1', RECONCILE_GRACE_MS - 1_000),
      old('stale', 't1'),
    ];
    const out = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW, self: 'self' });
    expect(isRunning.mock.calls.map((c) => c[0])).toEqual(['stale']);
    expect(out.map((s) => s.workflowId).sort()).toEqual(['fresh', 'self']);
  });

  it('still frees the slot for this admission when closing the row fails', async () => {
    const { isRunning, close } = make({ a: false });
    close.mockRejectedValue(new Error('db down'));
    const out = await reconcileAgentRunSlots([old('a', 't1')], { close, isRunning, now: NOW });
    expect(out).toEqual([]);
  });

  it('makes no Temporal call when nothing is old enough to doubt', async () => {
    const { isRunning, close } = make({});
    const out = await reconcileAgentRunSlots([old('a', 't1', 1000)], {
      close,
      isRunning,
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(isRunning).not.toHaveBeenCalled();
  });

  it('keeps rank-based admission race-free: two reconciling racers cannot both be admitted', async () => {
    // Limit 1. `dead` holds the only slot; `a` and `b` race. Each reconciles
    // against the same truth and decides by rank, so exactly one proceeds.
    const slots = [
      old('dead', 't', 50 * 60_000),
      old('a', 't', 20 * 60_000),
      old('b', 't', 20 * 60_000 - 1),
    ];
    const limits = { global: 1, perTeam: 1 };
    const decide = async (self: string) => {
      const { isRunning, close } = make({ dead: false });
      const live = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW, self });
      return decideAdmission(live, { teamId: 't', workflowId: self }, limits).admitted;
    };
    const [a, b] = await Promise.all([decide('a'), decide('b')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(a).toBe(true);
  });

  it('admits nothing while the dead row cannot be confirmed dead', async () => {
    const slots = [old('dead', 't', 50 * 60_000), old('a', 't', 20 * 60_000)];
    const { isRunning, close } = make({ dead: new Error('down') });
    const live = await reconcileAgentRunSlots(slots, { close, isRunning, now: NOW, self: 'a' });
    expect(
      decideAdmission(live, { teamId: 't', workflowId: 'a' }, { global: 1, perTeam: 1 })
    ).toEqual({ admitted: false, reason: 'global_limit' });
  });
});

describe('closeAgentRunLedgerRows', () => {
  it('marks only still-non-terminal rows terminal', async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    await closeAgentRunLedgerRows({ activeWorkflow: { updateMany } })(['w1']);
    const arg = updateMany.mock.calls[0]?.[0] as unknown as {
      data: { currentStatus: string };
      where: { currentStatus: { notIn: string[] }; temporalWorkflowId: { in: string[] } };
    };
    expect(arg.data.currentStatus).toBe('FAILED');
    expect(arg.where.temporalWorkflowId.in).toEqual(['w1']);
    expect(arg.where.currentStatus.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'])
    );
  });
});
