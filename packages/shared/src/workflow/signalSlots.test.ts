import { describe, expect, it } from 'vitest';
import {
  SIGNAL_REWAIT_PATCH,
  SignalSlots,
  type SignalWaitRuntime,
  waitForSignal,
} from './signalSlots.js';
import { waitDurationMs } from './waitDuration.js';

describe('SignalSlots', () => {
  it('registers names idempotently', () => {
    const s = new SignalSlots();
    s.register('a');
    s.register('a');
    expect(s.isRegistered('a')).toBe(true);
    expect(s.isRegistered('b')).toBe(false);
  });

  it('reports no pending payload before delivery', () => {
    const s = new SignalSlots();
    s.register('a');
    expect(s.hasPending('a')).toBe(false);
    expect(s.take('a')).toBeUndefined();
  });

  it('delivers and consumes a payload exactly once', () => {
    const s = new SignalSlots();
    s.deliver('a', { passed: true });
    expect(s.hasPending('a')).toBe(true);
    expect(s.take('a')).toEqual({ passed: true });
    expect(s.hasPending('a')).toBe(false);
    expect(s.take('a')).toBeUndefined();
  });

  it('treats undefined payload as null so "delivered" stays distinguishable from "not delivered"', () => {
    const s = new SignalSlots();
    s.deliver('a', undefined);
    expect(s.hasPending('a')).toBe(true);
    expect(s.take('a')).toBeNull();
  });

  it('preserves falsy payloads (null, 0, false, "")', () => {
    const s = new SignalSlots();
    for (const value of [null, 0, false, '']) {
      s.deliver('x', value);
      expect(s.hasPending('x')).toBe(true);
      expect(s.take('x')).toBe(value);
    }
  });

  it('clear() drops a pending payload without consuming', () => {
    const s = new SignalSlots();
    s.deliver('a', 1);
    s.clear('a');
    expect(s.hasPending('a')).toBe(false);
    expect(s.take('a')).toBeUndefined();
  });

  it('clear() is safe when nothing is pending', () => {
    const s = new SignalSlots();
    expect(() => s.clear('never-delivered')).not.toThrow();
  });

  it('keeps slots independent across signal names', () => {
    const s = new SignalSlots();
    s.deliver('ci', { passed: true });
    s.deliver('merge', true);
    expect(s.take('ci')).toEqual({ passed: true });
    expect(s.hasPending('merge')).toBe(true);
    expect(s.take('merge')).toBe(true);
  });

  it('replays the dispatcher contract: clear-then-wait-then-take never returns a stale payload', () => {
    // Simulates the waitSignal flow in runnable.ts: a previous CI signal
    // delivered logsUrl=L1. After the review loop, the workflow re-enters the
    // CI wait. Without the clear, the new wait would resolve immediately on
    // the stale L1 payload. With the clear, it must not.
    const s = new SignalSlots();
    s.register('ciPipelineSignal');
    s.deliver('ciPipelineSignal', { logsUrl: 'L1', passed: false });

    // Dispatcher's reset-before-wait:
    s.clear('ciPipelineSignal');
    expect(s.hasPending('ciPipelineSignal')).toBe(false);

    // New payload arrives during the wait:
    s.deliver('ciPipelineSignal', { logsUrl: 'L2', passed: true });

    // Dispatcher's take-on-resolve:
    expect(s.take('ciPipelineSignal')).toEqual({ logsUrl: 'L2', passed: true });
  });

  it('later deliver() overwrites an unconsumed earlier payload (at-least-once tolerance)', () => {
    const s = new SignalSlots();
    s.deliver('a', 1);
    s.deliver('a', 2);
    expect(s.take('a')).toBe(2);
  });
});

/**
 * A stand-in for the Temporal SDK's condition handling. What matters is the
 * order the SDK uses: an activation applies its jobs (signals, fired timers)
 * and then resolves EVERY blocked condition whose predicate holds, before any
 * woken workflow code runs. That is what lets one delivery wake two waits on
 * the same name.
 */
function fakeTemporal(opts: { patched?: boolean } = {}) {
  let clock = 1_000_000;
  let blocked: Array<{ deadline: number; fn: () => boolean; resolve: (v: boolean) => void }> = [];
  const timeouts: Array<string | number> = [];
  const patchCalls: string[] = [];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const runtime: SignalWaitRuntime = {
    condition(fn, timeout) {
      timeouts.push(timeout);
      const ms = typeof timeout === 'number' ? timeout : waitDurationMs(timeout);
      return new Promise((resolve) => {
        blocked.push({ deadline: clock + ms, fn, resolve });
      });
    },
    now: () => clock,
    patched(id) {
      patchCalls.push(id);
      return opts.patched ?? true;
    },
  };
  return {
    /** Apply `job`, then wake every condition that now holds, then let woken code run. */
    async activate(job: () => void) {
      job();
      const ready = blocked.filter((c) => c.fn());
      blocked = blocked.filter((c) => !ready.includes(c));
      for (const c of ready) {
        c.resolve(true);
      }
      await flush();
    },
    /** Move the workflow clock forward, firing every timer that falls due. */
    async advance(ms: number) {
      clock += ms;
      const due = blocked.filter((c) => c.deadline <= clock);
      blocked = blocked.filter((c) => !due.includes(c));
      for (const c of due) {
        c.resolve(false);
      }
      await flush();
    },
    patchCalls,
    runtime,
    timeouts,
    get waiting() {
      return blocked.length;
    },
  };
}

describe('waitForSignal', () => {
  it('consumes a payload that is already pending', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    s.deliver('go', { ok: true });
    const wait = waitForSignal(s, 'go', '1h', t.runtime);
    await t.activate(() => {});
    await expect(wait).resolves.toEqual({ ok: true });
    expect(t.patchCalls).toEqual([]);
  });

  it('returns undefined when the timeout elapses', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    const wait = waitForSignal(s, 'go', '30m', t.runtime);
    await t.advance(30 * 60_000);
    await expect(wait).resolves.toBeUndefined();
    expect(t.patchCalls).toEqual([]);
  });

  it('wakes only one of two concurrent waits per delivery; the other keeps waiting', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    const results: unknown[] = [];
    const a = waitForSignal(s, 'go', '1h', t.runtime).then((v) => results.push(['a', v]));
    const b = waitForSignal(s, 'go', '1h', t.runtime).then((v) => results.push(['b', v]));
    await t.activate(() => {});
    await t.advance(10 * 60_000);

    await t.activate(() => s.deliver('go', 1));
    // One wait got the payload; the other went back to waiting rather than
    // reporting a timeout that has not happened.
    expect(results).toEqual([['a', 1]]);
    expect(t.waiting).toBe(1);
    expect(t.patchCalls).toEqual([SIGNAL_REWAIT_PATCH]);
    // Its new timer covers only what is left of its own hour.
    expect(t.timeouts).toEqual(['1h', '1h', 50 * 60_000]);

    await t.activate(() => s.deliver('go', 2));
    await Promise.all([a, b]);
    expect(results).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(s.hasPending('go')).toBe(false);
  });

  it('times the re-wait out at the original deadline', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    const results: unknown[] = [];
    const a = waitForSignal(s, 'go', '1h', t.runtime).then((v) => results.push(['a', v]));
    const b = waitForSignal(s, 'go', '1h', t.runtime).then((v) => results.push(['b', v]));
    await t.advance(20 * 60_000);
    await t.activate(() => s.deliver('go', 'only'));
    expect(results).toEqual([['a', 'only']]);

    await t.advance(39 * 60_000);
    expect(results).toHaveLength(1);
    await t.advance(60_000);
    await Promise.all([a, b]);
    expect(results).toEqual([
      ['a', 'only'],
      ['b', undefined],
    ]);
  });

  it('keeps the recorded behaviour when the re-wait patch is absent (replay of an older history)', async () => {
    const t = fakeTemporal({ patched: false });
    const s = new SignalSlots();
    const a = waitForSignal(s, 'go', '1h', t.runtime);
    const b = waitForSignal(s, 'go', '1h', t.runtime);
    await t.activate(() => s.deliver('go', 1));
    await expect(a).resolves.toBe(1);
    // Before the patch the empty-handed waiter ended at once, with no new timer.
    await expect(b).resolves.toBeUndefined();
    expect(t.timeouts).toEqual(['1h', '1h']);
    expect(t.waiting).toBe(0);
  });

  it('leaves the payload in the slot for a wait that is told to leave it', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    const wait = waitForSignal(s, 'go', '1h', t.runtime, () => true);
    await t.activate(() => s.deliver('go', 'later'));
    await expect(wait).resolves.toBeUndefined();
    expect(s.take('go')).toBe('later');
  });

  it('asks leaveForLater only once a payload has woken the wait', async () => {
    const t = fakeTemporal();
    const s = new SignalSlots();
    let asked = 0;
    const wait = waitForSignal(s, 'go', '30m', t.runtime, () => {
      asked += 1;
      return false;
    });
    await t.advance(30 * 60_000);
    await expect(wait).resolves.toBeUndefined();
    expect(asked).toBe(0);
  });
});
