import { describe, expect, it } from 'vitest';
import { reviewLoop } from './reviewLoop.js';
import { expectWellFormed } from './testUtil.js';

describe('reviewLoop', () => {
  it('expands to seven plain nodes', () => {
    const nodes = reviewLoop({ approved: 'next' });
    expect(Object.keys(nodes).sort()).toEqual([
      'checkApproval',
      'checkStalled',
      'forgetRejection',
      'review',
      'reviewFix',
      'storeRejection',
      'terminateReviewFailed',
    ]);
    expectWellFormed(nodes, 'review', ['next']);
  });

  it('stops on a repeated rejection before the limit, to the same place as running out', () => {
    const nodes = reviewLoop({ approved: 'n' });
    expect(nodes.review).toMatchObject({
      inputs: { previousFingerprint: { default: '', from: 'context.lastReviewFingerprint' } },
    });
    expect(nodes.storeRejection).toMatchObject({
      next: 'checkStalled',
      values: {
        'context.lastReviewFingerprint': {
          default: '',
          from: 'nodes.review.output.rejectionFingerprint',
        },
      },
    });
    expect(nodes.checkStalled).toMatchObject({
      expr: 'nodes.review.output.stalled == true',
      onFalse: 'reviewFix',
      onTrue: 'terminateReviewFailed',
      type: 'cond',
    });
  });

  it('sends a stall to `exhausted` when given one, as it does the limit', () => {
    const nodes = reviewLoop({ approved: 'n', exhausted: 'lessonReviewFailed' });
    expect(nodes.checkStalled).toMatchObject({ onTrue: 'lessonReviewFailed' });
    expect(nodes.reviewFix).toMatchObject({ onExhausted: 'lessonReviewFailed' });
  });

  it('is one group', () => {
    const groups = new Set(Object.values(reviewLoop({ approved: 'n' })).map((n) => n.group));
    expect([...groups]).toEqual(['review loop']);
  });

  it('routes an approval to `approved` and a fix back into the review by default', () => {
    const nodes = reviewLoop({ approved: 'openPR' });
    expect(nodes.checkApproval).toMatchObject({
      onFalse: 'storeRejection',
      onTrue: 'forgetRejection',
    });
    expect(nodes.forgetRejection).toMatchObject({
      next: 'openPR',
      values: { 'context.lastReviewFingerprint': { literal: '' } },
    });
    expect(nodes.reviewFix).toMatchObject({
      next: 'review',
      storeAs: 'context.currentCodeResult',
    });
    expect(nodes.review).toMatchObject({ next: 'checkApproval', status: 'IN_REVIEW' });
  });

  it('sends the fixed code to `afterFix` when given one', () => {
    const nodes = reviewLoop({ afterFix: 'clearCiResult', approved: 'n' });
    expect(nodes.reviewFix).toMatchObject({ next: 'clearCiResult' });
  });

  it('bounds the fixer with maxVisits: limit - 1 fixes, 2 unless told otherwise', () => {
    expect(reviewLoop({ approved: 'n' }).reviewFix).toMatchObject({
      maxVisits: 2,
      onExhausted: 'terminateReviewFailed',
    });
    expect(reviewLoop({ approved: 'n', limit: 5 }).reviewFix).toMatchObject({ maxVisits: 4 });
    expect(() => reviewLoop({ approved: 'n', limit: 1 })).toThrow(/at least 2/);
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
