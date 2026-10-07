import { describe, expect, it } from 'vitest';
import { NodeSchema } from '../../spec.js';
import { failureLesson } from './failureLesson.js';

describe('failureLesson', () => {
  it('is a best-effort commitToMemory step that records the outcome and goes on', () => {
    expect(failureLesson('CI_FAILED', 'terminateCIFailed', { group: 'CI loop' })).toEqual({
      group: 'CI loop',
      inputs: { outcome: { literal: 'CI_FAILED' } },
      next: 'terminateCIFailed',
      onError: 'continue',
      step: 'commitToMemory',
      title: 'Store what failed CI',
      type: 'step',
    });
  });

  it('titles a review lesson by default and lets a caller override it', () => {
    expect(failureLesson('REVIEW_FAILED', 't').title).toBe('Store what the review rejected');
    expect(failureLesson('REVIEW_FAILED', 't', { title: 'Mine' }).title).toBe('Mine');
    expect('group' in failureLesson('REVIEW_FAILED', 't')).toBe(false);
  });

  it('is a valid step node', () => {
    expect(NodeSchema.safeParse(failureLesson('REVIEW_FAILED', 't', { group: 'g' })).success).toBe(
      true
    );
  });
});
