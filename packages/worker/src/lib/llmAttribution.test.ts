import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { failedCallAttribution } from './llmAttribution.js';

const paid = {
  costUsd: 0.4,
  inputTokens: 900,
  modelSpec: 'anthropic/claude-opus-4-8',
  outputTokens: 80,
};

describe('failedCallAttribution', () => {
  it('prices a call whose usage was accrued before something after it threw', () => {
    expect(failedCallAttribution(new Error('no structured output'), 'x/y', paid)).toEqual({
      costUsd: 0.4,
      inputTokens: 900,
      model: 'anthropic/claude-opus-4-8',
      outputTokens: 80,
    });
  });

  it('reads the attribution a post-call BUDGET_EXCEEDED carries', () => {
    const err = ApplicationFailure.nonRetryable('over', 'BUDGET_EXCEEDED', {
      attribution: paid,
      tier: 'STANDARD',
    });
    expect(failedCallAttribution(err, 'x/y')).toMatchObject({
      costUsd: 0.4,
      model: paid.modelSpec,
    });
  });

  it('falls back to the configured model when the call never reached the ledger', () => {
    // The pre-call budget gate throws BUDGET_EXCEEDED with no attribution.
    const gate = ApplicationFailure.nonRetryable('exhausted', 'BUDGET_EXCEEDED', { tier: 'LARGE' });
    expect(failedCallAttribution(gate, 'anthropic/claude-sonnet-4-6')).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
    });
    expect(failedCallAttribution(new Error('529'), undefined)).toEqual({ model: undefined });
  });
});
