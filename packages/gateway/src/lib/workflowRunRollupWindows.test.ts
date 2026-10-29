import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowRunRollupHorizonMs } from './workflowRunRollupWindows.js';

describe('workflowRunRollupHorizonMs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the shared scheduled-sweep recompute-days setting', () => {
    vi.stubEnv('WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS', '10');
    const now = Date.UTC(2026, 9, 20, 14);
    expect(workflowRunRollupHorizonMs(now)).toBe(Date.UTC(2026, 9, 10));
  });
});
