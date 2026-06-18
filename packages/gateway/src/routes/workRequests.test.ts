import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => ({
    apiToken: null,
    baseUrl: null,
    email: null,
    provider: null,
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

vi.mock('../lib/issueTrackerClient.js', () => ({
  fetchTicket: vi.fn(async () => null),
}));

import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { fetchTicket } from '../lib/issueTrackerClient.js';
import { experimentBucket, resolveDefaultTemplate, workRequestRoutes } from './workRequests.js';

const resolveIssueTrackerConfigMock = vi.mocked(resolveIssueTrackerConfig);
const fetchTicketMock = vi.mocked(fetchTicket);

describe('POST /api/v1/work-requests', () => {
  const app = Fastify();
  // Per-test control over allocateWorkflowId's view of prior executions.
  let existingWorkflows: Array<{ currentStatus: string; temporalWorkflowId: string }> = [];
  const startedWorkflowIds: string[] = [];
  const snapshotUpserts: Record<string, unknown>[] = [];
  // Per-test control over the resolved template's inputSchema (P3). Null =
  // no schema → submit validation is skipped (the default for most tests).
  let templateInputSchema: unknown = null;

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Mock auth plugin — verifyAccessToken accepts any non-empty token in tests
    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        return { exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' };
      },
    } as unknown as never);

    // Mock prisma and temporal on the app instance (cast through unknown to bypass strict typing)
    app.decorate('prisma', {
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => ({
          id: 'wf-1',
          ...args.data,
        }),
        findMany: async () => existingWorkflows,
      },
      connection: {
        findUnique: async () => ({
          id: 'repo-1',
          isActive: true,
          organizationName: 'org',
          repoName: 'test',
          team: { memberships: [{ userId: 'user-1' }] },
          teamId: 'team-1',
          type: 'git_repo',
        }),
      },
      contextSnapshot: {
        upsert: async (args: Record<string, unknown>) => {
          snapshotUpserts.push(args);
          return { id: 'cs-1' };
        },
      },
      runInput: {
        create: async (args: { data: Record<string, unknown> }) => ({ id: 'wr-1', ...args.data }),
      },
      workflowTemplate: {
        findFirst: async () => ({
          activeVersion: 1,
          id: 'tpl-1',
        }),
        findUnique: async () => ({ inputSchema: templateInputSchema }),
      },
    } as unknown as never);
    app.decorate('temporal', {
      cancelWorkflow: async () => {},
      deleteWorkRequestSchedule: async () => {},
      getConsolidationScheduleStatus: async () => ({
        exists: false,
        nextRunAt: null,
        paused: false,
      }),
      getWorkRequestScheduleStatus: async () => ({
        exists: false,
        lastRunAt: null,
        nextRunAt: null,
        paused: false,
      }),
      signalWorkflow: async () => {},
      startConsolidationWorkflow: async () => {},
      startEpicWorkflow: async () => {},
      startRunnableWorkflow: async (id: string) => {
        startedWorkflowIds.push(id);
      },
      syncConsolidationSchedule: async () => {},
      syncWorkRequestSchedule: async () => {},
      triggerConsolidationNow: async () => {},
      triggerWorkRequestSchedule: async () => {},
    });

    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterAll(() => app.close());

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing description', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { externalTicketId: 'JIRA-1', repoIds: ['00000000-0000-4000-8000-000000000001'] },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a work request', async () => {
    existingWorkflows = [];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.workRequestId).toBeDefined();
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1');
  });

  it('accepts a submission that satisfies the template inputSchema', async () => {
    existingWorkflows = [];
    templateInputSchema = {
      properties: { description: { type: 'string' }, ticketId: { type: 'string' } },
      required: ['ticketId', 'description'],
      type: 'object',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-OK',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    templateInputSchema = null;
    expect(res.statusCode).toBe(201);
  });

  it('rejects a submission that violates the template inputSchema', async () => {
    existingWorkflows = [];
    const before = startedWorkflowIds.length;
    // Require a field the server-built payload never supplies → 400, no Temporal start.
    templateInputSchema = {
      properties: { approvalToken: { type: 'string' } },
      required: ['approvalToken'],
      type: 'object',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-BAD',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    templateInputSchema = null;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.details).toContain("'approvalToken' is required");
    // Validation happens before the idempotency gate — no workflow was started.
    expect(startedWorkflowIds.length).toBe(before);
  });

  it('returns 409 when an execution for the ticket is still running', async () => {
    existingWorkflows = [
      { currentStatus: 'IMPLEMENTING', temporalWorkflowId: 'eng-org-test-JIRA-1' },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('WORKFLOW_ALREADY_EXISTS');
  });

  it('allocates an -rN workflow ID when re-submitting a finished ticket', async () => {
    existingWorkflows = [{ currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-1' }];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1-r2');
  });

  it('enriches the context snapshot when a tracker is configured and the fetch succeeds', async () => {
    existingWorkflows = [];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockResolvedValueOnce({
      apiToken: 'tok',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      provider: 'jira',
    });
    fetchTicketMock.mockResolvedValueOnce({
      description: 'Full ticket body',
      labels: ['backend'],
      raw: { key: 'JIRA-2' },
      status: 'To Do',
      title: 'Add health endpoint',
      url: 'https://acme.atlassian.net/browse/JIRA-2',
    });

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(1);
    const upsert = snapshotUpserts[0] as {
      create: { rawTicketData: { title: string }; workRequestId: string };
      where: { workRequestId: string };
    };
    expect(upsert.create.rawTicketData.title).toBe('Add health endpoint');
    expect(upsert.where.workRequestId).toBe(JSON.parse(res.payload).data.workRequestId);
    // The repo the request targets is passed as the bare-number fallback for GitHub IDs.
    expect(fetchTicketMock.mock.calls[0]?.[2]?.defaultRepo).toEqual({
      owner: 'org',
      repo: 'test',
    });
  });

  it('still returns 201 and writes no snapshot when the tracker fetch fails', async () => {
    existingWorkflows = [{ currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2' }];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockResolvedValueOnce({
      apiToken: 'tok',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      provider: 'jira',
    });
    fetchTicketMock.mockResolvedValueOnce(null); // 404 / timeout / network error

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(0);
  });

  it('still returns 201 when the tracker enrichment throws unexpectedly', async () => {
    existingWorkflows = [
      { currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2' },
      { currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2-r2' },
    ];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(0);
  });

  it('skips the tracker fetch entirely when no provider is configured', async () => {
    existingWorkflows = [];
    snapshotUpserts.length = 0;
    fetchTicketMock.mockClear();

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-3',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(fetchTicketMock).not.toHaveBeenCalled();
    expect(snapshotUpserts).toHaveLength(0);
  });

  it('ignores prefix-similar workflow IDs from other tickets when allocating', async () => {
    // 'eng-org-test-JIRA-1-restore' belongs to ticket 'JIRA-1-restore', not a re-run.
    existingWorkflows = [
      { currentStatus: 'IMPLEMENTING', temporalWorkflowId: 'eng-org-test-JIRA-1-restore' },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1');
  });
});

describe('resolveDefaultTemplate', () => {
  function fakePrisma(opts: {
    teamMatch?: { id: string; activeVersion: number | null } | null;
    globalMatch?: { id: string; activeVersion: number | null } | null;
  }) {
    const findFirst = vi
      .fn()
      .mockImplementationOnce(async () => opts.teamMatch ?? null)
      .mockImplementationOnce(async () => opts.globalMatch ?? null);
    return { findFirst, prisma: { workflowTemplate: { findFirst } } };
  }

  it('prefers the team default over the global default', async () => {
    const { prisma } = fakePrisma({
      globalMatch: { activeVersion: 2, id: 'global-tpl' },
      teamMatch: { activeVersion: 5, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });

  it('falls back to the global default when no team default exists', async () => {
    const { findFirst, prisma } = fakePrisma({
      globalMatch: { activeVersion: 1, id: 'global-tpl' },
      teamMatch: null,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'global-tpl', version: 1 });
    expect(findFirst).toHaveBeenCalledTimes(2);
    const secondWhere = findFirst.mock.calls[1]?.[0]?.where as Record<string, unknown>;
    expect(secondWhere.teamId).toBeNull();
  });

  it('returns null when neither a team nor global default is configured', async () => {
    const { prisma } = fakePrisma({ globalMatch: null, teamMatch: null });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });

  it('returns null when the matched template has no activeVersion', async () => {
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: { activeVersion: null, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });

  it('routes to the experiment version when bucket lands below the split', async () => {
    // experimentSplit=100 → every ticket lands in the experiment arm.
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 100,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1',
      'JIRA-1'
    );
    expect(out).toEqual({ isExperiment: true, templateId: 'team-tpl', version: 7 });
  });

  it('stays on the active version when bucket lands above the split', async () => {
    // experimentSplit=0 → no traffic ever enters the experiment arm.
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 0,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1',
      'JIRA-99'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });

  it('ignores the experiment when externalTicketId is not provided', async () => {
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 100,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });
});

describe('experimentBucket', () => {
  it('is deterministic for a given (templateId, ticketId)', () => {
    const a = experimentBucket('JIRA-42', 'tpl-1');
    const b = experimentBucket('JIRA-42', 'tpl-1');
    expect(a).toBe(b);
  });

  it('returns a value in [0, 100)', () => {
    for (const t of ['JIRA-1', 'PROJ-99', 'AAA-0', 'edge case ticket']) {
      const b = experimentBucket(t, 'tpl-x');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('decorrelates buckets across templateIds (salt works)', () => {
    // Same ticket, two templates → buckets should generally differ.
    // (Not a strict invariant — birthday collisions are possible — but with
    // sha1 + 100 buckets, picking two distinct templateIds and a fixed ticket
    // hitting the same bucket is 1/100; we test a handful to confirm the
    // salt is actually mixed in.)
    const distinct = new Set<number>();
    for (let i = 0; i < 20; i++) {
      distinct.add(experimentBucket('JIRA-1', `tpl-${i}`));
    }
    expect(distinct.size).toBeGreaterThan(1);
  });
});
