import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLivenessFile } from './livenessFile.js';

describe('startLivenessFile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches immediately and then on every interval while running', () => {
    const touch = vi.fn();
    const stop = startLivenessFile({
      intervalMs: 1000,
      isRunning: () => true,
      path: '/tmp/x',
      touch,
    });
    expect(touch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(touch).toHaveBeenCalledTimes(4);
    expect(touch).toHaveBeenCalledWith('/tmp/x');
    stop();
  });

  it('stops touching once the worker is no longer running', () => {
    const touch = vi.fn();
    let running = true;
    const stop = startLivenessFile({ intervalMs: 1000, isRunning: () => running, touch });
    vi.advanceTimersByTime(1000);
    expect(touch).toHaveBeenCalledTimes(2);
    running = false;
    vi.advanceTimersByTime(5000);
    expect(touch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops touching after the returned stop function is called', () => {
    const touch = vi.fn();
    const stop = startLivenessFile({ intervalMs: 1000, isRunning: () => true, touch });
    stop();
    vi.advanceTimersByTime(5000);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('survives a failing write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const touch = vi.fn(() => {
      throw new Error('read-only filesystem');
    });
    const stop = startLivenessFile({ intervalMs: 1000, isRunning: () => true, touch });
    vi.advanceTimersByTime(2000);
    expect(touch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(3);
    stop();
    warn.mockRestore();
  });
});
