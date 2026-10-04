import { describe, expect, it } from 'vitest';
import { eventLabel, riskClassLabel } from './autonomyEvents';

describe('autonomy wording', () => {
  it('names known events and risk classes in plain language', () => {
    expect(eventLabel('approve_partial')).toBe('Approved (more approvals needed)');
    expect(riskClassLabel('external_communication')).toBe('External communication');
  });

  it('shows an unknown event or custom class as written', () => {
    expect(eventLabel('escalate')).toBe('escalate');
    expect(riskClassLabel('legal_hold')).toBe('legal_hold');
  });
});
