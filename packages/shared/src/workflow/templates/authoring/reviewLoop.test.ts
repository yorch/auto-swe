import { describe, expect, it } from 'vitest';
import { reviewLoop } from './reviewLoop.js';
import { expectWellFormed } from './testUtil.js';

describe('reviewLoop', () => {
  it('expands to nine plain nodes under the ids the templates have always used', () => {
    const nodes = reviewLoop({ approved: 'next' });
    expect(Object.keys(nodes).sort()).toEqual([
      'checkApproval',
      'checkReviewLimit',
      'incReviewRetries',
      'review',
      'reviewFix',
      'setReviewing',
      'storeRejection',
      'terminateReviewFailed',
      'updateCodeAfterReviewFix',
    ]);
    expectWellFormed(nodes, 'setReviewing', ['next']);
  });

  it('is one group', () => {
    const groups = new Set(Object.values(reviewLoop({ approved: 'n' })).map((n) => n.group));
    expect([...groups]).toEqual(['review loop']);
  });

  it('routes an approval to `approved` and a fix back into the review by default', () => {
    const nodes = reviewLoop({ approved: 'openPR' });
    expect(nodes.checkApproval).toMatchObject({ onFalse: 'incReviewRetries', onTrue: 'openPR' });
    expect(nodes.updateCodeAfterReviewFix).toMatchObject({ next: 'setReviewing' });
    expect(nodes.setReviewing).toMatchObject({ config: { status: 'IN_REVIEW' }, next: 'review' });
  });

  it('sends the fixed code to `afterFix` when given one', () => {
    const nodes = reviewLoop({ afterFix: 'clearCiResult', approved: 'n' });
    expect(nodes.updateCodeAfterReviewFix).toMatchObject({ next: 'clearCiResult' });
  });

  it('puts the attempt limit in the cond, 3 unless told otherwise', () => {
    expect(reviewLoop({ approved: 'n' }).checkReviewLimit).toMatchObject({
      expr: 'context.reviewRetries >= 3',
    });
    expect(reviewLoop({ approved: 'n', limit: 5 }).checkReviewLimit).toMatchObject({
      expr: 'context.reviewRetries >= 5',
    });
  });

  it('can name the keep-the-fix node differently without breaking the wiring', () => {
    const nodes = reviewLoop({ approved: 'n', keepFixId: 'updateCodeAfterFix' });
    expect(nodes.updateCodeAfterReviewFix).toBeUndefined();
    expect(nodes.reviewFix).toMatchObject({ next: 'updateCodeAfterFix' });
    expectWellFormed(nodes, 'setReviewing', ['n']);
  });

  it('terminates a failed review with a bare FAILED (no result)', () => {
    const t = reviewLoop({ approved: 'n' }).terminateReviewFailed;
    expect(t).toMatchObject({ status: 'FAILED', type: 'terminate' });
    expect('result' in t).toBe(false);
  });

  it('returns fresh nodes each call', () => {
    const a = reviewLoop({ approved: 'n' });
    const b = reviewLoop({ approved: 'n' });
    expect(a.review).not.toBe(b.review);
    expect(a).toEqual(b);
  });

  it('gives reviewFix no config unless asked, so other templates are unchanged', () => {
    expect(reviewLoop({ approved: 'n' }).reviewFix).not.toHaveProperty('config');
  });

  it('passes fixConfig to reviewFix and nowhere else', () => {
    const nodes = reviewLoop({
      approved: 'n',
      fixConfig: { allowedPaths: ['a.ts'], systemPrompt: 'p' },
    });
    expect(nodes.reviewFix).toMatchObject({
      config: { allowedPaths: ['a.ts'], systemPrompt: 'p' },
      step: 'executeReviewFixImplementation',
    });
    expect(nodes.review).not.toHaveProperty('config');
  });
});
