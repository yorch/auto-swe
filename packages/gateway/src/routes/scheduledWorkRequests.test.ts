import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

import type { WorkRequestScheduleInput } from '../plugins/temporal.js';
import { CRON_5_FIELD_RE, scheduledWorkRequestRoutes } from './scheduledWorkRequests.js';

const REPO_ID = '00000000-0000-4000-8000-000000000001';
const TPL_ID = '00000000-0000-4000-8000-0000000000e1';
const SCHEDULE_ID = '00000000-0000-4000-8000-00000000000a';
const WR_ID = '00000000-0000-4000-8000-00000000000b';

describe('CRON_5_FIELD_RE', () => {
  it.each(['0 3 * * 0', '*/15 * * * *', '0 9-17 * * 1-5', '30 2 1,15 * *', '* * * * *'])(
    'accepts %s',
    (expr) => {
      expect(CRON_5_FIELD_RE.test(expr)).toBe(true);
    }
  );

  it.each([
    '@weekly', // macros not allowed
    '0 3 * *', // 4 fields
    '* * * * * *', // 6 fields
    '0 3 * * MON', // names not allowed
    '0 3 * * ?', // quartz syntax not allowed
    'rm -rf / # * * * *', // garbage
  ])('rejects %s', (expr) => {
    expect(CRON_5_FIELD_RE.test(expr)).toBe(false);
  });
});

describe('/api/v1/scheduled-work-requests', () => {
  const app = Fastify();

  // Per-test knobs
  let membershipRole = 'LEAD';
  let scheduleRow: Record<string, unknown> | null = null;
  let syncShouldFail = false;
  let temporalUp = true;
  let statusShouldFail = false;
  // The team default (tpl-1 v3) unless a test says the schedule last ran another.
  let lastSyncedTemplate: { templateId: string; templateVersion: number } = {
    templateId: 'tpl-1',
    templateVersion: 3,
  };
  let isOrgMember = true;
  let orgSpentUsd = 0;
  /** Team owning the explicit-override template; null = GLOBAL. */
  let overrideTemplateTeamId: string | null = null;
  /** Team ids the caller belongs to, for the template-visibility filter. */
  const callerTeamIds = ['team-1'];
  let failScheduleUpdate = false;
  let triggerShouldFail = false;
  /** When true the conditional row write finds the row moved (count 0). */
  let rowMovedUnderneath = false;
  /** Fail the Nth (1-based) Temporal sync of a test; null = never. */
  let failSyncAtCall: number | null = null;
  let syncCallCount = 0;
  /** Nth (1-based) conditional row write finds the row deactivated meanwhile (count 0). */
  let deactivateAtUpdateMany: number | null = null;
  const updateManyWheres: Array<Record<string, unknown>> = [];
  /** Runs just before the Nth (1-based) conditional write: another writer's change landing. */
  let concurrentWriter: ((call: number) => void) | null = null;
  let repoActive = true;
  /** Teams the repo is shared with, and the caller's role in each (null = not a member). */
  let sharedTeams: Array<{ teamId: string; role: string | null }> = [];

  const syncCalls: WorkRequestScheduleInput[] = [];
  const triggeredIds: string[] = [];
  const deletedScheduleIds: string[] = [];
  const createdWorkRequests: Array<Record<string, unknown>> = [];
  const createdActiveWorkflows: Array<Record<string, unknown>> = [];
  const deletedRowIds: string[] = [];
  const deletedWorkRequestIds: string[] = [];
  const scheduleUpdates: Array<Record<string, unknown>> = [];
  let lastUpdateData: Record<string, unknown> = {};
  const scheduleCreates: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  function rowWithInclude(data: Record<string, unknown>) {
    return {
      createdAt: new Date(),
      createdBy: { email: 'lead@x.com', id: 'user-1', name: 'Lead' },
      lastFiredAt: null,
      // What the list's `canManage` is derived from: the caller's membership in
      // the owning team and in each team the repository is shared with.
      repository: {
        id: REPO_ID,
        organizationName: 'org',
        repoName: 'test',
        shares: sharedTeams.map((t) => ({
          team: { memberships: t.role ? [{ role: t.role, userId: 'user-1' }] : [] },
          teamId: t.teamId,
        })),
        team: {
          memberships:
            membershipRole === 'NONE' ? [] : [{ role: membershipRole, userId: 'user-1' }],
        },
        teamId: 'team-1',
      },
      template: null,
      updatedAt: new Date(),
      ...data,
    };
  }

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        // Token encodes the platform role for test purposes.
        const role = token === 'admin-token' ? 'ADMIN' : 'ENGINEER';
        return { exp: 9999999999, iat: 0, role, sub: 'user-1' };
      },
    } as unknown as never);

    const prismaMock: Record<string, unknown> = {
      // Batch form (already-issued fake promises) or the interactive form.
      $transaction: async (ops: unknown) =>
        typeof ops === 'function'
          ? (ops as (tx: unknown) => Promise<unknown>)(prismaMock)
          : Promise.all(ops as Promise<unknown>[]),
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdActiveWorkflows.push(args.data);
          return { id: 'aw-1', ...args.data };
        },
        deleteMany: async () => ({ count: 1 }),
      },
      configAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          auditRows.push(args.data);
          return { id: 'audit-1', ...args.data };
        },
      },
      connection: {
        findFirst: async () => ({
          id: REPO_ID,
          isActive: repoActive,
          organizationName: 'org',
          repoName: 'test',
          shares: sharedTeams.map((t) => ({
            team: { memberships: t.role ? [{ role: t.role, userId: 'user-1' }] : [] },
            teamId: t.teamId,
          })),
          team: {
            memberships:
              membershipRole === 'NONE' ? [] : [{ role: membershipRole, userId: 'user-1' }],
            organization: { id: 'org-1', monthlyBudgetUsdCents: 1000 },
            orgId: 'org-1',
          },
          teamId: 'team-1',
          type: 'git_repo',
        }),
      },
      organizationMembership: {
        findUnique: async () => (isOrgMember ? { role: 'ORG_MEMBER' } : null),
      },
      orgMonthlyUsage: {
        findUnique: async () => ({ costUsdAccrued: orgSpentUsd }),
      },
      runInput: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdWorkRequests.push(args.data);
          return { ...args.data };
        },
        delete: async (args: { where: { id: string } }) => {
          deletedWorkRequestIds.push(args.where.id);
          return {};
        },
        // The template last synced to Temporal for the schedule.
        findUnique: async () => lastSyncedTemplate,
        update: async (args: { data: Record<string, unknown> }) => ({ ...args.data }),
      },
      scheduledWorkRequest: {
        create: async (args: { data: Record<string, unknown> }) => {
          scheduleCreates.push(args.data);
          return rowWithInclude({ ...args.data });
        },
        delete: async (args: { where: { id: string } }) => {
          deletedRowIds.push(args.where.id);
          return scheduleRow;
        },
        findMany: async () => (scheduleRow ? [rowWithInclude(scheduleRow)] : []),
        // Every real row has an updatedAt; fixtures that leave it out get one.
        findUnique: async (args: { where: { id: string } }) =>
          scheduleRow && args.where.id === SCHEDULE_ID
            ? { updatedAt: new Date(1), version: 0, ...scheduleRow }
            : null,
        findUniqueOrThrow: async () => rowWithInclude({ ...scheduleRow, ...lastUpdateData }),
        update: async (args: { data: Record<string, unknown> }) => {
          if (failScheduleUpdate && !('lastFiredAt' in args.data)) {
            throw new Error('db down');
          }
          scheduleUpdates.push(args.data);
          return rowWithInclude({ ...scheduleRow, ...args.data });
        },
        updateMany: async (args: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          if (failScheduleUpdate) {
            throw new Error('db down');
          }
          updateManyWheres.push(args.where);
          concurrentWriter?.(updateManyWheres.length);
          if (updateManyWheres.length === deactivateAtUpdateMany) {
            scheduleRow = { ...scheduleRow, isActive: false };
            return { count: 0 };
          }
          if (rowMovedUnderneath) {
            return { count: 0 };
          }
          // Compare-and-set on the version, as the database does.
          if ('version' in args.where && args.where.version !== (scheduleRow?.version ?? 0)) {
            return { count: 0 };
          }
          if (scheduleRow && 'version' in args.where) {
            scheduleRow = { ...scheduleRow, version: Number(scheduleRow.version ?? 0) + 1 };
          }
          lastUpdateData = args.data;
          scheduleUpdates.push(args.data);
          return { count: 1 };
        },
      },
      workflowTemplate: {
        // Explicit override (by id, with the caller-visibility filter) or the
        // resolveDefaultTemplate path (team default).
        findFirst: async (args: {
          where: { id?: string; OR?: Array<{ teamId?: null; team?: unknown }> };
        }) => {
          if (!args.where.id) {
            return { activeVersion: 3, id: 'tpl-1' };
          }
          if (args.where.id !== TPL_ID) {
            return null;
          }
          const visible =
            !args.where.OR ||
            overrideTemplateTeamId === null ||
            callerTeamIds.includes(overrideTemplateTeamId);
          return visible ? { activeVersion: 7, id: TPL_ID, teamId: overrideTemplateTeamId } : null;
        },
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === TPL_ID ? { activeVersion: 7, id: TPL_ID } : null,
      },
      workflowTemplateVersion: {
        findUnique: async () => ({ id: 'tplv-1' }),
      },
    };
    app.decorate('prisma', prismaMock as unknown as never);

    app.decorate('temporalConnection', {
      state: () => (temporalUp ? 'connected' : 'connecting'),
    } as unknown as never);
    app.decorate('temporal', {
      deleteWorkRequestSchedule: async (id: string) => {
        deletedScheduleIds.push(id);
      },
      getWorkRequestScheduleStatus: async () => {
        if (statusShouldFail) {
          throw new Error('deadline exceeded');
        }
        return {
          exists: true,
          lastRunAt: null,
          nextRunAt: '2026-06-17T03:00:00.000Z',
          paused: false,
        };
      },
      syncWorkRequestSchedule: async (input: WorkRequestScheduleInput) => {
        syncCallCount += 1;
        if (syncShouldFail || syncCallCount === failSyncAtCall) {
          throw new Error('temporal down');
        }
        syncCalls.push(input);
      },
      triggerWorkRequestSchedule: async (id: string) => {
        if (triggerShouldFail) {
          throw new Error('temporal down');
        }
        triggeredIds.push(id);
      },
    } as unknown as never);

    await app.register(scheduledWorkRequestRoutes, { prefix: '/api/v1/scheduled-work-requests' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    membershipRole = 'LEAD';
    scheduleRow = null;
    syncShouldFail = false;
    temporalUp = true;
    statusShouldFail = false;
    isOrgMember = true;
    orgSpentUsd = 0;
    overrideTemplateTeamId = null;
    failScheduleUpdate = false;
    triggerShouldFail = false;
    rowMovedUnderneath = false;
    failSyncAtCall = null;
    syncCallCount = 0;
    deactivateAtUpdateMany = null;
    concurrentWriter = null;
    repoActive = true;
    updateManyWheres.length = 0;
    lastUpdateData = {};
    sharedTeams = [];
    syncCalls.length = 0;
    triggeredIds.length = 0;
    deletedScheduleIds.length = 0;
    createdWorkRequests.length = 0;
    createdActiveWorkflows.length = 0;
    deletedRowIds.length = 0;
    deletedWorkRequestIds.length = 0;
    scheduleUpdates.length = 0;
    scheduleCreates.length = 0;
    auditRows.length = 0;
  });

  const validBody = {
    cronExpression: '0 3 * * 1',
    description: 'Update all dependencies',
    externalTicketPrefix: 'DEPS',
    name: 'Weekly dependency update',
    repoId: REPO_ID,
  };

  function inject(opts: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    token?: string;
    payload?: unknown;
  }) {
    return app.inject({
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      method: opts.method,
      ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
      url: opts.url,
    });
  }

  it('returns 401 without credentials', async () => {
    const res = await inject({
      method: 'POST',
      payload: validBody,
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid cron expression', async () => {
    const res = await inject({
      method: 'POST',
      payload: { ...validBody, cronExpression: '@weekly' },
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a plain ENGINEER team member', async () => {
    membershipRole = 'ENGINEER';
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'eng-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a schedule as a team LEAD and syncs the Temporal Schedule', async () => {
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.name).toBe('Weekly dependency update');
    expect(body.data.externalTicketId).toMatch(/^DEPS-SCHED-[0-9a-f]{8}$/);
    expect(body.data.schedule.nextRunAt).toBe('2026-06-17T03:00:00.000Z');

    // Standing WorkRequest + anchor ActiveWorkflow were written.
    expect(createdWorkRequests).toHaveLength(1);
    expect(createdWorkRequests[0].templateId).toBe('tpl-1'); // team default resolved at save
    // The id is generated from the schedule, so the ticket view leaves it out.
    expect(createdWorkRequests[0].ticketIsSynthetic).toBe(true);
    expect(createdWorkRequests[0].templateVersion).toBe(3);
    expect(createdActiveWorkflows).toHaveLength(1);
    expect(String(createdActiveWorkflows[0].temporalWorkflowId)).toMatch(/^sched-/);
    expect(createdActiveWorkflows[0].currentStatus).toBe('SCHEDULED');
    expect(createdActiveWorkflows[0].assignedBranch).toMatch(/^auto\/DEPS-SCHED-/);

    // Temporal Schedule synced with the static RunnableWorkflow args.
    expect(syncCalls).toHaveLength(1);
    const sync = syncCalls[0];
    expect(sync.cronExpression).toBe('0 3 * * 1');
    expect(sync.paused).toBe(false);
    expect(sync.templateId).toBe('tpl-1');
    expect(sync.templateVersion).toBe(3);
    expect(sync.request.repoId).toBe(REPO_ID);
    expect(sync.request.workRequestId).toBe(createdWorkRequests[0].id);
    expect(sync.request.externalTicketId).toBe(body.data.externalTicketId);
  });

  it('creates a schedule as a platform ADMIN with no team membership', async () => {
    membershipRole = 'NONE';
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'admin-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(201);
  });

  it('uses the explicit template override (activeVersion) when provided', async () => {
    const res = await inject({
      method: 'POST',
      payload: { ...validBody, templateId: TPL_ID },
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].templateId).toBe(TPL_ID);
    expect(syncCalls[0].templateVersion).toBe(7);
  });

  it('rejects an unknown explicit template', async () => {
    const res = await inject({
      method: 'POST',
      payload: { ...validBody, templateId: '00000000-0000-4000-8000-0000000000ee' },
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).error.code).toBe('TEMPLATE_NOT_RESOLVABLE');
  });

  it('rolls back DB rows when the Temporal schedule sync fails', async () => {
    syncShouldFail = true;
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_SYNC_FAILED');
    expect(deletedRowIds).toHaveLength(1);
    expect(deletedWorkRequestIds).toHaveLength(1);
  });

  it('pauses the Temporal Schedule when isActive is toggled off', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const res = await inject({
      method: 'PATCH',
      payload: { isActive: false },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].paused).toBe(true);
    expect(syncCalls[0].request.workRequestId).toBe(WR_ID);
  });

  // The caller is the schedule's acting user unless a test says otherwise: that is
  // what a schedule they created looks like.
  const pausedRow = () => ({
    actsAsUserId: 'user-1',
    budgetTier: 'STANDARD',
    cronExpression: '0 3 * * 1',
    description: 'Update all dependencies',
    externalTicketPrefix: 'DEPS',
    id: SCHEDULE_ID,
    isActive: false,
    name: 'Weekly dependency update',
    repoId: REPO_ID,
    templateId: null,
    templateVersion: null,
    workRequestId: WR_ID,
  });

  it('refuses to create a schedule for a caller outside the repo org', async () => {
    isOrgMember = false;
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(403);
    expect(createdWorkRequests).toHaveLength(0);
  });

  it('refuses to create a schedule when the org is over its monthly cap', async () => {
    orgSpentUsd = 10; // 1000 cents == the cap
    const res = await inject({
      method: 'POST',
      payload: validBody,
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.payload).error.code).toBe('ORG_BUDGET_EXCEEDED');
  });

  it('rejects a template override from a team the caller does not belong to', async () => {
    overrideTemplateTeamId = 'team-other';
    const res = await inject({
      method: 'POST',
      payload: { ...validBody, templateId: TPL_ID },
      token: 'lead-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(422);
    expect(createdWorkRequests).toHaveLength(0);
  });

  it('takes the launch decision when PATCH re-activates a paused schedule', async () => {
    scheduleRow = pausedRow();
    isOrgMember = false;
    const res = await inject({
      method: 'PATCH',
      payload: { isActive: true },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(403);
    expect(syncCalls).toHaveLength(0);
    expect(scheduleUpdates).toHaveLength(0);
  });

  it('takes the launch decision when PATCH re-times an active schedule', async () => {
    scheduleRow = { ...pausedRow(), isActive: true };
    isOrgMember = false;
    const res = await inject({
      method: 'PATCH',
      payload: { cronExpression: '* * * * *' },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(403);
    expect(syncCalls).toHaveLength(0);
    expect(scheduleUpdates).toHaveLength(0);
  });

  it('rebinds the schedule to whoever re-activates it, and records the takeover', async () => {
    scheduleRow = { ...pausedRow(), actsAsUserId: 'user-original' };
    const res = await inject({
      method: 'PATCH',
      payload: { isActive: true },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(scheduleUpdates.at(-1)).toMatchObject({ actsAsUserId: 'user-1' });
    // Every fire runs as — and is checked against — this user, so the takeover is
    // recorded, never silent.
    expect(auditRows.at(-1)).toMatchObject({
      actorId: 'user-1',
      afterJson: { actsAsUserId: 'user-1', event: 'acts-as-changed' },
      beforeJson: { actsAsUserId: 'user-original' },
      entityId: SCHEDULE_ID,
      entityType: 'ScheduledWorkRequest',
    });
  });

  it('does not rebind on a pause or rename', async () => {
    scheduleRow = { ...pausedRow(), actsAsUserId: 'user-original', isActive: true };
    const paused = await inject({
      method: 'PATCH',
      payload: { isActive: false },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(paused.statusCode).toBe(200);
    expect(scheduleUpdates.at(-1)).not.toHaveProperty('actsAsUserId');

    scheduleRow = { ...pausedRow(), actsAsUserId: 'user-original' };
    const renamed = await inject({
      method: 'PATCH',
      payload: { name: 'Renamed' },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(renamed.statusCode).toBe(200);
    expect(scheduleUpdates.at(-1)).not.toHaveProperty('actsAsUserId');
  });

  it('still lets an owner who lost access pause an active schedule', async () => {
    scheduleRow = { ...pausedRow(), isActive: true };
    isOrgMember = false;
    const res = await inject({
      method: 'PATCH',
      payload: { cronExpression: '* * * * *', isActive: false },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('still lets an owner who lost access rename a paused schedule', async () => {
    scheduleRow = pausedRow();
    isOrgMember = false;
    const res = await inject({
      method: 'PATCH',
      payload: { name: 'Renamed' },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('leaves the row untouched when the Temporal sync fails on PATCH', async () => {
    scheduleRow = { ...pausedRow(), isActive: true };
    syncShouldFail = true;
    const res = await inject({
      method: 'PATCH',
      payload: { cronExpression: '0 4 * * 1' },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(502);
    expect(scheduleUpdates).toHaveLength(0);
  });

  it('restores the Temporal schedule when the row update fails after a sync', async () => {
    scheduleRow = { ...pausedRow(), isActive: true };
    failScheduleUpdate = true;
    const res = await inject({
      method: 'PATCH',
      payload: { cronExpression: '0 4 * * 1' },
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(500);
    // The new schedule, then the stored one put back.
    expect(syncCalls.map((c) => c.cronExpression)).toEqual(['0 4 * * 1', '0 3 * * 1']);
  });

  describe('concurrent changes to a schedule', () => {
    const patchCron = () =>
      inject({
        method: 'PATCH',
        payload: { cronExpression: '0 4 * * 1' },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });

    it('writes the row only if it is still as it was read', async () => {
      scheduleRow = { ...pausedRow(), isActive: true, teamId: 'team-1', updatedAt: new Date(5) };
      expect((await patchCron()).statusCode).toBe(200);
      expect(updateManyWheres.at(-1)).toEqual({
        actsAsUserId: 'user-1',
        id: SCHEDULE_ID,
        isActive: true,
        teamId: 'team-1',
        version: 0,
      });
    });

    // Another writer's change, landing between this request's read and write.
    const writerBumps = (change: Record<string, unknown>) => (call: number) => {
      if (call === 1) {
        scheduleRow = { ...scheduleRow, ...change, version: Number(scheduleRow?.version ?? 0) + 1 };
      }
    };
    const activeRow = () => ({ ...pausedRow(), isActive: true, teamId: 'team-1' });

    it('detects a conflicting write in the same millisecond as the read', async () => {
      // The other writer leaves updatedAt exactly as it was; only the version moved.
      scheduleRow = { ...activeRow(), updatedAt: new Date(1) };
      concurrentWriter = writerBumps({ name: 'renamed elsewhere', updatedAt: new Date(1) });
      const res = await patchCron();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_CONFLICT');
      expect(scheduleUpdates).toHaveLength(0);
    });

    it('retries a PATCH that overlaps a fire-by-hand takeover, on the re-read row', async () => {
      scheduleRow = activeRow();
      concurrentWriter = writerBumps({ actsAsUserId: 'user-2' });
      const res = await patchCron();
      expect(res.statusCode).toBe(200);
      // The first attempt lost; the second wrote on the version the takeover left.
      expect(updateManyWheres.map((w) => [w.actsAsUserId, w.version])).toEqual([
        ['user-1', 0],
        ['user-2', 1],
      ]);
      // Re-timing rebinds to the editor, so Temporal was re-synced for the retry.
      expect(syncCalls.map((c) => c.cronExpression)).toEqual(['0 4 * * 1', '0 4 * * 1']);
      expect(auditRows.map((a) => (a.afterJson as { event: string }).event)).toEqual([
        'acts-as-changed',
      ]);
    });

    it('puts Temporal back on the row when a retry ends before saving', async () => {
      scheduleRow = activeRow();
      // A fire takes the schedule over and the repository is deactivated, so the
      // retried decision is refused: the first attempt's sync must not linger.
      concurrentWriter = (call) => {
        repoActive = false;
        writerBumps({ actsAsUserId: 'user-2' })(call);
      };
      const res = await patchCron();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('REPO_INACTIVE');
      expect(syncCalls.map((c) => [c.cronExpression, c.request.launchedById])).toEqual([
        ['0 4 * * 1', 'user-1'],
        ['0 3 * * 1', 'user-2'],
      ]);
    });

    it('still answers 409 when the overlapping change was a pause', async () => {
      scheduleRow = activeRow();
      concurrentWriter = writerBumps({ isActive: false });
      const res = await patchCron();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_CONFLICT');
      expect(updateManyWheres).toHaveLength(1);
      // Temporal follows the row as it now stands: paused.
      expect(syncCalls.at(-1)).toMatchObject({ paused: true });
    });

    it('gives up after a bounded number of retries', async () => {
      scheduleRow = activeRow();
      concurrentWriter = () => {
        scheduleRow = { ...scheduleRow, version: Number(scheduleRow?.version ?? 0) + 1 };
      };
      expect((await patchCron()).statusCode).toBe(409);
      expect(updateManyWheres).toHaveLength(3);
    });

    it('answers 409 and re-syncs Temporal from the row when it moved under a PATCH', async () => {
      scheduleRow = { ...pausedRow(), isActive: false };
      rowMovedUnderneath = true;
      const res = await inject({
        method: 'PATCH',
        payload: { cronExpression: '0 4 * * 1', isActive: true },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_CONFLICT');
      expect(scheduleUpdates).toHaveLength(0);
      expect(auditRows).toHaveLength(0);
      // The edit's schedule (active, new cron), then the row as it now stands:
      // paused, old cron. A paused schedule is never left running.
      expect(syncCalls.map((c) => [c.cronExpression, c.paused])).toEqual([
        ['0 4 * * 1', false],
        ['0 3 * * 1', true],
      ]);
    });
  });

  describe('whose identity fires launch as', () => {
    const authored = () => ({
      actsAsUserId: 'author-1',
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    });

    it('launches as the creator, fixed into the Temporal schedule arguments', async () => {
      const res = await inject({
        method: 'POST',
        payload: validBody,
        token: 'lead-token',
        url: '/api/v1/scheduled-work-requests',
      });
      expect(res.statusCode).toBe(201);
      expect(syncCalls[0].request.launchedById).toBe('user-1');
    });

    it('moves to whoever changes what the schedule does', async () => {
      // Without this, a lead could rewrite someone else's schedule and have it
      // run with that person's own GitHub token.
      scheduleRow = authored();
      const res = await inject({
        method: 'PATCH',
        payload: { description: 'Delete the production branch protection' },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(scheduleUpdates[0].actsAsUserId).toBe('user-1');
      expect(syncCalls[0].request.launchedById).toBe('user-1');
    });

    it('stays with the author when it is only paused or renamed', async () => {
      // Neither can cause anything to run.
      scheduleRow = authored();
      const res = await inject({
        method: 'PATCH',
        payload: { isActive: false, name: 'Renamed' },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(scheduleUpdates[0]).not.toHaveProperty('actsAsUserId');
      expect(syncCalls[0].request.launchedById).toBe('author-1');
    });

    it('moves to whoever revives it or makes it fire more often', async () => {
      for (const payload of [{ cronExpression: '* * * * *' }, { budgetTier: 'EPIC' }]) {
        scheduleRow = authored();
        scheduleUpdates.length = 0;
        await inject({
          method: 'PATCH',
          payload,
          token: 'lead-token',
          url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
        });
        expect(scheduleUpdates[0].actsAsUserId, JSON.stringify(payload)).toBe('user-1');
      }
      scheduleRow = { ...authored(), isActive: false };
      scheduleUpdates.length = 0;
      await inject({
        method: 'PATCH',
        payload: { isActive: true },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(scheduleUpdates[0].actsAsUserId).toBe('user-1');
    });

    it('moves a stranded schedule to the owning team when it is revived', async () => {
      // Its team (team-9) is neither the owner (team-1) nor a sharer, so the
      // next share change would silently re-pause it.
      scheduleRow = { ...authored(), isActive: false, teamId: 'team-9' };
      const res = await inject({
        method: 'PATCH',
        payload: { isActive: true },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(scheduleUpdates[0].teamId).toBe('team-1');
      // The claim still matches the team it was read with.
      expect(updateManyWheres.at(-1)).toMatchObject({ teamId: 'team-9' });
      expect(auditRows.at(-1)).toMatchObject({
        afterJson: { actsAsUserId: 'user-1', teamId: 'team-1' },
        beforeJson: { actsAsUserId: 'author-1', teamId: 'team-9' },
      });
    });

    it('leaves the team alone when the reviving schedule team still has a claim', async () => {
      sharedTeams = [{ role: 'LEAD', teamId: 'team-2' }];
      scheduleRow = { ...authored(), isActive: false, teamId: 'team-2' };
      await inject({
        method: 'PATCH',
        payload: { isActive: true },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(scheduleUpdates[0]).not.toHaveProperty('teamId');
    });

    it('moves to the editor when an edit picks up a new team-default template', async () => {
      // The schedule stores no template of its own; it last ran tpl-1 v2, and
      // the team default is now v3. Any edit re-syncs it with v3 — new content
      // the author never saw — so the editor becomes who it runs as.
      lastSyncedTemplate = { templateId: 'tpl-1', templateVersion: 2 };
      scheduleRow = authored();
      await inject({
        method: 'PATCH',
        payload: { name: 'Renamed' },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      lastSyncedTemplate = { templateId: 'tpl-1', templateVersion: 3 };
      expect(scheduleUpdates[0].actsAsUserId).toBe('user-1');
      expect(syncCalls[0].request.launchedById).toBe('user-1');
    });

    it('launches as nobody when no author is recorded', async () => {
      scheduleRow = { ...authored(), actsAsUserId: null };
      await inject({
        method: 'PATCH',
        payload: { isActive: false },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
      expect(syncCalls[0].request).not.toHaveProperty('launchedById');
    });
  });

  it('fires the schedule now via the Temporal trigger', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const res = await inject({
      method: 'POST',
      payload: {},
      token: 'lead-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}/fire`,
    });
    expect(res.statusCode).toBe(202);
    expect(triggeredIds).toEqual([SCHEDULE_ID]);
    // lastFiredAt bookkeeping
    expect(scheduleUpdates.at(-1)).toHaveProperty('lastFiredAt');
  });

  it('forbids fire-now for a plain ENGINEER team member', async () => {
    membershipRole = 'ENGINEER';
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'x',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'x',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const res = await inject({
      method: 'POST',
      payload: {},
      token: 'eng-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}/fire`,
    });
    expect(res.statusCode).toBe(403);
    expect(triggeredIds).toHaveLength(0);
  });

  describe('firing by hand takes the schedule over', () => {
    const owned = (over: Record<string, unknown> = {}) => ({
      actsAsUserId: 'author-1',
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
      ...over,
    });
    const fire = (token = 'lead-token') =>
      inject({
        method: 'POST',
        payload: {},
        token,
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}/fire`,
      });

    it('rebinds to the firer, re-syncs Temporal, then triggers, and records it', async () => {
      scheduleRow = owned();
      const res = await fire();
      expect(res.statusCode).toBe(202);
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].request.launchedById).toBe('user-1');
      expect(syncCalls[0].templateId).toBe('tpl-1');
      expect(triggeredIds).toEqual([SCHEDULE_ID]);
      expect(scheduleUpdates[0]).toEqual({ actsAsUserId: 'user-1', version: { increment: 1 } });
      expect(auditRows.at(-1)).toMatchObject({
        afterJson: { actsAsUserId: 'user-1', event: 'acts-as-changed' },
        beforeJson: { actsAsUserId: 'author-1' },
      });
    });

    it('refuses a firer the launch gate refuses, and rebinds nothing', async () => {
      scheduleRow = owned();
      isOrgMember = false;
      const res = await fire();
      expect(res.statusCode).toBe(403);
      expect(syncCalls).toHaveLength(0);
      expect(triggeredIds).toHaveLength(0);
      expect(scheduleUpdates).toHaveLength(0);
    });

    it('does not rebind or re-sync when the author fires', async () => {
      scheduleRow = owned({ actsAsUserId: 'user-1' });
      const res = await fire();
      expect(res.statusCode).toBe(202);
      expect(syncCalls).toHaveLength(0);
      expect(triggeredIds).toEqual([SCHEDULE_ID]);
      expect(scheduleUpdates).toEqual([expect.objectContaining({ lastFiredAt: expect.any(Date) })]);
      expect(auditRows).toHaveLength(0);
    });

    it("judges the author's own fire as the caller, not the platform", async () => {
      scheduleRow = owned({ actsAsUserId: 'user-1' });
      isOrgMember = false;
      expect((await fire()).statusCode).toBe(403);
      expect(triggeredIds).toHaveLength(0);
    });

    it('leaves the author in place when the Temporal re-sync fails', async () => {
      scheduleRow = owned();
      syncShouldFail = true;
      const res = await fire();
      expect(res.statusCode).toBe(502);
      expect(scheduleUpdates).toHaveLength(0);
      expect(triggeredIds).toHaveLength(0);
    });

    it('puts Temporal back when the row update fails', async () => {
      scheduleRow = owned();
      failScheduleUpdate = true;
      const res = await fire();
      expect(res.statusCode).toBe(500);
      expect(syncCalls.map((c) => c.request.launchedById)).toEqual(['user-1', 'author-1']);
      expect(triggeredIds).toHaveLength(0);
    });

    it('undoes the takeover in both places when the trigger fails', async () => {
      scheduleRow = owned();
      triggerShouldFail = true;
      const res = await fire();
      expect(res.statusCode).toBe(502);
      expect(syncCalls.map((c) => c.request.launchedById)).toEqual(['user-1', 'author-1']);
      expect(scheduleUpdates.map((u) => u.actsAsUserId)).toEqual(['user-1', 'author-1']);
      expect(auditRows.map((a) => (a.afterJson as { event: string }).event)).toEqual([
        'acts-as-changed',
        'acts-as-reverted',
      ]);
    });

    it('keeps the takeover in both places when Temporal cannot be restored to the author', async () => {
      scheduleRow = owned();
      triggerShouldFail = true;
      // Sync 1 binds the firer; sync 2 (the restore) fails.
      failSyncAtCall = 2;
      const res = await fire();
      expect(res.statusCode).toBe(502);
      // The row is reverted first, then Temporal cannot follow, so the row is
      // put back on the firer to match what Temporal holds.
      expect(scheduleUpdates.map((u) => u.actsAsUserId)).toEqual(['user-1', 'author-1', 'user-1']);
      expect(auditRows.at(-1)).toMatchObject({
        actorId: 'user-1',
        afterJson: { actsAsUserId: 'user-1', event: 'acts-as-takeover-kept' },
      });
    });

    it('answers 409 and re-syncs Temporal from the row when the row moved under the takeover', async () => {
      scheduleRow = owned();
      rowMovedUnderneath = true;
      const res = await fire();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_CONFLICT');
      expect(triggeredIds).toHaveLength(0);
      expect(auditRows).toHaveLength(0);
      // The final sync is the row's own state: its author.
      expect(syncCalls.at(-1)?.request.launchedById).toBe('author-1');
    });

    it('refuses to fire a paused schedule, before any takeover or write', async () => {
      scheduleRow = owned({ isActive: false });
      const res = await fire();
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SCHEDULE_INACTIVE');
      expect(syncCalls).toHaveLength(0);
      expect(triggeredIds).toHaveLength(0);
      expect(scheduleUpdates).toHaveLength(0);
      expect(updateManyWheres).toHaveLength(0);
      expect(auditRows).toHaveLength(0);
    });

    it('reverts the row only while it is as the takeover left it', async () => {
      scheduleRow = owned();
      triggerShouldFail = true;
      await fire();
      expect(updateManyWheres.at(-1)).toEqual({
        actsAsUserId: 'user-1',
        id: SCHEDULE_ID,
        isActive: true,
        teamId: undefined,
        // The version the takeover left.
        version: 1,
      });
    });

    it('follows a deactivation that lands between the takeover and a failed trigger', async () => {
      scheduleRow = owned();
      triggerShouldFail = true;
      // Call 1 is the claim; call 2 is the conditional revert, which finds the
      // row paused meanwhile and so does not match.
      deactivateAtUpdateMany = 2;
      const res = await fire();
      expect(res.statusCode).toBe(502);
      // Temporal is synced from the row as it now stands (paused), never from
      // the stale active snapshot, and nothing is recorded as reverted.
      expect(syncCalls.at(-1)).toMatchObject({ paused: true });
      expect(syncCalls.map((c) => c.paused)).toEqual([false, true]);
      expect(auditRows.map((a) => (a.afterJson as { event: string }).event)).toEqual([
        'acts-as-changed',
      ]);
    });

    it('refuses a takeover of an orphaned schedule', async () => {
      scheduleRow = owned({ workRequestId: null });
      expect((await fire()).statusCode).toBe(409);
      expect(triggeredIds).toHaveLength(0);
    });
  });

  describe('shared teams may schedule', () => {
    const SHARED = '00000000-0000-4000-8000-0000000000c1';
    const OTHER_SHARED = '00000000-0000-4000-8000-0000000000c2';
    const row = (over: Record<string, unknown> = {}) => ({
      actsAsUserId: 'user-1',
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      teamId: SHARED,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
      ...over,
    });
    const create = (payload: Record<string, unknown> = {}) =>
      inject({
        method: 'POST',
        payload: { ...validBody, ...payload },
        token: 'lead-token',
        url: '/api/v1/scheduled-work-requests',
      });
    const patch = () =>
      inject({
        method: 'PATCH',
        payload: { name: 'renamed' },
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
    const fire = () =>
      inject({
        method: 'POST',
        payload: {},
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}/fire`,
      });
    const del = () =>
      inject({
        method: 'DELETE',
        token: 'lead-token',
        url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
      });
    const createdTeam = () => scheduleCreates.at(-1)?.teamId;

    it('lets a shared-team lead create, owned by that team by default', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      expect((await create()).statusCode).toBe(201);
      expect(createdTeam()).toBe(SHARED);
      expect(syncCalls).toHaveLength(1);
    });

    it('defaults to the owning team for its lead, even when also a shared lead', async () => {
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      expect((await create()).statusCode).toBe(201);
      expect(createdTeam()).toBe('team-1');
    });

    it('lets the owning-team lead pick a shared team they also lead', async () => {
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      expect((await create({ teamId: SHARED })).statusCode).toBe(201);
      expect(createdTeam()).toBe(SHARED);
    });

    it('asks for teamId when the caller leads several shared teams', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [
        { role: 'LEAD', teamId: SHARED },
        { role: 'LEAD', teamId: OTHER_SHARED },
      ];
      const res = await create();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('TEAM_REQUIRED');
      expect((await create({ teamId: OTHER_SHARED })).statusCode).toBe(201);
      expect(createdTeam()).toBe(OTHER_SHARED);
    });

    it('rejects a teamId that is neither the owner nor a shared team', async () => {
      const res = await create({ teamId: '00000000-0000-4000-8000-0000000000aa' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INVALID_SCHEDULE_TEAM');
    });

    it('rejects a teamId of a shared team the caller does not lead', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [
        { role: 'LEAD', teamId: SHARED },
        { role: 'ENGINEER', teamId: OTHER_SHARED },
      ];
      expect((await create({ teamId: OTHER_SHARED })).statusCode).toBe(403);
    });

    it('does not let a mere shared-team member create', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'ENGINEER', teamId: SHARED }];
      expect((await create()).statusCode).toBe(403);
    });

    it('lets a shared lead edit, fire and delete their own team schedule', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      scheduleRow = row();
      expect((await patch()).statusCode).toBe(200);
      expect((await fire()).statusCode).toBe(202);
      expect((await del()).statusCode).toBe(200);
    });

    it("forbids a shared lead from another team's schedule", async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [
        { role: 'LEAD', teamId: SHARED },
        { role: 'ENGINEER', teamId: OTHER_SHARED },
      ];
      scheduleRow = row({ teamId: OTHER_SHARED });
      expect((await patch()).statusCode).toBe(403);
      expect((await fire()).statusCode).toBe(403);
      expect((await del()).statusCode).toBe(403);
    });

    it("forbids a shared lead from the owning team's schedule, legacy or not", async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      for (const teamId of [null, 'team-1']) {
        scheduleRow = row({ teamId });
        expect((await patch()).statusCode).toBe(403);
        expect((await del()).statusCode).toBe(403);
      }
      expect(deletedRowIds).toHaveLength(0);
    });

    it("lets the owning team's lead manage a shared team's schedule", async () => {
      sharedTeams = [{ role: null, teamId: SHARED }];
      scheduleRow = row({ actsAsUserId: 'other' });
      expect((await patch()).statusCode).toBe(200);
      expect((await fire()).statusCode).toBe(202);
      expect((await del()).statusCode).toBe(200);
    });

    it("leaves a team-less schedule to ADMIN and the owning team's lead", async () => {
      // A null team means the team was deleted: whose it was is unknown.
      scheduleRow = row({ teamId: null });
      expect((await patch()).statusCode).toBe(200);
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: SHARED }];
      expect((await patch()).statusCode).toBe(403);
    });

    it('forbids a lead of a team the repository is no longer shared with', async () => {
      membershipRole = 'ENGINEER';
      sharedTeams = [];
      scheduleRow = row();
      expect((await patch()).statusCode).toBe(403);
    });
  });

  it('returns 404 firing an unknown schedule', async () => {
    const res = await inject({
      method: 'POST',
      payload: {},
      token: 'admin-token',
      url: '/api/v1/scheduled-work-requests/00000000-0000-4000-8000-0000000000ff/fire',
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes the Temporal Schedule along with the row', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'x',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'x',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const res = await inject({
      method: 'DELETE',
      token: 'admin-token',
      url: `/api/v1/scheduled-work-requests/${SCHEDULE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(deletedScheduleIds).toEqual([SCHEDULE_ID]);
    expect(deletedRowIds).toEqual([SCHEDULE_ID]);
  });

  it('lists schedules with live Temporal status', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const res = await inject({
      method: 'GET',
      token: 'eng-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].schedule.exists).toBe(true);
    expect(body.data[0].schedule.nextRunAt).toBe('2026-06-17T03:00:00.000Z');
  });

  it('reports an unknown schedule state, not "no schedule", while Temporal is not connected', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    temporalUp = false;
    const res = await inject({
      method: 'GET',
      token: 'eng-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data[0].schedule).toMatchObject({
      exists: null,
      unavailable: true,
    });
  });

  it('reports an unknown state when the live lookup fails while connected', async () => {
    scheduleRow = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    statusShouldFail = true;
    const res = await inject({
      method: 'GET',
      token: 'eng-token',
      url: '/api/v1/scheduled-work-requests',
    });
    expect(JSON.parse(res.payload).data[0].schedule).toMatchObject({
      exists: null,
      unavailable: true,
    });
  });

  describe('canManage on the list', () => {
    const row = {
      budgetTier: 'STANDARD',
      cronExpression: '0 3 * * 1',
      description: 'Update all dependencies',
      externalTicketPrefix: 'DEPS',
      id: SCHEDULE_ID,
      isActive: true,
      name: 'Weekly dependency update',
      repoId: REPO_ID,
      teamId: 'team-1',
      templateId: null,
      templateVersion: null,
      workRequestId: WR_ID,
    };
    const list = async (token: string) =>
      JSON.parse(
        (await inject({ method: 'GET', token, url: '/api/v1/scheduled-work-requests' })).payload
      ).data[0];

    it('is true for the owning team lead and false for a plain member', async () => {
      scheduleRow = { ...row };
      membershipRole = 'LEAD';
      expect((await list('eng-token')).canManage).toBe(true);
      membershipRole = 'ENGINEER';
      expect((await list('eng-token')).canManage).toBe(false);
    });

    it('is true for an ADMIN regardless of membership', async () => {
      scheduleRow = { ...row };
      membershipRole = 'NONE';
      expect((await list('admin-token')).canManage).toBe(true);
    });

    it("is false for a shared team lead on another team's schedule", async () => {
      scheduleRow = { ...row };
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: 'team-2' }];
      expect((await list('eng-token')).canManage).toBe(false);
    });

    it("is true for a shared team lead on their own team's schedule", async () => {
      scheduleRow = { ...row, teamId: 'team-2' };
      membershipRole = 'ENGINEER';
      sharedTeams = [{ role: 'LEAD', teamId: 'team-2' }];
      expect((await list('eng-token')).canManage).toBe(true);
    });
  });
});
