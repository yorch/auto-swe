import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it, vi } from 'vitest';
import {
  type AskDeps,
  askRecordingId,
  type PauseArgs,
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

function harness(replies: unknown[]) {
  const createHumanStep = vi.fn<AskDeps['createHumanStep']>(async () => {});
  const resolveHumanStep = vi.fn<AskDeps['resolveHumanStep']>(async () => {});
  const waitSignal = vi.fn<AskDeps['waitSignal']>(async () => replies.shift());
  return {
    createHumanStep,
    deps: { createHumanStep, resolveHumanStep, waitSignal },
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

  it('fails NEEDS_INPUT_LIMIT when the step keeps asking, without opening another step', async () => {
    const h = harness([submit('A'), submit('A'), submit('A')]);
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

  it('fails NEEDS_INPUT_INVALID_ANSWER on an answer that fits no question', async () => {
    const h = harness([submit('nope')]);
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
});
