import { describe, expect, it } from 'vitest';
import { ticketToMergeNodes } from './ticketToMerge.js';

describe('ticket-to-merge UI verification', () => {
  it('runs uiVerify after implementation and warns on failed verification', () => {
    const nodes = ticketToMergeNodes('setAwaitingHumanMerge', { uiVerify: true });

    expect(nodes.implement).toMatchObject({
      next: 'uiVerify',
      step: 'executeImplementation',
    });
    expect(nodes.uiVerify).toMatchObject({
      next: 'initCounters',
      onFail: 'warn',
      step: 'uiVerify',
      type: 'step',
    });
  });

  it('leaves callers that do not opt in unchanged', () => {
    expect(ticketToMergeNodes('qodoReview').implement).toMatchObject({
      next: 'initCounters',
    });
  });
});
