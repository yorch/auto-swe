import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<unknown[]>,
  proxyOptions: null as unknown,
  results: [] as Array<{
    failed: number;
    rollupIncomplete?: number;
    sent: number;
    skipped: number;
  }>,
  runStartTime: new Date('2026-10-26T23:50:00.000Z'),
  sleeps: [] as string[],
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (options: unknown) => {
    mocks.proxyOptions = options;
    return {
      sendReportDigests: (...args: unknown[]) => {
        mocks.calls.push(args);
        return Promise.resolve(
          mocks.results.shift() ?? { failed: 0, rollupIncomplete: 0, sent: 0, skipped: 0 }
        );
      },
    };
  },
  sleep: async (duration: string) => {
    mocks.sleeps.push(duration);
    mocks.runStartTime = new Date('2026-10-27T00:05:00.000Z');
  },
  workflowInfo: () => ({ runStartTime: mocks.runStartTime }),
}));

import { ScheduledReportDigestWorkflow } from './scheduledReportDigest.js';

beforeEach(() => {
  mocks.results = [];
  mocks.sleeps = [];
  mocks.calls = [];
  mocks.runStartTime = new Date('2026-10-26T23:50:00.000Z');
});

describe('ScheduledReportDigestWorkflow', () => {
  it('sleeps between failed-only delivery passes and stops after success', async () => {
    mocks.results = [
      { failed: 1, rollupIncomplete: 0, sent: 0, skipped: 0 },
      { failed: 0, rollupIncomplete: 0, sent: 1, skipped: 0 },
    ];
    const input = { subscriptionId: 'subscription-1' };

    await expect(ScheduledReportDigestWorkflow(input)).resolves.toEqual({
      failed: 0,
      sent: 1,
      skipped: 0,
    });

    expect(mocks.calls).toEqual([
      [{ ...input, periodStart: new Date('2026-10-19T00:00:00.000Z') }],
      [{ ...input, periodStart: new Date('2026-10-19T00:00:00.000Z') }],
    ]);
    expect(mocks.sleeps).toEqual(['15 minutes']);
  });

  it('anchors a schedule catch-up the next day to the same previous ISO week', async () => {
    mocks.runStartTime = new Date('2026-10-27T08:00:00.000Z');

    await ScheduledReportDigestWorkflow();

    expect(mocks.calls[0]?.[0]).toEqual({
      periodStart: new Date('2026-10-19T00:00:00.000Z'),
    });
  });

  it('retries incomplete rollup coverage for six passes and disables activity retries', async () => {
    mocks.results = [
      ...Array.from({ length: 5 }, () => ({
        failed: 1,
        rollupIncomplete: 1,
        sent: 0,
        skipped: 1,
      })),
      { failed: 0, rollupIncomplete: 0, sent: 1, skipped: 0 },
    ];

    await expect(ScheduledReportDigestWorkflow()).resolves.toEqual({
      failed: 0,
      sent: 1,
      skipped: 5,
    });

    expect(mocks.calls).toHaveLength(6);
    expect(mocks.sleeps).toEqual(Array.from({ length: 5 }, () => '15 minutes'));
    expect(mocks.proxyOptions).toEqual({
      retry: { maximumAttempts: 1 },
      startToCloseTimeout: '30 minutes',
    });
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
