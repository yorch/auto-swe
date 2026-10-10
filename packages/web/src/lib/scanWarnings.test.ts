import { describe, expect, it } from 'vitest';
import { SCAN_INCOMPLETE, scanWarningLead } from './scanWarnings';

describe('scanWarningLead', () => {
  it('does not call an unfinished scan a finding', () => {
    expect(scanWarningLead([SCAN_INCOMPLETE])).toContain('could not fully scan');
    expect(scanWarningLead([SCAN_INCOMPLETE])).not.toContain('flagged');
  });
  it('says both when there are findings and an unfinished scan', () => {
    const lead = scanWarningLead(['injection: x', SCAN_INCOMPLETE]);
    expect(lead).toContain('flagged');
    expect(lead).toContain('could not fully scan');
  });
  it('says flagged for findings alone', () => {
    expect(scanWarningLead(['injection: x'])).not.toContain('could not');
  });
});
