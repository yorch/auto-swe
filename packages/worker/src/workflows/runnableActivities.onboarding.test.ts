import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ proxy: vi.fn(() => ({})) }));
vi.mock('@temporalio/workflow', () => ({ proxyActivities: m.proxy }));

it('gives onboarding trials a heartbeat and no retries, with a bounded total timeout', async () => {
  await import('./runnableActivities.js');
  expect(m.proxy).toHaveBeenCalledWith({
    heartbeatTimeout: '1m',
    retry: { maximumAttempts: 1 },
    startToCloseTimeout: '36h',
  });
});
