import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<unknown[]>,
  results: [] as Array<{ failed: number; sent: number; skipped: number }>,
  sleeps: [] as string[],
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    sendReportDigests: (...args: unknown[]) => {
      mocks.calls.push(args);
      return Promise.resolve(mocks.results.shift() ?? { failed: 0, sent: 0, skipped: 0 });
    },
  }),
  sleep: async (duration: string) => {
    mocks.sleeps.push(duration);
  },
}));

import { ScheduledReportDigestWorkflow } from './scheduledReportDigest.js';

beforeEach(() => {
  mocks.results = [];
  mocks.sleeps = [];
  mocks.calls = [];
});

describe('ScheduledReportDigestWorkflow', () => {
  it('sleeps between failed-only delivery passes and stops after success', async () => {
    mocks.results = [
      { failed: 1, sent: 0, skipped: 0 },
      { failed: 0, sent: 1, skipped: 0 },
    ];
    const input = { subscriptionId: 'subscription-1' };

    await expect(ScheduledReportDigestWorkflow(input)).resolves.toEqual({
      failed: 0,
      sent: 1,
      skipped: 0,
    });

    expect(mocks.calls).toEqual([[input], [input]]);
    expect(mocks.sleeps).toEqual(['15 minutes']);
  });

  it('caps scheduled delivery at three attempts and does not retry send-tests', async () => {
    mocks.results = Array.from({ length: 3 }, () => ({ failed: 1, sent: 0, skipped: 0 }));
    await expect(ScheduledReportDigestWorkflow()).resolves.toEqual({
      failed: 1,
      sent: 0,
      skipped: 0,
    });
    expect(mocks.calls).toHaveLength(3);
    expect(mocks.sleeps).toEqual(['15 minutes', '15 minutes']);

    mocks.calls = [];
    mocks.sleeps = [];
    mocks.results = [{ failed: 1, sent: 0, skipped: 0 }];
    await expect(ScheduledReportDigestWorkflow({ sendTest: true })).resolves.toEqual({
      failed: 1,
      sent: 0,
      skipped: 0,
    });
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.sleeps).toEqual([]);
  });
});
