import { describe, expect, it } from 'vitest';
import { openRunLabel } from './runColumns';

describe('openRunLabel', () => {
  it('says a request with pending human steps is waiting, not running', () => {
    expect(openRunLabel({ pendingStepCount: 1, status: 'RUNNING' }).text).toBe(
      'Waiting for approval'
    );
  });

  it('says a run with no pending count is still running', () => {
    expect(openRunLabel({ status: 'RUNNING' }).text).toBe('Still running');
  });

  it('shows a dash for a finished run', () => {
    expect(openRunLabel({ pendingStepCount: 2, status: 'FAILED' }).text).toBe('—');
  });
});
