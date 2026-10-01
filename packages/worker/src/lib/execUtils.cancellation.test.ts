import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }));
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => {
      if (!state.signal) {
        throw new Error('not in an activity context');
      }
      return { cancellationSignal: state.signal };
    },
  },
  heartbeat: vi.fn(),
}));

import { raceActivityCancellation, throwIfActivityCancelled } from './execUtils.js';

describe('throwIfActivityCancelled', () => {
  it('is a no-op outside an activity context', () => {
    state.signal = undefined;
    expect(() => throwIfActivityCancelled()).not.toThrow();
  });

  it('is a no-op while running, and throws the reason once cancelled', () => {
    const ctl = new AbortController();
    state.signal = ctl.signal;
    expect(() => throwIfActivityCancelled()).not.toThrow();
    ctl.abort(new Error('cancelled'));
    expect(() => throwIfActivityCancelled()).toThrow('cancelled');
  });
});

describe('raceActivityCancellation', () => {
  it('passes the work through outside an activity context', async () => {
    state.signal = undefined;
    await expect(raceActivityCancellation(Promise.resolve(7))).resolves.toBe(7);
  });

  it('settles with the work when it finishes first', async () => {
    state.signal = new AbortController().signal;
    await expect(raceActivityCancellation(Promise.resolve('done'))).resolves.toBe('done');
  });

  it('rejects with the cancellation reason when cancelled first, without an unhandled rejection', async () => {
    const ctl = new AbortController();
    state.signal = ctl.signal;
    let rejectWork: (e: Error) => void = () => undefined;
    const work = new Promise<never>((_, reject) => {
      rejectWork = reject;
    });
    const raced = raceActivityCancellation(work);
    ctl.abort(new Error('cancelled'));
    await expect(raced).rejects.toThrow('cancelled');
    rejectWork(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('rejects immediately when already cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('already'));
    state.signal = ctl.signal;
    await expect(raceActivityCancellation(new Promise(() => undefined))).rejects.toThrow('already');
  });
});
