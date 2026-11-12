import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    team: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

const teamMonthSpendMock = vi.fn();
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/billing')>()),
  teamMonthSpend: (...a: unknown[]) => teamMonthSpendMock(...a),
}));

const currentSpendOwnerMock = vi.fn();
vi.mock('./spendOwner.js', () => ({ currentSpendOwner: () => currentSpendOwnerMock() }));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));
const evaluateNoticeMock = vi.fn();
vi.mock('./teamBudgetNotice.js', () => ({
  evaluateTeamBudgetNotice: (...a: unknown[]) => evaluateNoticeMock(...a),
}));

import { prisma } from '@auto-swe/shared/db';
import { assertTeamBudgetAvailable, resolveBilledTeam } from './teamBudgetGuard.js';

const findLedger = vi.mocked(prisma.activeWorkflow.findFirst);
const findRun = vi.mocked(prisma.workflowRun.findUnique);
const findTeam = vi.mocked(prisma.team.findUnique);

const spend = (totalUsd: number) => ({
  finalizedUsd: totalUsd,
  inFlightUsd: 0,
  runlessUsd: 0,
  totalUsd,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetConfigCacheForTests();
  findRun.mockResolvedValue({ attributedTeamId: 'team-1' } as never);
  findLedger.mockResolvedValue({ repository: { teamId: 'team-1' } } as never);
  findTeam.mockResolvedValue({ monthlyBudgetUsdCents: 1000 } as never);
  teamMonthSpendMock.mockResolvedValue(spend(1));
  currentSpendOwnerMock.mockResolvedValue({});
});

describe('resolveBilledTeam', () => {
  it("is the run's attributed team, else the ledger repository's owner", async () => {
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: 'team-1' });
    findRun.mockResolvedValue(null as never);
    findLedger.mockResolvedValue({ repository: { teamId: 'owner' } } as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: 'owner' });
  });

  it('names the team a connection-less launch was held to before the run row exists', async () => {
    findRun.mockResolvedValue(null as never);
    findLedger.mockResolvedValue({
      repository: null,
      workRequest: { billingTeamId: 'launcher' },
    } as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: 'launcher' });
    // A repository places the run before the stamp does.
    findLedger.mockResolvedValue({
      repository: { teamId: 'owner' },
      workRequest: { billingTeamId: 'launcher' },
    } as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: 'owner' });
  });

  it("does not borrow the ledger repository's team for a run attributed to none", async () => {
    // `teamMonthSpend` counts the run in no team, so the guard caps it by none either.
    findRun.mockResolvedValue({ attributedTeamId: null } as never);
    findLedger.mockResolvedValue({ repository: { teamId: 'owner' } } as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: null });
  });

  it('is unstable with neither row, and stably none for an unattributed run', async () => {
    findRun.mockResolvedValue(null as never);
    findLedger.mockResolvedValue(null as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: false, teamId: null });
    findRun.mockResolvedValue({ attributedTeamId: null } as never);
    expect(await resolveBilledTeam('wf')).toEqual({ stable: true, teamId: null });
  });
});

describe('assertTeamBudgetAvailable', () => {
  it('lets a call through under the cap', async () => {
    await expect(assertTeamBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });

  it('refuses non-retryably at the cap, naming no amount', async () => {
    teamMonthSpendMock.mockResolvedValue(spend(10));
    const err = (await assertTeamBudgetAvailable('wf-1', 'agent.x').catch((e) => e)) as unknown;
    expect(err).toBeInstanceOf(ApplicationFailure);
    const failure = err as ApplicationFailure;
    expect(failure.type).toBe('BUDGET_EXCEEDED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).not.toMatch(/\d/);
    expect(failure.details?.[0]).toMatchObject({ cap: 'team', teamId: 'team-1' });
  });

  it('refuses under a zero cap whatever has been spent', async () => {
    findTeam.mockResolvedValue({ monthlyBudgetUsdCents: 0 } as never);
    teamMonthSpendMock.mockResolvedValue(spend(0));
    await expect(assertTeamBudgetAvailable('wf-1', 'agent.x')).rejects.toBeInstanceOf(
      ApplicationFailure
    );
  });

  it('does not read spend for a team with no cap', async () => {
    findTeam.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await assertTeamBudgetAvailable('wf-1', 'agent.x');
    expect(teamMonthSpendMock).not.toHaveBeenCalled();
  });

  it('does nothing for a run no team is attributed', async () => {
    findRun.mockResolvedValue({ attributedTeamId: null } as never);
    findLedger.mockResolvedValue(null as never);
    await assertTeamBudgetAvailable('wf-1', 'agent.x');
    expect(findTeam).not.toHaveBeenCalled();
  });

  it("counts a runless workflow against its activity's declared spend owner", async () => {
    findRun.mockResolvedValue(null as never);
    findLedger.mockResolvedValue(null as never);
    currentSpendOwnerMock.mockResolvedValue({ teamId: 'team-9' });
    teamMonthSpendMock.mockResolvedValue(spend(10));
    await expect(assertTeamBudgetAvailable('wf-1', 'agent.x')).rejects.toBeInstanceOf(
      ApplicationFailure
    );
    expect(findTeam).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'team-9' } }));
  });

  it('fails open when the team cannot be read', async () => {
    findTeam.mockRejectedValue(new Error('db down'));
    await expect(assertTeamBudgetAvailable('wf-1', 'agent.x')).resolves.toBeUndefined();
  });
});

describe('assertTeamBudgetAvailable budget notice', () => {
  it('evaluates the notice once per cache window with the settled spend', async () => {
    teamMonthSpendMock.mockResolvedValue(spend(7));
    await assertTeamBudgetAvailable('wf-1', 'agent.x');
    await assertTeamBudgetAvailable('wf-1', 'agent.x');
    expect(evaluateNoticeMock).toHaveBeenCalledTimes(1);
    expect(evaluateNoticeMock).toHaveBeenCalledWith('team-1', 7);
  });

  it('does not evaluate for a team with no cap', async () => {
    findTeam.mockResolvedValue({ monthlyBudgetUsdCents: null } as never);
    await assertTeamBudgetAvailable('wf-1', 'agent.x');
    expect(evaluateNoticeMock).not.toHaveBeenCalled();
  });

  it('still blocks at the cap while the notice evaluation is pending', async () => {
    evaluateNoticeMock.mockReturnValue(new Promise(() => undefined));
    teamMonthSpendMock.mockResolvedValue(spend(10));
    await expect(assertTeamBudgetAvailable('wf-1', 'agent.x')).rejects.toBeInstanceOf(
      ApplicationFailure
    );
  });
});
