import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it, vi } from 'vitest';
import {
  type AskDeps,
  askRecordingId,
  MAX_REASKS_PER_ROUND,
  NEEDS_INPUT_CANCEL_PATCH,
  NEEDS_INPUT_FINAL_PATCH,
  NEEDS_INPUT_REASK_PATCH,
  type PauseArgs,
  reaskRecordingId,
  runWithNeedsInput,
} from './needsInputLoop.js';

const question = {
  header: 'Lib',
  multiSelect: false,
  options: [
    { description: '', label: 'A' },
    { description: '', label: 'B' },
  ],
  question: 'Which?',
};
const pauseOf = (digest = 'work') => ({
  needsInput: {
    questions: [question],
    resume: { asked: [{ header: 'Lib', question: 'Which?' }], digest, snapshot: null, version: 1 },
  },
});
const submit = (q1: string) => ({ action: 'submit', value: { q1 } });
const limits = { maxRounds: 2, timeoutSeconds: 120 };

function harness(replies: unknown[], unpatched: string[] = []) {
  const createHumanStep = vi.fn<AskDeps['createHumanStep']>(async () => {});
  const resolveHumanStep = vi.fn<AskDeps['resolveHumanStep']>(async () => {});
  const waitSignal = vi.fn<AskDeps['waitSignal']>(async () => replies.shift());
  const nonCancellableRuns = vi.fn();
  const deps: AskDeps = {
    createHumanStep,
    isCancellation: (err) => err instanceof Error && err.message === 'cancelled',
    patched: (id) => !unpatched.includes(id),
    resolveHumanStep,
    runNonCancellable: async (fn) => {
      nonCancellableRuns();
      await fn();
    },
    waitSignal,
  };
  return {
    createHumanStep,
    deps,
    nonCancellableRuns,
    resolveHumanStep,
    waitSignal,
  };
}

describe('runWithNeedsInput', () => {
  it('returns an ordinary result without asking anyone', async () => {
    const h = harness([]);
    const invoke = vi.fn(async (_p: PauseArgs) => ({ text: 'done' }));
    await expect(
      runWithNeedsInput({ deps: h.deps, invoke, key: 'impl', label: 'implementer', limits })
    ).resolves.toEqual({ text: 'done' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ allowPause: true });
    expect(h.createHumanStep).not.toHaveBeenCalled();
  });

  it('asks, waits, and resumes the same activity with the mapped answers', async () => {
    const h = harness([submit('B')]);
    const invoke = vi.fn(async (p: PauseArgs) => (p.resumeInput ? { text: 'final' } : pauseOf()));
    await expect(
      runWithNeedsInput({ deps: h.deps, invoke, key: 'impl#2', label: 'implementer', limits })
    ).resolves.toEqual({ text: 'final' });
    expect(h.createHumanStep).toHaveBeenCalledTimes(1);
    expect(h.createHumanStep.mock.calls[0]?.[0]).toMatchObject({
      context: 'work',
      kind: 'INPUT',
      nodeId: 'impl#2:ask:1',
      signalName: 'hitl_impl#2:ask:1',
      timeout: '120s',
      title: 'implementer needs input',
    });
    expect(h.waitSignal).toHaveBeenCalledWith('hitl_impl#2:ask:1', '120s');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toEqual({
      allowPause: true,
      resumeInput: {
        answers: [{ answer: 'B', question: 'Which?' }],
        resume: pauseOf().needsInput.resume,
        round: 1,
      },
    });
  });

  it('numbers the rounds and gives each its own human step', async () => {
    const h = harness([submit('A'), submit('B')]);
    let calls = 0;
    const invoke = vi.fn(async (_p: PauseArgs) =>
      ++calls < 3 ? pauseOf(`d${calls}`) : { text: 'ok' }
    );
    await runWithNeedsInput({ deps: h.deps, invoke, key: 'n', label: 'x', limits });
    expect(h.createHumanStep.mock.calls.map((c) => c[0].nodeId)).toEqual([
      askRecordingId('n', 1),
      askRecordingId('n', 2),
    ]);
    expect(invoke.mock.calls[2]?.[0]?.resumeInput?.round).toBe(2);
  });

  it('fails NEEDS_INPUT_LIMIT when the step keeps asking, without opening another step (pre-final-round executions)', async () => {
    const h = harness([submit('A'), submit('A'), submit('A')], [NEEDS_INPUT_FINAL_PATCH]);
    const invoke = vi.fn(async () => pauseOf());
    const err = await runWithNeedsInput({
      deps: h.deps,
      invoke,
      key: 'k',
      label: 'x',
      limits,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_LIMIT' });
    expect(h.createHumanStep).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('fails NEEDS_INPUT_TIMEOUT and marks the step timed out', async () => {
    const h = harness([undefined]);
    const err = await runWithNeedsInput({
      deps: h.deps,
      invoke: async () => pauseOf(),
      key: 'k',
      label: 'x',
      limits,
    }).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_TIMEOUT' });
    expect(h.resolveHumanStep).toHaveBeenCalledWith({ nodeId: 'k:ask:1', status: 'TIMED_OUT' });
  });

  it('fails NEEDS_INPUT_INVALID_ANSWER on an answer that fits no question (pre-re-ask executions)', async () => {
    const h = harness([submit('nope')], [NEEDS_INPUT_REASK_PATCH]);
    const invoke = vi.fn(async () => pauseOf());
    const err = await runWithNeedsInput({
      deps: h.deps,
      invoke,
      key: 'k',
      label: 'x',
      limits,
    }).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_INVALID_ANSWER' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('lets a failure of the wait or the activity through untouched', async () => {
    const boom = new Error('cancelled');
    const h = harness([]);
    h.waitSignal.mockRejectedValueOnce(boom);
    await expect(
      runWithNeedsInput({
        deps: h.deps,
        invoke: async () => pauseOf(),
        key: 'k',
        label: 'x',
        limits,
      })
    ).rejects.toBe(boom);
    await expect(
      runWithNeedsInput({
        deps: h.deps,
        invoke: async () => {
          throw boom;
        },
        key: 'k',
        label: 'x',
        limits,
      })
    ).rejects.toBe(boom);
  });

  it('fails a malformed pause instead of passing it on as a result', async () => {
    const h = harness([]);
    const malformed = { needsInput: { questions: [], resume: {} } };
    const err = await runWithNeedsInput({
      deps: h.deps,
      invoke: async () => malformed,
      key: 'k',
      label: 'x',
      limits,
    }).catch((e) => e);
    expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_MALFORMED' });
    expect(h.createHumanStep).not.toHaveBeenCalled();
  });

  describe('an answer that cannot be used', () => {
    it('opens a new step for the same round, without running the activity or using the round', async () => {
      const h = harness([submit('nope'), submit('B')]);
      const invoke = vi.fn(async (p: PauseArgs) => (p.resumeInput ? { text: 'final' } : pauseOf()));
      await expect(
        runWithNeedsInput({ deps: h.deps, invoke, key: 'k', label: 'x', limits })
      ).resolves.toEqual({ text: 'final' });
      expect(h.createHumanStep.mock.calls.map((c) => c[0].nodeId)).toEqual([
        askRecordingId('k', 1),
        reaskRecordingId('k', 1, 1),
      ]);
      expect(reaskRecordingId('k', 1, 1)).toBe('k:ask:1.1');
      expect(h.createHumanStep.mock.calls[1]?.[0]).toMatchObject({
        description: expect.stringContaining('previous answer could not be used'),
        signalName: 'hitl_k:ask:1.1',
      });
      expect(h.createHumanStep.mock.calls[1]?.[0].description).toContain('Which?');
      expect(h.createHumanStep.mock.calls[0]?.[0].description).not.toContain('previous answer');
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke.mock.calls[1]?.[0]?.resumeInput?.round).toBe(1);
    });

    it('closes each superseded step as cancelled before opening its repeat', async () => {
      const h = harness([submit('nope'), submit('nope'), submit('B')]);
      const events: string[] = [];
      h.resolveHumanStep.mockImplementation(async (a) => {
        events.push(`resolve ${a.nodeId} ${a.status}`);
      });
      h.createHumanStep.mockImplementation(async (a) => {
        events.push(`create ${a.nodeId}`);
      });
      await runWithNeedsInput({
        deps: h.deps,
        invoke: async (p) => (p.resumeInput ? { text: 'final' } : pauseOf()),
        key: 'k',
        label: 'x',
        limits,
      });
      expect(events).toEqual([
        'create k:ask:1',
        'resolve k:ask:1 CANCELLED',
        'create k:ask:1.1',
        'resolve k:ask:1.1 CANCELLED',
        'create k:ask:1.2',
      ]);
    });

    it('does not fail the re-ask when closing the superseded step fails', async () => {
      const h = harness([submit('nope'), submit('B')]);
      h.resolveHumanStep.mockRejectedValue(new Error('db down'));
      await expect(
        runWithNeedsInput({
          deps: h.deps,
          invoke: async (p) => (p.resumeInput ? { text: 'final' } : pauseOf()),
          key: 'k',
          label: 'x',
          limits,
        })
      ).resolves.toEqual({ text: 'final' });
    });

    it('fails NEEDS_INPUT_INVALID_ANSWER after the most re-asks', async () => {
      const h = harness(Array.from({ length: MAX_REASKS_PER_ROUND + 2 }, () => submit('nope')));
      const invoke = vi.fn(async () => pauseOf());
      const err = await runWithNeedsInput({
        deps: h.deps,
        invoke,
        key: 'k',
        label: 'x',
        limits,
      }).catch((e) => e);
      expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_INVALID_ANSWER' });
      expect(h.createHumanStep).toHaveBeenCalledTimes(MAX_REASKS_PER_ROUND + 1);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('fails at once, as before, when the execution predates the re-ask marker', async () => {
      const h = harness([submit('nope'), submit('B')], [NEEDS_INPUT_REASK_PATCH]);
      const err = await runWithNeedsInput({
        deps: h.deps,
        invoke: async () => pauseOf(),
        key: 'k',
        label: 'x',
        limits,
      }).catch((e) => e);
      expect(err).toMatchObject({ type: 'NEEDS_INPUT_INVALID_ANSWER' });
      expect(h.createHumanStep).toHaveBeenCalledTimes(1);
    });

    it('times a re-asked step out under its own id', async () => {
      const h = harness([submit('nope'), undefined]);
      const err = await runWithNeedsInput({
        deps: h.deps,
        invoke: async () => pauseOf(),
        key: 'k',
        label: 'x',
        limits,
      }).catch((e) => e);
      expect(err).toMatchObject({ type: 'NEEDS_INPUT_TIMEOUT' });
      expect(h.resolveHumanStep).toHaveBeenCalledWith({ nodeId: 'k:ask:1.1', status: 'TIMED_OUT' });
    });
  });

  describe('the limit', () => {
    it('resumes once more, unable to ask and told to finish, instead of discarding the last round', async () => {
      const h = harness([submit('A'), submit('A')]);
      const invoke = vi.fn(async (p: PauseArgs) =>
        p.resumeInput?.final ? { text: 'best' } : pauseOf('d')
      );
      await expect(
        runWithNeedsInput({ deps: h.deps, invoke, key: 'k', label: 'x', limits })
      ).resolves.toEqual({ text: 'best' });
      // Two answered rounds, then the third pause is not put to anyone.
      expect(h.createHumanStep).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenCalledTimes(4);
      expect(invoke.mock.calls[3]?.[0]).toEqual({
        allowPause: false,
        resumeInput: { answers: [], final: true, resume: pauseOf('d').needsInput.resume, round: 3 },
      });
    });

    it('still fails NEEDS_INPUT_LIMIT when the final run pauses again', async () => {
      const h = harness([submit('A'), submit('A')]);
      const invoke = vi.fn(async () => pauseOf());
      const err = await runWithNeedsInput({
        deps: h.deps,
        invoke,
        key: 'k',
        label: 'x',
        limits,
      }).catch((e) => e);
      expect(err).toMatchObject({ nonRetryable: true, type: 'NEEDS_INPUT_LIMIT' });
      expect(invoke).toHaveBeenCalledTimes(4);
      expect(h.createHumanStep).toHaveBeenCalledTimes(2);
    });
  });

  describe('a cancelled wait', () => {
    it('closes the open question as cancelled in a non-cancellable scope, and rethrows', async () => {
      const boom = new Error('cancelled');
      const h = harness([]);
      h.waitSignal.mockRejectedValueOnce(boom);
      await expect(
        runWithNeedsInput({
          deps: h.deps,
          invoke: async () => pauseOf(),
          key: 'k',
          label: 'x',
          limits,
        })
      ).rejects.toBe(boom);
      expect(h.nonCancellableRuns).toHaveBeenCalledTimes(1);
      expect(h.resolveHumanStep).toHaveBeenCalledWith({ nodeId: 'k:ask:1', status: 'CANCELLED' });
    });

    it('closes the re-asked step, not the first one', async () => {
      const boom = new Error('cancelled');
      const h = harness([submit('nope')]);
      h.waitSignal.mockImplementationOnce(async () => submit('nope'));
      h.waitSignal.mockRejectedValueOnce(boom);
      await expect(
        runWithNeedsInput({
          deps: h.deps,
          invoke: async () => pauseOf(),
          key: 'k',
          label: 'x',
          limits,
        })
      ).rejects.toBe(boom);
      expect(h.resolveHumanStep).toHaveBeenCalledWith({ nodeId: 'k:ask:1.1', status: 'CANCELLED' });
    });

    it('leaves the step alone when the execution predates the cancel marker', async () => {
      const boom = new Error('cancelled');
      const h = harness([], [NEEDS_INPUT_CANCEL_PATCH]);
      h.waitSignal.mockRejectedValueOnce(boom);
      await expect(
        runWithNeedsInput({
          deps: h.deps,
          invoke: async () => pauseOf(),
          key: 'k',
          label: 'x',
          limits,
        })
      ).rejects.toBe(boom);
      expect(h.resolveHumanStep).not.toHaveBeenCalled();
    });

    it('does not touch the step for a failure that is not a cancellation', async () => {
      const h = harness([]);
      h.waitSignal.mockRejectedValueOnce(new Error('other'));
      await expect(
        runWithNeedsInput({
          deps: h.deps,
          invoke: async () => pauseOf(),
          key: 'k',
          label: 'x',
          limits,
        })
      ).rejects.toThrow('other');
      expect(h.resolveHumanStep).not.toHaveBeenCalled();
    });
  });
});
