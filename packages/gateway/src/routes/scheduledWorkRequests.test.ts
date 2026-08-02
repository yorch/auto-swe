import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

  const syncCalls: WorkRequestScheduleInput[] = [];
  const triggeredIds: string[] = [];
  const deletedScheduleIds: string[] = [];
  const createdWorkRequests: Array<Record<string, unknown>> = [];
  const createdActiveWorkflows: Array<Record<string, unknown>> = [];
  const deletedRowIds: string[] = [];
  const deletedWorkRequestIds: string[] = [];
  const scheduleUpdates: Array<Record<string, unknown>> = [];

  function rowWithInclude(data: Record<string, unknown>) {
    return {
      createdAt: new Date(),
      createdBy: { email: 'lead@x.com', id: 'user-1', name: 'Lead' },
      lastFiredAt: null,
      repository: { id: REPO_ID, organizationName: 'org', repoName: 'test' },
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

    app.decorate('prisma', {
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdActiveWorkflows.push(args.data);
          return { id: 'aw-1', ...args.data };
        },
        deleteMany: async () => ({ count: 1 }),
      },
      connection: {
        findFirst: async () => ({
          id: REPO_ID,
          isActive: true,
          organizationName: 'org',
          repoName: 'test',
          team: {
            memberships:
              membershipRole === 'NONE' ? [] : [{ role: membershipRole, userId: 'user-1' }],
          },
          teamId: 'team-1',
          type: 'git_repo',
        }),
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
        update: async (args: { data: Record<string, unknown> }) => ({ ...args.data }),
      },
      scheduledWorkRequest: {
        create: async (args: { data: Record<string, unknown> }) => rowWithInclude({ ...args.data }),
        delete: async (args: { where: { id: string } }) => {
          deletedRowIds.push(args.where.id);
          return scheduleRow;
        },
        findMany: async () => (scheduleRow ? [rowWithInclude(scheduleRow)] : []),
        findUnique: async (args: { where: { id: string } }) =>
          scheduleRow && args.where.id === SCHEDULE_ID ? { ...scheduleRow } : null,
        update: async (args: { data: Record<string, unknown> }) => {
          scheduleUpdates.push(args.data);
          return rowWithInclude({ ...scheduleRow, ...args.data });
        },
      },
      workflowTemplate: {
        // resolveDefaultTemplate path (team default)
        findFirst: async () => ({ activeVersion: 3, id: 'tpl-1' }),
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === TPL_ID ? { activeVersion: 7, id: TPL_ID } : null,
      },
      workflowTemplateVersion: {
        findUnique: async () => ({ id: 'tplv-1' }),
      },
    } as unknown as never);

    app.decorate('temporal', {
      deleteWorkRequestSchedule: async (id: string) => {
        deletedScheduleIds.push(id);
      },
      getWorkRequestScheduleStatus: async () => ({
        exists: true,
        lastRunAt: null,
        nextRunAt: '2026-06-17T03:00:00.000Z',
        paused: false,
      }),
      syncWorkRequestSchedule: async (input: WorkRequestScheduleInput) => {
        if (syncShouldFail) {
          throw new Error('temporal down');
        }
        syncCalls.push(input);
      },
      triggerWorkRequestSchedule: async (id: string) => {
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
    syncCalls.length = 0;
    triggeredIds.length = 0;
    deletedScheduleIds.length = 0;
    createdWorkRequests.length = 0;
    createdActiveWorkflows.length = 0;
    deletedRowIds.length = 0;
    deletedWorkRequestIds.length = 0;
    scheduleUpdates.length = 0;
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
});
