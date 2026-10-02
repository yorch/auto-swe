import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
  },
}));

const currentWorkflowIdMock = vi.fn();
vi.mock('./activityContext.js', () => ({
  currentWorkflowId: () => currentWorkflowIdMock(),
}));

const getModelSpecMock = vi.fn();
vi.mock('./models.js', () => ({ getModelSpec: (...args: unknown[]) => getModelSpecMock(...args) }));

const getModelPriceMock = vi.fn();
vi.mock('./costTracking.js', () => ({
  getModelPrice: (...args: unknown[]) => getModelPriceMock(...args),
}));

import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
import {
  assertModelPricedForUsdCap,
  assertRolePricedForUsdCap,
  isUnpricedModelRefusal,
  MODEL_PRICE_UNAVAILABLE,
  MODEL_UNPRICED,
} from './usdCapGuard.js';

const findLedgerRow = vi.mocked(prisma.activeWorkflow.findFirst);
const findChannel = vi.mocked(prisma.slackChannel.findUnique);

const UNPRICED = 'openrouter/no-price-here';

function ledgerRowWithOrgCap(cents: number | null) {
  return { repository: { team: { organization: { monthlyBudgetUsdCents: cents } } } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkflowIdMock.mockReturnValue('wf-1');
  getModelPriceMock.mockResolvedValue({
    catalogAvailable: true,
    known: false,
    price: {},
    source: 'unknown',
  });
  findLedgerRow.mockResolvedValue(null as never);
  findChannel.mockResolvedValue(null as never);
});

async function refusal(promise: Promise<void>): Promise<ApplicationFailure> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  return err as ApplicationFailure;
}

describe('assertModelPricedForUsdCap', () => {
  it('lets a priced model through without looking up any cap', async () => {
    getModelPriceMock.mockResolvedValue({ known: true, price: {}, source: 'catalog' });
    await assertModelPricedForUsdCap('anthropic/x', { channelCapCents: 500 });
    expect(findLedgerRow).not.toHaveBeenCalled();
    expect(findChannel).not.toHaveBeenCalled();
  });

  it('refuses an unpriced model under an organization USD cap, non-retryable and typed', async () => {
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(100_000));
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED));
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.nonRetryable).toBe(true);
    // Names the model and where to price it.
    expect(err.message).toContain(UNPRICED);
    expect(err.message).toContain('model catalog');
    expect(err.message).toContain('organization');
  });

  it('does not tell the admin to add a price while the catalog is merely unreadable', async () => {
    // Cold worker, first catalog read failed: the price may well exist.
    getModelPriceMock.mockResolvedValue({
      catalogAvailable: false,
      known: false,
      price: {},
      source: 'unknown',
    });
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(100_000));
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED));
    expect(err.type).toBe(MODEL_PRICE_UNAVAILABLE);
    expect(err.nonRetryable).toBe(false);
    expect(err.message).not.toContain('Add the model');
  });

  it('still proceeds on an uncapped path while the catalog is unreadable', async () => {
    getModelPriceMock.mockResolvedValue({
      catalogAvailable: false,
      known: false,
      price: {},
      source: 'unknown',
    });
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(null));
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
  });

  it('refuses under a channel cap the caller already holds', async () => {
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED, { channelCapCents: 500 }));
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain('channel');
    expect(findChannel).not.toHaveBeenCalled();
  });

  it('looks the channel cap up by id when the caller does not hold the row', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: 500 } as never);
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED, { channelId: 'chan-1' }));
    expect(err.type).toBe(MODEL_UNPRICED);
  });

  it('proceeds on an uncapped path: no org cap, no channel cap', async () => {
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(null));
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelCapCents: null })
    ).resolves.toBeUndefined();
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelCapCents: 0 })
    ).resolves.toBeUndefined();
  });

  it('proceeds when there is no ledger row (a channel task never reaches the org ledger)', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelId: 'chan-1' })
    ).resolves.toBeUndefined();
  });

  it('proceeds outside an activity, where there is no run to be capped', async () => {
    currentWorkflowIdMock.mockImplementation(() => {
      throw new Error('outside an activity');
    });
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
  });
});

describe('assertRolePricedForUsdCap', () => {
  it('prices the role the way the ledger will, and refuses under an org cap', async () => {
    getModelSpecMock.mockResolvedValue(UNPRICED);
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(100_000));
    const err = await refusal(assertRolePricedForUsdCap('implementer'));
    expect(getModelSpecMock).toHaveBeenCalledWith('implementer');
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain(UNPRICED);
  });

  it('proceeds under an uncapped organization', async () => {
    getModelSpecMock.mockResolvedValue(UNPRICED);
    findLedgerRow.mockResolvedValue(ledgerRowWithOrgCap(null));
    await expect(assertRolePricedForUsdCap('implementer')).resolves.toBeUndefined();
  });
});

describe('isUnpricedModelRefusal', () => {
  it('finds the refusal anywhere in a cause chain, as an activity failure wraps it', () => {
    const inner = ApplicationFailure.nonRetryable('m', MODEL_UNPRICED);
    const wrapped = new Error('Activity task failed', { cause: inner });
    expect(isUnpricedModelRefusal(wrapped)).toBe(true);
    expect(isUnpricedModelRefusal(ApplicationFailure.nonRetryable('m', 'BUDGET_EXCEEDED'))).toBe(
      false
    );
    expect(isUnpricedModelRefusal('nope')).toBe(false);
  });
});
