import {
  ActivityFailure,
  CancelledFailure,
  RetryState,
  TimeoutFailure,
  TimeoutType,
} from '@temporalio/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postTicketComment = vi.fn(
  async (..._args: unknown[]): Promise<{ posted: boolean; reason?: string }> => ({ posted: true })
);

vi.mock('./runnableActivities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runnableActivities.js')>();
  return { ...actual, trackerCommentActivities: { postTicketComment } };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');

const ctx = { workflow: { id: 'wf-1' } } as never;
const request = { externalTicketId: 'DEMO-4', workRequestId: 'wr-1' } as never;

beforeEach(() => {
  postTicketComment.mockReset().mockResolvedValue({ posted: true });
});

describe('the postTicketComment step', () => {
  it("passes the bound body and heading with the run's work request", async () => {
    const out = await dispatchStepImpl(
      'postTicketComment',
      ctx,
      request,
      {},
      { body: 'Verdict: NOT EXPLOITABLE', heading: 'auto-swe triage' },
      'comment'
    );
    expect(out).toEqual({ posted: true });
    expect(postTicketComment).toHaveBeenCalledWith({
      body: 'Verdict: NOT EXPLOITABLE',
      heading: 'auto-swe triage',
      workRequestId: 'wr-1',
    });
  });

  it('falls back to the config when nothing is bound', async () => {
    await dispatchStepImpl('postTicketComment', ctx, request, { body: 'Fixed text' }, {}, 'c');
    expect(postTicketComment).toHaveBeenCalledWith({ body: 'Fixed text', workRequestId: 'wr-1' });
  });

  it('hands an unbound body to the activity as empty, which skips it', async () => {
    await dispatchStepImpl('postTicketComment', ctx, request, {}, { body: undefined }, 'c');
    expect(postTicketComment).toHaveBeenCalledWith({ body: '', workRequestId: 'wr-1' });
  });

  it.each([
    [42, 'number'],
    [['a'], 'array'],
    [{ verdict: 'x' }, 'object'],
    [true, 'boolean'],
  ])('does not post a body that is not text (%j)', async (body, kind) => {
    const out = await dispatchStepImpl('postTicketComment', ctx, request, {}, { body }, 'c');
    expect(out).toEqual({
      posted: false,
      reason: `the comment body is not text (got ${kind})`,
    });
    expect(postTicketComment).not.toHaveBeenCalled();
  });

  it('returns posted: false instead of failing the run when the activity times out', async () => {
    postTicketComment.mockRejectedValue(
      new ActivityFailure(
        'activity StartToClose timeout',
        'postTicketComment',
        '7',
        RetryState.MAXIMUM_ATTEMPTS_REACHED,
        undefined,
        new TimeoutFailure('timeout', undefined, TimeoutType.START_TO_CLOSE)
      )
    );
    const out = await dispatchStepImpl('postTicketComment', ctx, request, {}, { body: 'X' }, 'c');
    expect(out).toEqual({
      posted: false,
      reason:
        'the comment step did not finish (timed out or lost its worker); the comment may or may not have been posted',
    });
  });

  it('still lets a cancellation end the run', async () => {
    const cancelled = new CancelledFailure('cancelled');
    postTicketComment.mockRejectedValue(cancelled);
    await expect(
      dispatchStepImpl('postTicketComment', ctx, request, {}, { body: 'X' }, 'c')
    ).rejects.toBe(cancelled);
  });
});
