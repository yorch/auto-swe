import { describe, expect, it } from 'vitest';
import {
  assertCurrentWorkflowOwnsCampaign,
  assertOwnCampaignWorkflowId,
  CAMPAIGN_WORKFLOW_MISMATCH,
  campaignWorkflowIdOf,
} from './campaignIdentity.js';

const C = '33333333-3333-4333-8333-333333333333';

describe('campaign workflow identity', () => {
  it('names the workflow a campaign owns', () => {
    expect(campaignWorkflowIdOf(C)).toBe(`campaign-${C}`);
  });

  it('accepts only that workflow id, with a non-retryable refusal for any other', () => {
    expect(() => assertOwnCampaignWorkflowId(C, `campaign-${C}`)).not.toThrow();
    for (const other of ['', 'campaign-other', `campaign-${C}-x`, `orch-${C}`]) {
      try {
        assertOwnCampaignWorkflowId(C, other);
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as { type?: string }).type).toBe(CAMPAIGN_WORKFLOW_MISMATCH);
        expect((err as { nonRetryable?: boolean }).nonRetryable).toBe(true);
      }
    }
  });

  it('judges nothing outside an activity', () => {
    expect(() => assertCurrentWorkflowOwnsCampaign(C)).not.toThrow();
  });
});
