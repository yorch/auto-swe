import { describe, expect, it } from 'vitest';
import { SignalSlots } from './signalSlots.js';

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
