import { describe, expect, it } from 'vitest';
import { type CampaignSpendClient, campaignMonthStart, campaignSpendUsd } from './campaignSpend.js';

type Attempt = Awaited<ReturnType<CampaignSpendClient['campaignAttempt']['findMany']>>[number];

function fake(attempts: Attempt[], ledger: Record<string, number>): CampaignSpendClient {
  return {
    activeWorkflow: {
      findMany: async (args) =>
        args.where.temporalWorkflowId.in
          .filter((id) => id in ledger)
          .map((id) => ({ costUsdAccrued: ledger[id], temporalWorkflowId: id })),
    },
    campaignAttempt: { findMany: async () => attempts },
  };
}

const input = { campaignId: 'c', monthStart: campaignMonthStart(new Date()), orgId: 'o' };
const ended = new Date();

describe('campaignSpendUsd', () => {
  it('counts an attempt with live-ledger cost and no run row', async () => {
    const client = fake([{ childWorkflowId: 'wf-1', run: null }], { 'wf-1': 3 });
    expect(await campaignSpendUsd(client, input)).toBe(3);
  });

  it('counts a finalized attempt once, from its run, though both ledgers hold it', async () => {
    const client = fake([{ childWorkflowId: 'wf-2', run: { costUsdAccrued: 4, endedAt: ended } }], {
      'wf-2': 4,
    });
    expect(await campaignSpendUsd(client, input)).toBe(4);
  });

  it('counts a running attempt from the live ledger, not its unfinalized run figure of 0', async () => {
    const client = fake([{ childWorkflowId: 'wf-3', run: { costUsdAccrued: 0, endedAt: null } }], {
      'wf-3': 2.5,
    });
    expect(await campaignSpendUsd(client, input)).toBe(2.5);
  });

  it('falls back to the run when no ledger row exists, and sums every attempt', async () => {
    const client = fake(
      [
        { childWorkflowId: null, run: { costUsdAccrued: 1, endedAt: ended } },
        { childWorkflowId: 'wf-1', run: null },
        { childWorkflowId: 'wf-4', run: { costUsdAccrued: 0.5, endedAt: null } },
      ],
      { 'wf-1': 3 }
    );
    expect(await campaignSpendUsd(client, input)).toBe(4.5);
  });

  it('is 0 for a campaign with no attempts', async () => {
    expect(await campaignSpendUsd(fake([], {}), input)).toBe(0);
  });
});

describe('campaignMonthStart', () => {
  it('is the first instant of the UTC month', () => {
    expect(campaignMonthStart(new Date('2026-11-25T23:59:59Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z'
    );
  });
});
