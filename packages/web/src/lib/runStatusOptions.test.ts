import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { isRunStatus, runStatusOptions } from './runStatusOptions';

describe('runStatusOptions', () => {
  it('offers exactly the statuses the gateway accepts, plus "all"', () => {
    const values = runStatusOptions().map((o) => o.value);
    expect(values).toEqual(['', ...WORKFLOW_RUN_STATUSES]);
    expect(values).toContain('SUCCESS');
    expect(values).not.toContain('SUCCEEDED');
  });

  it('recognises run statuses', () => {
    expect(isRunStatus('SUCCESS')).toBe(true);
    expect(isRunStatus('SUCCEEDED')).toBe(false);
  });
});
