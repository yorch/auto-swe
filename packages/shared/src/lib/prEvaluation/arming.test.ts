import { describe, expect, it } from 'vitest';
import { type AutoArmingInput, autoArmingRefusals } from './arming.js';

const OK: AutoArmingInput = {
  approvalSatisfied: false,
  context: 'auto-swe/pr-evaluation',
  draft: false,
  readiness: {
    allowsAutoMerge: true,
    requiredReviewCount: 1,
    requiredStatusContexts: ['ci', 'auto-swe/pr-evaluation'],
    requiredStatusPinnedToApp: true,
    requiresReviews: true,
  },
  statusPublished: true,
};

const withRules = (over: Record<string, unknown>): AutoArmingInput => ({
  ...OK,
  readiness: { ...OK.readiness, ...over },
});

describe('autoArmingRefusals', () => {
  it('allows arming when GitHub enforces our status and every input holds', () => {
    expect(autoArmingRefusals(OK)).toEqual([]);
  });

  it('allows arming without required reviews when the approvals are already satisfied', () => {
    expect(
      autoArmingRefusals({ ...withRules({ requiresReviews: false }), approvalSatisfied: true })
    ).toEqual([]);
  });

  it.each([
    ['auto-merge not allowed', withRules({ allowsAutoMerge: false })],
    ['auto-merge unknown', withRules({ allowsAutoMerge: 'unknown' })],
    ['required contexts unknown', withRules({ requiredStatusContexts: 'unknown' })],
    ['our context is not required', withRules({ requiredStatusContexts: ['ci'] })],
    ['required review count is zero', withRules({ requiredReviewCount: 0 })],
    ['required review count is unknown', withRules({ requiredReviewCount: 'unknown' })],
    ['required review count absent (an older row)', withRules({ requiredReviewCount: undefined })],
    ['status not pinned to an App', withRules({ requiredStatusPinnedToApp: false })],
    ['pinning unknown', withRules({ requiredStatusPinnedToApp: 'unknown' })],
    ['pinning absent (an older row)', withRules({ requiredStatusPinnedToApp: undefined })],
    ['no reviews required and no approval', withRules({ requiresReviews: false })],
    ['review requirement unknown and no approval', withRules({ requiresReviews: 'unknown' })],
    ['status not published', { ...OK, statusPublished: false }],
    ['draft', { ...OK, draft: true }],
    ['no readiness at all', { ...OK, readiness: null }],
  ] as [string, AutoArmingInput][])('refuses: %s', (_name, input) => {
    expect(autoArmingRefusals(input).length).toBeGreaterThan(0);
  });

  it('lists every reason, not only the first', () => {
    const reasons = autoArmingRefusals({
      ...OK,
      draft: true,
      readiness: null,
      statusPublished: false,
    });
    expect(reasons.length).toBeGreaterThanOrEqual(5);
    expect(reasons).toContain('draft');
  });

  it('allows arming with a zero review count when the approvals are already satisfied', () => {
    expect(
      autoArmingRefusals({ ...withRules({ requiredReviewCount: 0 }), approvalSatisfied: true })
    ).toEqual([]);
  });

  it('says an unknown pin needs a GitHub App, since a personal access token cannot be pinned', () => {
    expect(
      autoArmingRefusals(withRules({ requiredStatusPinnedToApp: 'unknown' })).join(' ')
    ).toMatch(/a personal access token cannot be pinned; configure a GitHub App/);
  });

  it("says a pin to another App or to none is not the platform's own App", () => {
    expect(autoArmingRefusals(withRules({ requiredStatusPinnedToApp: false })).join(' ')).toMatch(
      /not pinned to the platform's own GitHub App/
    );
  });
});
