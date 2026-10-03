import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string, details?: unknown) => {
      const err = new Error(message) as Error & { type?: string; details?: unknown };
      err.type = type;
      err.details = details;
      return err;
    },
  },
  log: { warn: vi.fn() },
}));

const gate = vi.hoisted(() => ({
  value: { mode: 'off', staleAfterHours: 72 } as { mode: string; staleAfterHours: number } | null,
}));
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: async () => gate.value,
}));

// Org spend is `orgMonthSpend` (tested in shared/src/lib/billing.test.ts); here
// it reports the mock's `orgMonthlyUsage` row plus whatever is in flight.
const spend = vi.hoisted(() => ({ inFlightUsd: 0 }));
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orgMonthSpend: async (
    db: { orgMonthlyUsage: { findUnique: () => Promise<{ costUsdAccrued: number } | null> } },
    _orgId: string
  ) => {
    const finalizedUsd = Number((await db.orgMonthlyUsage.findUnique())?.costUsdAccrued ?? 0);
    return {
      finalizedUsd,
      inFlightUsd: spend.inFlightUsd,
      runlessUsd: 0,
      totalUsd: finalizedUsd + spend.inFlightUsd,
    };
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    configAuditLog: { create: vi.fn(), findFirst: vi.fn() },
    connection: { findUnique: vi.fn() },
    organizationMembership: { findUnique: vi.fn() },
    orgMonthlyUsage: { findUnique: vi.fn() },
    scheduledWorkRequest: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import {
  assertScheduledFireAuthorized,
  SCHEDULED_FIRE_REFUSED,
  scheduledFireRefusal,
} from './scheduledFireAuthorization.js';

// biome-ignore lint/suspicious/noExplicitAny: terse access to the mocked prisma client in tests.
const db = prisma as any;

const SCHEDULE_ID = 'sched-row-1';
const OWNER = 'user-owner';
const FIRE = { workflowId: `sched-${SCHEDULE_ID}-2026-09-24T14:00:00Z`, workRequestId: 'wr-1' };

// A fire of a schedule that runs as `user-acting`: Temporal's stored arguments carry that launcher.
const ACTING_FIRE = { ...FIRE, launchedById: 'user-acting' };

type Person = { id: string; isActive: boolean; role: string };

function schedule(owner: Person | null = null, actsAsUser: Person | null = null) {
  return {
    actsAsUser,
    createdBy: owner ?? { id: OWNER, isActive: true, role: 'LEAD' },
    id: SCHEDULE_ID,
    isActive: true,
    repoId: 'repo-1',
    teamId: 'team-1',
  };
}

function repo(
  overrides: {
    isActive?: boolean;
    members?: string[];
    installationActive?: boolean;
    cap?: number | null;
  } = {}
) {
  return {
    githubApiUrl: null,
    id: 'repo-1',
    installation:
      overrides.installationActive === undefined
        ? null
        : { installationId: '42', isActive: overrides.installationActive },
    isActive: overrides.isActive ?? true,
    organizationName: 'acme',
    repoName: 'payments',
    shares: [],
    team: {
      memberships: (overrides.members ?? [OWNER]).map((userId) => ({ userId })),
      organization: { monthlyBudgetUsdCents: overrides.cap ?? null },
      orgId: 'org-1',
    },
    teamId: 'team-1',
    type: 'git_repo',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  gate.value = { mode: 'off', staleAfterHours: 72 };
  db.scheduledWorkRequest.findFirst.mockResolvedValue(schedule());
  db.connection.findUnique.mockResolvedValue(repo());
  db.organizationMembership.findUnique.mockResolvedValue({ orgId: 'org-1', userId: OWNER });
  db.orgMonthlyUsage.findUnique.mockResolvedValue(null);
  db.configAuditLog.findFirst.mockResolvedValue(null);
  db.configAuditLog.create.mockResolvedValue({});
});

describe('scheduledFireRefusal', () => {
  it('lets an owner who still has access fire', async () => {
    expect(await scheduledFireRefusal(db, FIRE)).toBeNull();
  });

  it('is a no-op for a run that is not a scheduled fire', async () => {
    expect(
      await scheduledFireRefusal(db, { workflowId: 'eng-acme-api-T-1', workRequestId: 'wr-1' })
    ).toBeNull();
    expect(await scheduledFireRefusal(db, { workflowId: FIRE.workflowId })).toBeNull();
    expect(db.scheduledWorkRequest.findFirst).not.toHaveBeenCalled();
  });

  it('is a no-op when the standing request belongs to a different schedule’s id', async () => {
    // Something else reusing a schedule's standing request was authorized by
    // whoever started it, not by this schedule's owner.
    expect(
      await scheduledFireRefusal(db, { workflowId: 'sched-other-row-1', workRequestId: 'wr-1' })
    ).toBeNull();
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(null);
    expect(await scheduledFireRefusal(db, FIRE)).toBeNull();
  });

  it('refuses a fire whose schedule row is gone but whose Temporal schedule lived on', async () => {
    const orphanId = '0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(null);
    expect(
      await scheduledFireRefusal(db, {
        workflowId: `sched-${orphanId}-2026-09-24T14:00:00Z`,
        workRequestId: 'wr-1',
      })
    ).toMatchObject({ reason: 'schedule-missing', scheduleId: orphanId });
  });

  it('refuses when the schedule team no longer owns or shares the repository', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce({
      ...schedule(),
      teamId: 'team-unshared',
    });
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'schedule-team-unclaimed',
    });
  });

  it('refuses a schedule whose team was deleted (null teamId)', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce({ ...schedule(), teamId: null });
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'schedule-team-unclaimed',
    });
  });

  it('lets a schedule owned by a team the repository is currently shared with fire', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce({
      ...schedule(),
      teamId: 'team-sharer',
    });
    db.connection.findUnique.mockResolvedValueOnce({
      ...repo(),
      shares: [{ team: { memberships: [{ userId: OWNER }] }, teamId: 'team-sharer' }],
    });
    expect(await scheduledFireRefusal(db, FIRE)).toBeNull();
  });

  it('refuses when the owner was deleted or deactivated', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce({ ...schedule(), createdBy: null });
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'acting-user-missing' });
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(
      schedule({ id: OWNER, isActive: false, role: 'LEAD' })
    );
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'acting-user-missing' });
  });

  it('checks the acting user, not the creator, when the schedule runs as someone', async () => {
    const actsAs = { id: 'user-acting', isActive: true, role: 'LEAD' };
    // The creator is still a member; the acting user is not.
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(schedule(null, actsAs));
    expect(await scheduledFireRefusal(db, ACTING_FIRE)).toMatchObject({
      reason: 'not-a-team-member',
    });

    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(schedule(null, actsAs));
    db.connection.findUnique.mockResolvedValueOnce(repo({ members: ['user-acting'] }));
    db.organizationMembership.findUnique.mockResolvedValueOnce({ orgId: 'org-1' });
    expect(await scheduledFireRefusal(db, ACTING_FIRE)).toBeNull();
  });

  it('refuses when the acting user was deactivated, even if the creator is fine', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(
      schedule(null, { id: 'user-acting', isActive: false, role: 'LEAD' })
    );
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'acting-user-missing' });
  });

  it('refuses when the Temporal arguments name a different launcher than the row', async () => {
    const actsAs = { id: 'user-acting', isActive: true, role: 'LEAD' };
    // Row says user-acting, Temporal still holds the firer of a failed takeover.
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(schedule(null, actsAs));
    expect(await scheduledFireRefusal(db, { ...FIRE, launchedById: 'user-firer' })).toMatchObject({
      reason: 'launcher-out-of-sync',
      scheduleId: SCHEDULE_ID,
    });
    // Row says user-acting, Temporal carries no launcher.
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(schedule(null, actsAs));
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'launcher-out-of-sync' });
    // Row has no acting user (legacy), Temporal still names one.
    expect(await scheduledFireRefusal(db, { ...FIRE, launchedById: 'user-firer' })).toMatchObject({
      reason: 'launcher-out-of-sync',
    });
  });

  it('refuses a fire of a schedule whose row is inactive', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce({ ...schedule(), isActive: false });
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'schedule-inactive' });
  });

  it('refuses when the owner has left the repository’s team', async () => {
    db.connection.findUnique.mockResolvedValueOnce(repo({ members: [] }));
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'not-a-team-member',
      scheduleId: SCHEDULE_ID,
    });
  });

  it('refuses a fire through a retired installation, even for an ADMIN owner', async () => {
    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(
      schedule({ id: OWNER, isActive: true, role: 'ADMIN' })
    );
    db.connection.findUnique.mockResolvedValueOnce(repo({ installationActive: false }));
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'installation-retired',
    });
  });

  it('refuses when the repository was deactivated', async () => {
    db.connection.findUnique.mockResolvedValueOnce(repo({ isActive: false }));
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'repository-inactive',
    });
  });

  it('refuses when the owner is no longer an org member (ADMIN owners bypass)', async () => {
    db.organizationMembership.findUnique.mockResolvedValueOnce(null);
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'not-an-org-member' });

    db.scheduledWorkRequest.findFirst.mockResolvedValueOnce(
      schedule({ id: OWNER, isActive: true, role: 'ADMIN' })
    );
    db.organizationMembership.findUnique.mockResolvedValueOnce(null);
    expect(await scheduledFireRefusal(db, FIRE)).toBeNull();
  });

  it('refuses when the org is at or over its monthly cap', async () => {
    db.connection.findUnique.mockResolvedValue(repo({ cap: 500 }));
    db.orgMonthlyUsage.findUnique.mockResolvedValueOnce({ costUsdAccrued: 5 });
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
      reason: 'org-budget-exceeded',
    });
    db.orgMonthlyUsage.findUnique.mockResolvedValueOnce({ costUsdAccrued: 4.99 });
    expect(await scheduledFireRefusal(db, FIRE)).toBeNull();
  });

  it('counts the spend of runs still in flight toward the cap', async () => {
    db.connection.findUnique.mockResolvedValue(repo({ cap: 500 }));
    db.orgMonthlyUsage.findUnique.mockResolvedValueOnce({ costUsdAccrued: 3 });
    spend.inFlightUsd = 2;
    try {
      expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({
        reason: 'org-budget-exceeded',
      });
    } finally {
      spend.inFlightUsd = 0;
    }
  });

  it('fails closed when the access policy has never been readable', async () => {
    gate.value = null;
    expect(await scheduledFireRefusal(db, FIRE)).toMatchObject({ reason: 'gate-unreadable' });
  });
});

describe('assertScheduledFireAuthorized', () => {
  it('resolves for an authorized fire and writes nothing', async () => {
    await expect(assertScheduledFireAuthorized(FIRE)).resolves.toBeUndefined();
    expect(db.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('throws a non-retryable failure and audits the refusal against the schedule', async () => {
    db.connection.findUnique.mockResolvedValueOnce(repo({ members: [] }));
    const err = (await assertScheduledFireAuthorized(FIRE).catch((e) => e)) as Error & {
      type?: string;
      details?: unknown;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.type).toBe(SCHEDULED_FIRE_REFUSED);
    expect(err.details).toEqual({ reason: 'not-a-team-member', scheduleId: SCHEDULE_ID });
    expect(db.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: expect.objectContaining({
          event: 'fire-refused',
          reason: 'not-a-team-member',
          workflowId: FIRE.workflowId,
        }),
        entityId: SCHEDULE_ID,
        entityType: 'ScheduledWorkRequest',
      }),
    });
  });

  it('does not re-audit the same refusal within the hour, but still refuses', async () => {
    db.connection.findUnique.mockResolvedValueOnce(repo({ members: [] }));
    db.configAuditLog.findFirst.mockResolvedValueOnce({ id: 'audit-1' });
    await expect(assertScheduledFireAuthorized(FIRE)).rejects.toThrow(/scheduled fire refused/);
    expect(db.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('still refuses when the audit write fails', async () => {
    db.connection.findUnique.mockResolvedValueOnce(repo({ members: [] }));
    db.configAuditLog.create.mockRejectedValueOnce(new Error('pool exhausted'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(assertScheduledFireAuthorized(FIRE)).rejects.toThrow(/scheduled fire refused/);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
