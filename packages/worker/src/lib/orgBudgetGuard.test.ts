import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

const orgMonthSpendMock = vi.fn();
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/billing')>()),
  orgMonthSpend: (...a: unknown[]) => orgMonthSpendMock(...a),
}));

const currentSpendOwnerMock = vi.fn();
vi.mock('./spendOwner.js', () => ({ currentSpendOwner: () => currentSpendOwnerMock() }));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import { prisma } from '@auto-swe/shared/db';
import { assertOrgBudgetAvailable } from './orgBudgetGuard.js';

const findLedger = vi.mocked(prisma.activeWorkflow.findFirst);
const findRun = vi.mocked(prisma.workflowRun.findUnique);
const findOrg = vi.mocked(prisma.organization.findUnique);

const spend = (totalUsd: number) => ({
  finalizedUsd: totalUsd,
  inFlightUsd: 0,
  runlessUsd: 0,
  totalUsd,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  _resetConfigCacheForTests();
  // An engineering run: a ledger row naming a repository, and a run with no connection of its own.
  findLedger.mockResolvedValue({ repository: { team: { orgId: 'org-1' } } } as never);
  findRun.mockResolvedValue({
    connection: null,
    workRequest: { connection: null, connectionId: null },
  } as never);
  findOrg.mockResolvedValue({ monthlyBudgetUsdCents: 1000 } as never);
  orgMonthSpendMock.mockResolvedValue(spend(1));
  currentSpendOwnerMock.mockResolvedValue({});
});

async function refusal(p: Promise<void>): Promise<ApplicationFailure> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  return err as ApplicationFailure;
}

describe('assertOrgBudgetAvailable', () => {
  it('lets a call through while the org is under its cap', async () => {
    await expect(assertOrgBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });

  it('refuses the next call with a non-retryable BUDGET_EXCEEDED once spend reaches the cap', async () => {
    orgMonthSpendMock.mockResolvedValue(spend(10)); // 1000 cents == the cap
    const err = await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
    expect(err.type).toBe('BUDGET_EXCEEDED');
    expect(err.nonRetryable).toBe(true);
    expect(err.details?.[0]).toMatchObject({ cap: 'organization', capCents: 1000, orgId: 'org-1' });
  });

  it('does not read spend for an org with no cap', async () => {
    findOrg.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await assertOrgBudgetAvailable('wf-1', 'agent.x');
    expect(orgMonthSpendMock).not.toHaveBeenCalled();
  });

  it('reads spend once per window however many calls ask', async () => {
    for (let i = 0; i < 5; i++) {
      await assertOrgBudgetAvailable('wf-1', 'agent.x');
    }
    expect(orgMonthSpendMock).toHaveBeenCalledTimes(1);
  });

  it('stops refusing within one window of the cap being raised', async () => {
    vi.useFakeTimers();
    orgMonthSpendMock.mockResolvedValue(spend(10));
    await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
    // Still refused from the cache, inside the window.
    await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
    findOrg.mockResolvedValue({ monthlyBudgetUsdCents: 5000 } as never);
    vi.advanceTimersByTime(31_000);
    await expect(assertOrgBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });

  it('fails open when the spend cannot be read', async () => {
    orgMonthSpendMock.mockRejectedValue(new Error('db down'));
    await expect(assertOrgBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });

  const request = (orgId: string | null) =>
    ({
      connection: null,
      workRequest: {
        connection: orgId ? { team: { orgId } } : null,
        connectionId: orgId ? 'c' : null,
      },
    }) as never;

  it('caps a PRD run or a code-route channel task: no ledger, billed through the request connection', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(request('org-1'));
    orgMonthSpendMock.mockResolvedValue(spend(10));
    const err = await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
    expect(err.details?.[0]).toMatchObject({ cap: 'organization', orgId: 'org-1' });
  });

  it('prefers the request connection to the ledger repository, as billing does', async () => {
    findRun.mockResolvedValue(request('org-2'));
    await assertOrgBudgetAvailable('wf-1', 'agent.x');
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-2' } }));
  });

  it('caps an epic child through its own run connection', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue({
      connection: { team: { orgId: 'org-1' } },
      workRequest: { connection: null, connectionId: null },
    } as never);
    orgMonthSpendMock.mockResolvedValue(spend(10));
    await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
  });

  it("prefers the request's connection to the run's own, when the two differ", async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue({
      connection: { team: { orgId: 'org-run' } },
      workRequest: { connection: { team: { orgId: 'org-request' } }, connectionId: 'c' },
    } as never);
    await assertOrgBudgetAvailable('wf-1', 'agent.x');
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-request' } }));
  });

  it("never uses the run's connection when the request named one whose team has no org", async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue({
      connection: { team: { orgId: 'org-run' } },
      workRequest: { connection: { team: { orgId: null } }, connectionId: 'c' },
    } as never);
    currentSpendOwnerMock.mockResolvedValue({});
    await assertOrgBudgetAvailable('wf-1', 'agent.x');
    expect(findOrg).not.toHaveBeenCalled();

    // The ledger row's repository is the one remaining place it can be billed to.
    _resetConfigCacheForTests();
    findLedger.mockResolvedValue({ repository: { team: { orgId: 'org-ledger' } } } as never);
    await assertOrgBudgetAvailable('wf-1', 'agent.x');
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-ledger' } }));
  });

  it('does not cap a repo-less channel task: a run that resolves to no org', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(request(null));
    currentSpendOwnerMock.mockResolvedValue({ orgId: 'org-1' });
    orgMonthSpendMock.mockResolvedValue(spend(10));
    await expect(assertOrgBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });

  it('resolves a run-backed workflow once per window, org or none', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(request(null));
    for (let i = 0; i < 4; i++) {
      await assertOrgBudgetAvailable('wf-1', 'agent.x');
    }
    expect(findRun).toHaveBeenCalledTimes(1);
    expect(findLedger).toHaveBeenCalledTimes(1);
  });

  it('does not share a spend owner between concurrent activities of one workflow', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(null as never);
    currentSpendOwnerMock.mockResolvedValueOnce({ orgId: 'org-a' });
    currentSpendOwnerMock.mockResolvedValueOnce({ orgId: 'org-b' });
    await Promise.all([
      assertOrgBudgetAvailable('wf-1', 'agent.x'),
      assertOrgBudgetAvailable('wf-1', 'agent.x'),
    ]);
    const ids = findOrg.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id).sort();
    expect(ids).toEqual(['org-a', 'org-b']);
  });

  it('caps a runless workflow through its spend owner', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(null as never);
    currentSpendOwnerMock.mockResolvedValue({ orgId: 'org-1' });
    orgMonthSpendMock.mockResolvedValue(spend(10));
    const err = await refusal(assertOrgBudgetAvailable('wf-1', 'agent.x'));
    expect(err.type).toBe('BUDGET_EXCEEDED');
  });

  it('does not cap a workflow with no owner at all', async () => {
    findLedger.mockResolvedValue(null as never);
    findRun.mockResolvedValue(null as never);
    orgMonthSpendMock.mockResolvedValue(spend(10));
    await expect(assertOrgBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
    expect(findOrg).not.toHaveBeenCalled();
  });
});
