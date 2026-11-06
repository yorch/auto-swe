import { describe, expect, it } from 'vitest';
import {
  PR_FEEDBACK_DEFAULTS,
  PR_FEEDBACK_INPUT_SCHEMA,
  PR_FEEDBACK_TEMPLATE_NAME,
  PrFeedbackPayloadSchema,
} from './prFeedback.js';

const payload = {
  baseBranch: 'auto/prfb-1-777',
  connectionId: '00000000-0000-4000-8000-000000000001',
  feedbackEventId: '777',
  feedbackEventKind: 'review',
  feedbackOrigin: 'workflow',
  feedbackTrigger: 'changes_requested',
  pullRequestNumber: 1,
  ticketId: 'prfb-1-777',
};

describe('PrFeedbackPayloadSchema', () => {
  it('uses an actual review run UUID only for the trusted review_findings kind', () => {
    const review = {
      ...payload,
      feedbackEventId: '11111111-1111-4111-8111-111111111111',
      feedbackEventKind: 'review_findings',
      feedbackTrigger: 'review_findings',
    };
    expect(PrFeedbackPayloadSchema.safeParse(review).success).toBe(true);
    expect(
      PrFeedbackPayloadSchema.safeParse({ ...review, feedbackEventKind: 'review' }).success
    ).toBe(false);
    expect(PrFeedbackPayloadSchema.safeParse({ ...review, feedbackEventId: '777' }).success).toBe(
      false
    );
    expect(
      PrFeedbackPayloadSchema.safeParse({ ...payload, feedbackEventId: review.feedbackEventId })
        .success
    ).toBe(false);
  });
  it('parses a run payload, applying the option defaults', () => {
    const parsed = PrFeedbackPayloadSchema.parse(payload);
    expect(parsed.maxRounds).toBe(PR_FEEDBACK_DEFAULTS.maxRounds);
    expect(parsed.maxCiFixAttempts).toBe(PR_FEEDBACK_DEFAULTS.maxCiFixAttempts);
  });

  it('accepts a platform work branch as the base — it is the pull request’s head', () => {
    expect(PrFeedbackPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      PrFeedbackPayloadSchema.safeParse({ ...payload, baseBranch: 'not a branch!' }).success
    ).toBe(false);
  });

  it.each([
    [{ maxRounds: 0 }, { maxRounds: 21 }],
    [{ maxCiFixAttempts: -1 }, { maxCiFixAttempts: 2 }],
    [{ pullRequestNumber: 0 }, { feedbackEventId: 'x' }],
  ])('refuses out-of-bounds values %j', (...cases) => {
    for (const over of cases) {
      expect(PrFeedbackPayloadSchema.safeParse({ ...payload, ...over }).success).toBe(false);
    }
  });

  it('declares its contract on the template input schema', () => {
    expect(PR_FEEDBACK_TEMPLATE_NAME).toBe('address-pr-feedback');
    for (const key of [
      'baseBranch',
      'connectionId',
      'feedbackEventId',
      'feedbackEventKind',
      'feedbackOrigin',
      'feedbackTrigger',
      'pullRequestNumber',
    ]) {
      expect(PR_FEEDBACK_INPUT_SCHEMA.required).toContain(key);
    }
    expect(PR_FEEDBACK_INPUT_SCHEMA.properties.maxRounds?.default).toBe(5);
    expect(PR_FEEDBACK_INPUT_SCHEMA.properties.maxCiFixAttempts?.default).toBe(1);
  });
});
