import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    slackChannel: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

const currentSpendOwnerMock = vi.fn();
vi.mock('./spendOwner.js', () => ({ currentSpendOwner: () => currentSpendOwnerMock() }));

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
  isSpendRefusal,
  isUnpricedModelRefusal,
  MODEL_PRICE_UNAVAILABLE,
  MODEL_UNPRICED,
} from './usdCapGuard.js';

const findLedgerRow = vi.mocked(prisma.activeWorkflow.findFirst);
const findChannel = vi.mocked(prisma.slackChannel.findUnique);
const findRun = vi.mocked(prisma.workflowRun.findUnique);
const findOrg = vi.mocked(prisma.organization.findUnique);

const UNPRICED = 'openrouter/no-price-here';

/** A ledger row whose repository's team is in org-1; the cap itself is `findOrg`'s. */
function ledgerRowInOrg(orgId: string | null = 'org-1') {
  return { repository: { team: { orgId } } } as never;
}

/** A run whose work request names a connection placing it in `orgId` (a PRD run, a code-route channel task). */
function runViaRequestConnection(orgId: string | null = 'org-1') {
  return {
    connection: null,
    connectionId: null,
    id: 'run-1',
    workRequest: { connection: { team: { orgId } }, connectionId: 'conn-1' },
  } as never;
}

function capOrg(cents: number | null) {
  findOrg.mockResolvedValue({ monthlyBudgetUsdCents: cents } as never);
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
  // A run no connection or repository places anywhere unless a test says otherwise.
  findRun.mockResolvedValue({ id: 'run-1', workRequest: null } as never);
  findOrg.mockResolvedValue(null as never);
  currentSpendOwnerMock.mockResolvedValue({});
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
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(100_000);
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
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(100_000);
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
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(null);
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
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(null);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelCapCents: null })
    ).resolves.toBeUndefined();
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelCapCents: 0 })
    ).resolves.toBeUndefined();
  });

  it('proceeds for a channel task whose channel has no cap and whose run no org bills', async () => {
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await expect(
      assertModelPricedForUsdCap(UNPRICED, { channelId: 'chan-1' })
    ).resolves.toBeUndefined();
    expect(findOrg).not.toHaveBeenCalled();
  });

  it('refuses a PRD-shaped run (no ledger row, request connection in a capped org)', async () => {
    findRun.mockResolvedValue(runViaRequestConnection());
    capOrg(100_000);
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED));
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain('organization');
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-1' } }));
  });

  it('refuses a code-route channel task billed through its connection, with no channel cap', async () => {
    findRun.mockResolvedValue(runViaRequestConnection());
    findChannel.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    capOrg(100_000);
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED, { channelId: 'chan-1' }));
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain('organization');
  });

  it('proceeds for a connection-placed run whose org has no cap, or whose team has no org', async () => {
    findRun.mockResolvedValue(runViaRequestConnection());
    capOrg(null);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    findOrg.mockClear();
    findRun.mockResolvedValue(runViaRequestConnection(null));
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    expect(findOrg).not.toHaveBeenCalled();
  });

  it('lets the request connection decide over the ledger row, as billing does', async () => {
    findRun.mockResolvedValue(runViaRequestConnection(null));
    findLedgerRow.mockResolvedValue(ledgerRowInOrg('org-2'));
    capOrg(100_000);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    expect(findOrg).not.toHaveBeenCalled();
  });

  it('refuses a runless call whose spend owner is an organization with a USD cap', async () => {
    // Runless spend counts toward the org cap through the owner on its trace rows.
    findRun.mockResolvedValue(null as never);
    currentSpendOwnerMock.mockResolvedValue({ orgId: 'org-1', teamId: 'team-1' });
    findOrg.mockResolvedValue({ monthlyBudgetUsdCents: 100_000 } as never);
    const err = await refusal(assertModelPricedForUsdCap(UNPRICED));
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain('organization');
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-1' } }));
  });

  it('proceeds for a runless call whose owner has no org, or an uncapped one', async () => {
    findRun.mockResolvedValue(null as never);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    expect(findOrg).not.toHaveBeenCalled();
    currentSpendOwnerMock.mockResolvedValue({ orgId: 'org-1' });
    findOrg.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
  });

  it('does not consult the spend owner for a run that exists', async () => {
    currentSpendOwnerMock.mockResolvedValue({ orgId: 'org-1' });
    capOrg(100_000);
    await expect(assertModelPricedForUsdCap(UNPRICED)).resolves.toBeUndefined();
    expect(currentSpendOwnerMock).not.toHaveBeenCalled();
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
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(100_000);
    const err = await refusal(assertRolePricedForUsdCap('implementer'));
    expect(getModelSpecMock).toHaveBeenCalledWith('implementer');
    expect(err.type).toBe(MODEL_UNPRICED);
    expect(err.message).toContain(UNPRICED);
  });

  it('proceeds under an uncapped organization', async () => {
    getModelSpecMock.mockResolvedValue(UNPRICED);
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(null);
    await expect(assertRolePricedForUsdCap('implementer')).resolves.toBeUndefined();
  });
});

describe('assertRolePricedForUsdCap with a bound spec', () => {
  it('prices the spec it is given and does not re-resolve the role', async () => {
    getModelSpecMock.mockResolvedValue('openrouter/other-model');
    findLedgerRow.mockResolvedValue(ledgerRowInOrg());
    capOrg(100_000);
    const err = await refusal(assertRolePricedForUsdCap('implementer', UNPRICED));
    expect(getModelSpecMock).not.toHaveBeenCalled();
    expect(err.message).toContain(UNPRICED);
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

describe('isSpendRefusal', () => {
  it.each(['MODEL_UNPRICED', 'MODEL_PRICE_UNAVAILABLE', 'BUDGET_EXCEEDED'])(
    'recognises a %s refusal, also when wrapped',
    (type) => {
      const refusal = Object.assign(new Error('refused'), { type });
      expect(isSpendRefusal(refusal)).toBe(true);
      expect(isSpendRefusal(new Error('wrapped', { cause: refusal }))).toBe(true);
    }
  );

  it('does not treat an ordinary failure as a refusal', () => {
    expect(isSpendRefusal(new Error('no structured output'))).toBe(false);
    expect(isSpendRefusal('nope')).toBe(false);
  });
});
