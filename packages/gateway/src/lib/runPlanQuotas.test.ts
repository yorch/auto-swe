import { describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSettings: vi.fn(async () => ({
    'runPlans.createPerUserPerHour': 10,
    'runPlans.enabled': true,
    'runPlans.maxPendingPerUser': 5,
  })),
}));

import {
  GENERATION_STARTED,
  limitScopes,
  MAX_LIMIT_SCOPES,
  reserveGenerationSlot,
} from './runPlanQuotas.js';

const reader = (teams: Array<{ id: string; orgId: string }>, orgs: Array<{ orgId: string }> = []) =>
  ({
    organizationMembership: { findMany: async () => orgs },
    teamMembership: { findMany: async () => teams.map((team) => ({ team })) },
  }) as never;

describe('limitScopes', () => {
  it('puts the repository’s scope first, then teams, then organizations, without repeats', async () => {
    const scopes = await limitScopes(
      reader(
        [
          { id: 'team-1', orgId: 'org-1' },
          { id: 'team-2', orgId: 'org-1' },
        ],
        [{ orgId: 'org-1' }, { orgId: 'org-9' }]
      ),
      'user-1',
      { orgId: 'org-1', teamId: 'team-1' }
    );
    expect(scopes).toEqual([
      { orgId: 'org-1', teamId: 'team-1' },
      { orgId: 'org-1', teamId: 'team-2' },
      { orgId: 'org-9', teamId: null },
    ]);
  });

  it('keeps the repository’s scope even when the person is not a member of its team', async () => {
    const scopes = await limitScopes(reader([]), 'user-1', { orgId: 'org-1', teamId: 'team-x' });
    expect(scopes).toEqual([{ orgId: 'org-1', teamId: 'team-x' }]);
  });

  it('considers at most 50 scopes', async () => {
    const teams = Array.from({ length: 80 }, (_, i) => ({
      id: `team-${String(i).padStart(3, '0')}`,
      orgId: 'org-1',
    }));
    const scopes = await limitScopes(reader(teams), 'user-1', { orgId: 'org-1', teamId: 'team-x' });
    expect(scopes).toHaveLength(MAX_LIMIT_SCOPES);
    expect(scopes[0]).toEqual({ orgId: 'org-1', teamId: 'team-x' });
    expect(scopes[1]?.teamId).toBe('team-000');
  });
});

describe('reserveGenerationSlot', () => {
  function fakeApp(created: Array<Record<string, unknown>>) {
    const tx = {
      $executeRaw: async () => 0,
      configAuditLog: {
        count: async () => 0,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'audit-1' };
        },
      },
      organizationMembership: { findMany: async () => [] },
      runPlan: { count: async () => 0 },
      teamMembership: { findMany: async () => [] },
    };
    return {
      prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
    } as never;
  }

  const base = {
    jobId: 'runplan-aabbccdd-0123456789abcdef',
    mode: 'delivering',
    planId: 'plan-1',
    repoId: 'repo-1',
    scope: { orgId: 'org-1', teamId: 'team-1' },
    user: { exp: 0, iat: 0, role: 'ENGINEER', sub: 'user-1' } as never,
  };

  it('records the source of a Slack-started generation on its audit row, and no goal text', async () => {
    const created: Array<Record<string, unknown>> = [];
    const out = await reserveGenerationSlot(fakeApp(created), { ...base, source: 'slack' });
    expect(out).toEqual({ auditId: 'audit-1', ok: true });
    expect(created[0]?.afterJson).toEqual({
      connectionId: 'repo-1',
      event: GENERATION_STARTED,
      jobId: base.jobId,
      mode: 'delivering',
      source: 'slack',
      teamId: 'team-1',
    });
  });

  it('writes no source for a request from the API', async () => {
    const created: Array<Record<string, unknown>> = [];
    await reserveGenerationSlot(fakeApp(created), base);
    expect(created[0]?.afterJson).not.toHaveProperty('source');
  });
});
