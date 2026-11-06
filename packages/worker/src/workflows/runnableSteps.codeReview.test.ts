import { describe, expect, it, vi } from 'vitest';

const loadChangeForReview = vi.fn(async (_request: unknown) => ({}));
const publishReviewResult = vi.fn(async (_input: unknown) => ({}));
const runReviewNetwork = vi.fn(async (..._args: unknown[]) => ({}));
const gatherReview = vi.fn(async (_input: unknown) => ({}));

vi.mock('./runnableActivities.js', async (original) => {
  const actual = await original<typeof import('./runnableActivities.js')>();
  return {
    ...actual,
    agentActivities: { ...actual.agentActivities, runReviewNetwork },
    codeReviewActivities: { loadChangeForReview, publishReviewResult },
    prFeedbackQodoGatherActivities: { gatherPrFeedback: gatherReview },
  };
});

const { dispatchStepImpl } = await import('./runnableSteps.js');
const request = { payload: { systemPrompt: 'Preset prompt' }, repoId: 'repo' } as never;

describe('review step dispatch', () => {
  it('uses the heartbeating gather timeout for a review waiting to finalize', async () => {
    const feedbackRequest = { payload: { feedbackTrigger: 'review_findings' } } as never;
    await dispatchStepImpl('gatherPrFeedback', {}, feedbackRequest, {}, {}, 'gather');
    expect(gatherReview).toHaveBeenCalledWith({ request: feedbackRequest });
  });
  it('uses the run request, not untrusted input connection fields', async () => {
    await dispatchStepImpl('loadChangeForReview', {}, request, {}, { repoId: 'other' }, 'load');
    expect(loadChangeForReview).toHaveBeenCalledWith(request);
  });

  it('passes review, Qodo and human outputs to publication', async () => {
    const inputs = {
      human: { decision: 'approve' },
      qodo: { blocking: false },
      review: { approved: true },
    };
    await dispatchStepImpl('publishReviewResult', {}, request, {}, inputs, 'publish');
    expect(publishReviewResult).toHaveBeenCalledWith({ ...inputs, request });
  });

  it.each([
    ['Preset prompt', 'Preset prompt'],
    ['', undefined],
    [undefined, 'Config prompt'],
  ])('forwards the bound prompt (%s)', async (prompt, expected) => {
    await dispatchStepImpl(
      'runReviewNetwork',
      {},
      request,
      { systemPrompt: 'Config prompt' },
      { codeResult: { headSha: 'sha' }, systemPrompt: prompt },
      'review'
    );
    expect(runReviewNetwork.mock.calls.at(-1)?.[2]).toBe(expected);
  });
});
