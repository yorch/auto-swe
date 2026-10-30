import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activityFailures: 0,
  calls: [] as Array<unknown[]>,
  proxyOptions: [] as unknown[],
  results: [] as Array<{
    failed: number;
    rollupIncomplete?: number;
    sent: number;
    skipped: number;
  }>,
  runStartTime: new Date('2026-10-26T23:50:00.000Z'),
  sleeps: [] as string[],
  workflowInputs: [] as Array<unknown[]>,
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (options: unknown) => {
    mocks.proxyOptions.push(options);
    const maximumAttempts =
      (options as { retry?: { maximumAttempts?: number } }).retry?.maximumAttempts ?? 1;
    return {
      sendReportDigests: async (...args: unknown[]) => {
        for (let attempt = 1; ; attempt++) {
          mocks.workflowInputs.push(args);
          mocks.calls.push(JSON.parse(JSON.stringify(args)) as unknown[]);
          if (mocks.activityFailures > 0) {
            mocks.activityFailures -= 1;
            if (attempt === maximumAttempts) {
              throw new Error('temporary database failure');
            }
            continue;
          }
          return mocks.results.shift() ?? { failed: 0, rollupIncomplete: 0, sent: 0, skipped: 0 };
        }
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
  mocks.activityFailures = 0;
  mocks.results = [];
  mocks.sleeps = [];
  mocks.calls = [];
  mocks.workflowInputs = [];
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
      [{ ...input, periodStart: '2026-10-19' }],
      [{ ...input, periodStart: '2026-10-19' }],
    ]);
    expect(mocks.sleeps).toEqual(['15 minutes']);
  });

  it('anchors a schedule catch-up the next day to the same previous ISO week', async () => {
    mocks.runStartTime = new Date('2026-10-27T08:00:00.000Z');

    await ScheduledReportDigestWorkflow();

    expect(mocks.calls[0]?.[0]).toEqual({
      periodStart: '2026-10-19',
    });
  });

  it('passes a JSON-round-tripped ISO period string to the activity', async () => {
    await ScheduledReportDigestWorkflow();

    expect(mocks.workflowInputs[0]?.[0]).toEqual({ periodStart: '2026-10-19' });
    const activityInput = mocks.calls[0]?.[0] as { periodStart: unknown };
    expect(activityInput.periodStart).toBe('2026-10-19');
    expect(typeof activityInput.periodStart).toBe('string');
  });

  it('retries activity failures without changing the anchored ISO-week period', async () => {
    mocks.activityFailures = 1;
    mocks.results = [{ failed: 0, rollupIncomplete: 0, sent: 1, skipped: 0 }];

    await expect(ScheduledReportDigestWorkflow()).resolves.toEqual({
      failed: 0,
      sent: 1,
      skipped: 0,
    });

    expect(mocks.calls).toEqual([[{ periodStart: '2026-10-19' }], [{ periodStart: '2026-10-19' }]]);
    expect(mocks.proxyOptions[0]).toEqual({
      retry: {
        backoffCoefficient: 2,
        initialInterval: '5s',
        maximumAttempts: 3,
        maximumInterval: '30s',
      },
      startToCloseTimeout: '30 minutes',
    });
  });

  it('retries incomplete rollup coverage for six workflow passes with a bounded activity policy', async () => {
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
    expect(mocks.proxyOptions[0]).toEqual({
      retry: {
        backoffCoefficient: 2,
        initialInterval: '5s',
        maximumAttempts: 3,
        maximumInterval: '30s',
      },
      startToCloseTimeout: '30 minutes',
    });
    expect(mocks.proxyOptions[1]).toEqual({
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

    mocks.calls = [];
    mocks.activityFailures = 1;
    await expect(ScheduledReportDigestWorkflow({ sendTest: true })).rejects.toThrow(
      'temporary database failure'
    );
    expect(mocks.calls).toHaveLength(1);
  });
});
