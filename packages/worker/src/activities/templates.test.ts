import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { Context } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string, details?: unknown) => {
      const err = new Error(message);
      (err as Error & { type?: string; details?: unknown }).type = type;
      (err as Error & { type?: string; details?: unknown }).details = details;
      return err;
    },
  },
  activityInfo: () => ({ workflowExecution: { runId: 'temporal-run-1', workflowId: 'wf-1' } }),
  Context: {
    current: vi.fn(() => ({ info: { attempt: 1 } })),
  },
  log: { warn: vi.fn() },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: async () => null,
  resolveSlackBotTokenForSlackChannel: async () => null,
  resolveSlackConfig: async () => ({
    botToken: null,
    clientId: null,
    clientSecret: null,
    signingSecret: null,
  }),
  resolveWorkflowDefaults: async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  }),
}));

vi.mock('../lib/slackNotify.js', () => ({
  notifySlackRunComplete: vi.fn(),
  notifySlackStepFailure: vi.fn(),
  postSlackThreadMessage: vi.fn(),
}));

vi.mock('../lib/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/metrics.js')>()),
  recordRunFinalized: vi.fn(),
}));

vi.mock('@auto-swe/shared/lib/trackerSync', () => ({
  syncTrackerOnEvent: vi.fn(),
}));

// Covered by its own suite; here only the wiring into createWorkflowRun.
vi.mock('./scheduledFireAuthorization.js', () => ({
  assertScheduledFireAuthorized: vi.fn(async () => undefined),
}));

vi.mock('@auto-swe/shared/db', () => {
  const prisma = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn((arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (typeof arg === 'function') {
        return arg(prisma);
      }
      return undefined;
    }),
    activeWorkflow: {
      // The run's tenant is derived from here as well as from RunInput, because
      // the Slack and scheduled launch paths carry the repo only on this row.
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ budgetTier: 'LARGE' })),
      updateMany: vi.fn(),
      upsert: vi.fn(async () => ({})),
    },
    agent: {
      findMany: vi.fn(),
    },
    agentTrace: {
      aggregate: vi.fn(),
    },
    autonomyDecision: {
      findMany: vi.fn(async () => []),
    },
    // Backs the config registry: no rows means every setting resolves to its
    // definition default, i.e. the constant it replaced.
    configSetting: { findMany: vi.fn(async () => []) },
    connection: {
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(),
    },
    evalResult: {
      findMany: vi.fn(async () => []),
    },
    orgMonthlyUsage: {
      upsert: vi.fn(),
    },
    pullRequest: {
      findFirst: vi.fn(),
    },
    runInput: {
      findUnique: vi.fn(async () => null),
    },
    // Run-start skill-revision snapshot: no skills means an empty pin map.
    skill: {
      findMany: vi.fn(async () => []),
    },
    slackChannel: { findFirst: vi.fn(async () => null) },
    team: { findUnique: vi.fn() },
    workflowHumanStep: {
      count: vi.fn(async () => 0),
    },
    workflowOutcomeReference: {
      findFirst: vi.fn(async () => null),
    },
    workflowRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(),
    },
    workflowStep: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    workflowTemplate: {
      findFirst: vi.fn(),
    },
    workflowTemplateVersion: {
      findUnique: vi.fn(),
    },
  };
  return { prisma };
});

import { prisma } from '@auto-swe/shared/db';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import { recordRunFinalized } from '../lib/metrics.js';
import { notifySlackRunComplete, notifySlackStepFailure } from '../lib/slackNotify.js';
import { assertScheduledFireAuthorized } from './scheduledFireAuthorization.js';
import {
  buildChannelTaskResultText,
  createWorkflowRun,
  finalizeWorkflowRun,
  recordWorkflowStep,
  resolveTemplateForRepo,
} from './templates.js';

const findVersion = vi.mocked(prisma.workflowTemplateVersion.findUnique);
const upsertRun = vi.mocked(prisma.workflowRun.upsert);

const updateManyRuns = vi.mocked(prisma.workflowRun.updateMany);
const upsertStep = vi.mocked(prisma.workflowStep.upsert);
const orgMonthlyUsageUpsert = vi.mocked(prisma.orgMonthlyUsage.upsert);
const findRepo = vi.mocked(prisma.connection.findUniqueOrThrow);
const findTemplate = vi.mocked(prisma.workflowTemplate.findFirst);
const findAgents = vi.mocked(prisma.agent.findMany);
const findSkills = vi.mocked(prisma.skill.findMany);
const aggregateTraces = vi.mocked(prisma.agentTrace.aggregate);

// Default: repo-less finalize paths (no activeWorkflows) fall back to summing the
// run's AgentTrace cost/tokens. Most finalize tests don't exercise that ledger, so
// a zero-sum default keeps their cost assertions intact.
beforeEach(() => {
  aggregateTraces.mockResolvedValue({
    _sum: { costUsd: null, inputTokens: null, outputTokens: null },
  } as never);
  vi.mocked(prisma.$transaction).mockReset();
});

const validSpec = {
  description: '',
  entry: 'a',
  name: 't',
  nodes: { a: { status: 'SUCCESS' as const, type: 'terminate' as const } },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

afterEach(() => {
  findVersion.mockReset();
  upsertRun.mockReset();
  updateManyRuns.mockReset();
  updateManyRuns.mockReset();
  upsertStep.mockReset();
  orgMonthlyUsageUpsert.mockReset();
  findRepo.mockReset();
  findTemplate.mockReset();
  findAgents.mockReset();
  findSkills.mockClear();
  aggregateTraces.mockReset();
});

describe('createWorkflowRun', () => {
  beforeEach(() => {
    upsertRun.mockResolvedValue({ id: 'run-1' } as never);
    findAgents.mockResolvedValue([
      { key: 'implementer', version: 1 },
      { key: 'reviewer', version: 2 },
    ] as never);
  });

  it('re-takes a scheduled fire’s launch decision first, and a refusal stops the run', async () => {
    const assertFire = vi.mocked(assertScheduledFireAuthorized);
    assertFire.mockRejectedValueOnce(new Error('scheduled fire refused: owner left the team'));
    findVersion.mockClear();
    const input = {
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'sched-row-1-2026-09-24T14:00:00Z',
      workRequestId: 'wr-1',
    };
    await expect(createWorkflowRun(input)).rejects.toThrow(/owner left the team/);
    expect(assertFire).toHaveBeenCalledWith(input);
    // Refused before any row is written or template loaded.
    expect(findVersion).not.toHaveBeenCalled();
    expect(upsertRun).not.toHaveBeenCalled();
  });

  it('links an epic child run to its own repository, and no other run', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    upsertRun.mockClear();
    await createWorkflowRun({
      parentWorkflowId: 'epic-T-1',
      repoId: 'repo-b',
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'epic-T-1-repo-b',
      workRequestId: 'wr-epic',
    });
    expect(upsertRun.mock.calls.at(-1)?.[0].create).toMatchObject({ connectionId: 'repo-b' });

    await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-plain',
      workRequestId: 'wr-1',
    });
    expect(upsertRun.mock.calls.at(-1)?.[0].create).not.toHaveProperty('connectionId');
  });

  describe('retired installation', () => {
    const findRunInput = vi.mocked(prisma.runInput.findUnique);

    beforeEach(() => {
      // The pass-through cases must actually get past the installation check
      // and load a template, or "no error" would be true for the wrong reason.
      findVersion.mockResolvedValue({ spec: validSpec } as never);
    });

    function connection(isActive: boolean | null) {
      return {
        connection: {
          installation: isActive === null ? null : { isActive },
          organizationName: 'acme',
          repoName: 'payments',
        },
      };
    }

    it('refuses to start a run whose repository points at a retired installation', async () => {
      // Not every run starts at the gateway. A scheduled work request's Temporal
      // Schedule starts this workflow directly, so a schedule created before
      // retirement would otherwise keep pushing indefinitely. The same is true
      // of the channel assistant's code task.
      findRunInput.mockResolvedValue(connection(false) as never);
      const result = await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      });
      expect(result).toEqual({
        error: expect.stringContaining('acme/payments'),
      });
      expect((result as { error: string }).error).toContain('retired');
      // Refused before the template is even loaded.
      expect(findVersion).not.toHaveBeenCalled();
    });

    it('refuses an epic child whose own repository points at a retired installation', async () => {
      // An epic child's work request is the epic's and names no connection, so
      // the check must read the child's own repository.
      findRunInput.mockResolvedValue(null as never);
      vi.mocked(prisma.connection.findUnique).mockResolvedValueOnce(
        connection(false).connection as never
      );
      const result = await createWorkflowRun({
        parentWorkflowId: 'epic-T-1',
        repoId: 'repo-b',
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'epic-T-1-repo-b',
        workRequestId: 'wr-epic',
      });
      expect((result as { error: string }).error).toContain('retired');
      expect(prisma.connection.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'repo-b' } })
      );
    });

    it('starts normally through a live installation', async () => {
      // The discriminating case: if the test above passed because ANY
      // installation refused, this would fail.
      findRunInput.mockResolvedValue(connection(true) as never);
      const result = await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      });
      expect(result).not.toHaveProperty('error');
      expect(findVersion).toHaveBeenCalled();
    });

    it('starts normally when the repository uses the default installation', async () => {
      // A null installation means the singleton's, which cannot be retired
      // through this flag — treating it as retired would stop every run on a
      // single-organization deployment.
      findRunInput.mockResolvedValue(connection(null) as never);
      const result = await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      });
      expect(result).not.toHaveProperty('error');
    });

    it('starts normally for a run with no work request at all', async () => {
      // Cleared explicitly: the assertion below is about THIS call, and mocks
      // accumulate across the cases above.
      findRunInput.mockClear();
      findRunInput.mockResolvedValue(null as never);
      const result = await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-1',
      });
      expect(result).not.toHaveProperty('error');
      expect(findRunInput).not.toHaveBeenCalled();
    });
  });

  it('snapshots the active GLOBAL Agent versions onto the run', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    await createWorkflowRun({ templateId: 'tpl-1', templateVersion: 1, workflowId: 'wf-1' });
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((args.create as Record<string, unknown>).agentVersions).toEqual({
      implementer: 1,
      reviewer: 2,
    });
  });

  it('snapshots the current revision of every skill visible to the run, keyed by skill id', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    findSkills.mockResolvedValueOnce([
      { currentRevision: 3, id: 'skill-a' },
      { currentRevision: 1, id: 'skill-b' },
    ] as never);
    await createWorkflowRun({ templateId: 'tpl-1', templateVersion: 1, workflowId: 'wf-1' });
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, Record<string, unknown>>;
    expect(args.create.skillRevisions).toEqual({ 'skill-a': 3, 'skill-b': 1 });
    expect(args.update).toEqual({});
  });

  it('scopes the skill snapshot to GLOBAL plus the run’s own team and organization', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    const findRunInput = vi.mocked(prisma.runInput.findUnique);
    findRunInput.mockResolvedValue({
      connection: { team: { orgId: 'org-9' }, teamId: 'team-9' },
    } as never);
    try {
      await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      });
    } finally {
      findRunInput.mockResolvedValue(null as never);
    }
    expect(findSkills.mock.calls[0]?.[0]?.where).toEqual({
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'TEAM', teamId: 'team-9' },
        { orgId: 'org-9', scope: 'ORGANIZATION' },
      ],
    });
  });

  it('pins a repo-less channel task’s skills at the tenant of its Slack channel', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    const findRunInput = vi.mocked(prisma.runInput.findUnique);
    const findChannel = vi.mocked(prisma.slackChannel.findFirst);
    // No connection, so the settings context finds no team; the request names a channel.
    findRunInput.mockImplementation((async (args: { select: Record<string, unknown> }) =>
      'slackChannelId' in args.select && Object.keys(args.select).length === 1
        ? { slackChannelId: 'C123' }
        : null) as never);
    findChannel.mockResolvedValueOnce({ orgId: 'org-c', teamId: 'team-c' } as never);
    try {
      await createWorkflowRun({
        templateId: 'tpl-1',
        templateVersion: 1,
        workflowId: 'wf-chan',
        workRequestId: 'wr-chan',
      });
    } finally {
      findRunInput.mockReset();
      findRunInput.mockResolvedValue(null as never);
    }
    expect(findChannel.mock.calls[0]?.[0]?.where).toEqual({ slackChannelId: 'C123' });
    expect(findSkills.mock.calls[0]?.[0]?.where).toEqual({
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'TEAM', teamId: 'team-c' },
        { orgId: 'org-c', scope: 'ORGANIZATION' },
      ],
    });
  });

  it('records who launched this execution, and which execution, on create only', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    await createWorkflowRun({
      launchedById: 'user-1',
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
    });
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, Record<string, unknown>>;
    expect(args.create).toMatchObject({
      launchedById: 'user-1',
      temporalRunId: 'temporal-run-1',
    });
    // Never rewritten: a row left by an earlier execution of a reused workflow
    // id must keep naming that execution, so its launcher is not inherited.
    expect(args.update).toEqual({});
  });

  it('records no launcher for a run started by nobody', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    await createWorkflowRun({ templateId: 'tpl-1', templateVersion: 1, workflowId: 'wf-1' });
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, Record<string, unknown>>;
    expect(args.create.launchedById).toBeNull();
  });

  it('returns an error when the template version is missing', async () => {
    findVersion.mockResolvedValue(null as never);
    const out = await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
    });
    expect('error' in out && out.error).toMatch(/template tpl-1@v1 not found/);
    expect(upsertRun).not.toHaveBeenCalled();
  });

  it('returns an error when the stored spec is malformed', async () => {
    findVersion.mockResolvedValue({
      spec: { nodes: {}, schemaVersion: SPEC_SCHEMA_VERSION }, // no entry, no name
    } as never);
    const out = await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
    });
    expect('error' in out).toBe(true);
    expect(upsertRun).not.toHaveBeenCalled();
  });

  describe('epic child ledger row', () => {
    const child = {
      parentWorkflowId: 'epic-1',
      repoId: 'repo-1',
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-child-1',
      workRequestId: undefined,
    };

    it("writes the child's ledger row, inheriting the epic's budget tier", async () => {
      findVersion.mockResolvedValue({ spec: validSpec } as never);
      vi.mocked(prisma.activeWorkflow.upsert).mockClear();
      await createWorkflowRun(child);
      expect(prisma.activeWorkflow.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            budgetTier: 'LARGE',
            currentStatus: 'STARTING',
            parentWorkflowId: 'epic-1',
            temporalWorkflowId: 'wf-child-1',
          }),
        })
      );
    });

    it('writes no ledger row when the template cannot be resolved', async () => {
      // A row written before this return would sit in STARTING forever.
      findVersion.mockResolvedValue(null as never);
      vi.mocked(prisma.activeWorkflow.upsert).mockClear();
      const out = await createWorkflowRun(child);
      expect('error' in out).toBe(true);
      expect(prisma.activeWorkflow.upsert).not.toHaveBeenCalled();
    });

    it('writes no ledger row when the stored spec is malformed', async () => {
      findVersion.mockResolvedValue({
        spec: { nodes: {}, schemaVersion: SPEC_SCHEMA_VERSION },
      } as never);
      vi.mocked(prisma.activeWorkflow.upsert).mockClear();
      const out = await createWorkflowRun(child);
      expect('error' in out).toBe(true);
      expect(prisma.activeWorkflow.upsert).not.toHaveBeenCalled();
    });
  });

  it('migrates a stored v1 spec via the registered codemod chain', async () => {
    findVersion.mockResolvedValue({
      // Stored at v1; the built-in v1→v2 codemod bumps schemaVersion only.
      spec: { ...validSpec, schemaVersion: 1 },
    } as never);
    const out = await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
    });
    expect('runId' in out && out.runId).toBe('run-1');
    expect('spec' in out && out.spec.schemaVersion).toBe(SPEC_SCHEMA_VERSION);
  });

  it('returns the persisted spec snapshot, not the freshly parsed template spec', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    const storedSpec = { ...validSpec, name: 'stored-version' };
    upsertRun.mockResolvedValue({ id: 'run-1', specSnapshot: storedSpec } as never);
    const out = await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
    });
    expect('spec' in out && out.spec.name).toBe('stored-version');
  });

  it('upserts by workflowId so a retried Temporal execution does not duplicate', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    await createWorkflowRun({
      templateId: 'tpl-1',
      templateVersion: 1,
      workflowId: 'wf-1',
      workRequestId: 'wr-1',
    });
    expect(upsertRun).toHaveBeenCalledTimes(1);
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toEqual({ workflowId: 'wf-1' });
    expect(args.update).toEqual({});
    expect((args.create as Record<string, unknown>).workflowId).toBe('wf-1');
    expect((args.create as Record<string, unknown>).workRequestId).toBe('wr-1');
  });
});

describe('recordWorkflowStep', () => {
  it('sets endedAt only for terminal statuses', async () => {
    upsertStep.mockResolvedValue({} as never);
    await recordWorkflowStep({ nodeId: 'a', runId: 'r1', status: 'RUNNING' });
    const argsRunning = upsertStep.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    expect(argsRunning.endedAt).toBeNull();

    await recordWorkflowStep({ nodeId: 'a', runId: 'r1', status: 'PASSED' });
    const argsPassed = upsertStep.mock.calls[1]?.[0]?.create as Record<string, unknown>;
    expect(argsPassed.endedAt).toBeInstanceOf(Date);
  });

  it('records the attempt number on retried steps', async () => {
    upsertStep.mockResolvedValue({} as never);
    await recordWorkflowStep({ attempt: 3, nodeId: 'a', runId: 'r1', status: 'FAILED' });
    const args = upsertStep.mock.calls[0]?.[0]?.create as Record<string, unknown>;
    expect(args.attempt).toBe(3);
  });

  it('uses the (runId, nodeId, attempt) unique key for idempotent upsert', async () => {
    upsertStep.mockResolvedValue({} as never);
    await recordWorkflowStep({ attempt: 1, nodeId: 'a', runId: 'r1', status: 'PASSED' });
    expect(upsertStep).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId_nodeId_attempt: { attempt: 1, nodeId: 'a', runId: 'r1' } },
      })
    );
  });

  it('does not re-notify Slack on Temporal activity retries of a failed step', async () => {
    const notify = vi.mocked(notifySlackStepFailure);
    notify.mockClear();
    upsertStep.mockResolvedValue({} as never);
    const context = vi.mocked(Context);
    context.current.mockReturnValue({ info: { attempt: 2 } } as never);
    await recordWorkflowStep({ nodeId: 'a', runId: 'r1', status: 'FAILED' });
    expect(notify).not.toHaveBeenCalled();
    context.current.mockReturnValue({ info: { attempt: 1 } } as never);
  });
});

describe('finalizeWorkflowRun', () => {
  it('writes status + endedAt + denormalized cost to the run row', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    findRun.mockResolvedValue({
      workRequest: {
        activeWorkflows: [{ costUsdAccrued: 1.5 }, { costUsdAccrued: 0.5 }],
      },
    } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);
    await finalizeWorkflowRun('run-1', 'SUCCESS', { foo: 'bar' });
    const args = updateManyRuns.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toEqual({ endedAt: null, id: 'run-1', status: { not: 'CANCELLED' } });
    const data = args.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    expect(data.endedAt).toBeInstanceOf(Date);
    expect(data.contextSnapshot).toEqual({ foo: 'bar' });
    // Phase 8 denorm: sums across activeWorkflows for the WorkRequest.
    expect(data.costUsdAccrued).toBe(2);
    findRun.mockReset();
  });

  it('writes zero cost when there is no work request attached', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    findRun.mockResolvedValue({ workRequest: null } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);
    await finalizeWorkflowRun('run-2', 'FAILED');
    const args = updateManyRuns.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const data = args.data as Record<string, unknown>;
    expect(data.costUsdAccrued).toBe(0);
    findRun.mockReset();
  });

  it('writes the terminal status back to the ActiveWorkflow row', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const updateActive = vi.mocked(prisma.activeWorkflow.updateMany);
    findRun.mockResolvedValue({ workflowId: 'eng-acme-repo-T-1', workRequest: null } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);
    updateActive.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-3', 'FAILED');
    expect(updateActive).toHaveBeenCalledWith({
      data: { currentStatus: 'FAILED' },
      where: { temporalWorkflowId: 'eng-acme-repo-T-1' },
    });

    await finalizeWorkflowRun('run-3', 'SUCCESS');
    expect(updateActive).toHaveBeenLastCalledWith({
      data: { currentStatus: 'COMPLETED' },
      where: { temporalWorkflowId: 'eng-acme-repo-T-1' },
    });

    findRun.mockReset();
    updateActive.mockReset();
  });

  it('leaves the ActiveWorkflow row untouched for SKIPPED runs', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const updateActive = vi.mocked(prisma.activeWorkflow.updateMany);
    findRun.mockResolvedValue({ workflowId: 'eng-acme-repo-T-2', workRequest: null } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-4', 'SKIPPED');
    expect(updateActive).not.toHaveBeenCalled();

    findRun.mockReset();
    updateActive.mockReset();
  });

  it('aggregates org usage in a transaction on first finalize (SUCCESS counts a run)', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const tx = vi.mocked(prisma.$transaction);
    const updateMany = vi.mocked(prisma.workflowRun.updateMany);
    const orgUpsert = vi.mocked(prisma.orgMonthlyUsage.upsert);
    findRun.mockResolvedValue({
      endedAt: null, // not yet finalized → bill
      workRequest: {
        activeWorkflows: [{ costUsdAccrued: 2, tokensInputUsed: 100n, tokensOutputUsed: 50n }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-5', 'SUCCESS');

    expect(tx).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { endedAt: null } });
    expect(orgUpsert).toHaveBeenCalledTimes(1);
    const args = orgUpsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(args.create.runsCompleted).toBe(1);
    expect(args.create.costUsdAccrued).toBe(2);
    expect(args.update.runsCompleted).toEqual({ increment: 1 });
    expect((args.where.orgId_yearMonth as { orgId: string }).orgId).toBe('org-1');

    findRun.mockReset();
    tx.mockReset();
    updateMany.mockReset();
    orgUpsert.mockReset();
  });

  it('does not count a run for non-SUCCESS terminal status but still accrues cost', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const orgUpsert = vi.mocked(prisma.orgMonthlyUsage.upsert);
    findRun.mockResolvedValue({
      endedAt: null,
      workRequest: {
        activeWorkflows: [{ costUsdAccrued: 3, tokensInputUsed: 10n, tokensOutputUsed: 5n }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-6', 'FAILED');

    const args = orgUpsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.create.runsCompleted).toBe(0);
    expect(args.create.costUsdAccrued).toBe(3);
    expect(args.update.runsCompleted).toEqual({ increment: 0 });

    findRun.mockReset();
    orgUpsert.mockReset();
  });

  it('bills a dashboard-cancelled run to the org once and keeps it CANCELLED', async () => {
    // The cancel route set CANCELLED and left endedAt null, so the run stayed
    // in flight for the org cap until this write moves its spend across.
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const orgUpsert = vi.mocked(prisma.orgMonthlyUsage.upsert);
    const updateActive = vi.mocked(prisma.activeWorkflow.updateMany);
    const notify = vi.mocked(notifySlackRunComplete);
    const recorded = vi.mocked(recordRunFinalized);
    orgUpsert.mockClear();
    updateActive.mockClear();
    notify.mockClear();
    recorded.mockClear();
    findRun.mockResolvedValue({
      endedAt: null,
      workflowId: 'eng-acme-repo-T-9',
      workRequest: {
        activeWorkflows: [
          {
            costUsdAccrued: 4,
            temporalWorkflowId: 'eng-acme-repo-T-9',
            tokensInputUsed: 7n,
            tokensOutputUsed: 3n,
          },
        ],
        connection: { team: { orgId: 'org-1' } },
        payload: null,
      },
    } as never);
    // The first write skips a cancelled row; the second ends it.
    updateManyRuns.mockResolvedValueOnce({ count: 0 } as never);
    updateManyRuns.mockResolvedValueOnce({ count: 1 } as never);

    // A cancel that landed after the spec finished: the workflow reports SUCCESS.
    await finalizeWorkflowRun('run-cancelled', 'SUCCESS');

    const ended = updateManyRuns.mock.calls[1]?.[0] as {
      data: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(ended.where).toEqual({ endedAt: null, id: 'run-cancelled', status: 'CANCELLED' });
    expect(ended.data.status).toBe('CANCELLED');
    expect(ended.data.endedAt).toBeInstanceOf(Date);
    expect(orgUpsert).toHaveBeenCalledTimes(1);
    const usage = orgUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(usage.create.costUsdAccrued).toBe(4);
    expect(usage.create.runsCompleted).toBe(0);
    expect(updateActive).toHaveBeenCalledWith({
      data: { currentStatus: 'CANCELLED' },
      where: { temporalWorkflowId: 'eng-acme-repo-T-9' },
    });
    expect(notify).toHaveBeenCalledWith({ runId: 'run-cancelled', status: 'CANCELLED' });
    // The cancel route counted the run when it cancelled it.
    expect(recorded).not.toHaveBeenCalled();

    findRun.mockReset();
    orgUpsert.mockReset();
    updateActive.mockReset();
  });

  it('counts the run finalized when its own write ended it', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const recorded = vi.mocked(recordRunFinalized);
    recorded.mockClear();
    findRun.mockResolvedValue({ endedAt: null, workRequest: null } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-8', 'FAILED');

    expect(updateManyRuns).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledExactlyOnceWith('FAILED', 'worker');
    findRun.mockReset();
  });

  it('is a no-op on retry when the run was already finalized (idempotency)', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const tx = vi.mocked(prisma.$transaction);
    const orgUpsert = vi.mocked(prisma.orgMonthlyUsage.upsert);
    tx.mockClear();
    orgUpsert.mockClear();
    updateManyRuns.mockClear();
    findRun.mockResolvedValue({
      endedAt: new Date(), // already finalized by a prior attempt
      workRequest: {
        activeWorkflows: [{ costUsdAccrued: 2, tokensInputUsed: 100n, tokensOutputUsed: 50n }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-7', 'SUCCESS');

    expect(tx).not.toHaveBeenCalled();
    expect(orgUpsert).not.toHaveBeenCalled();
    expect(updateManyRuns).not.toHaveBeenCalled();

    findRun.mockReset();
    tx.mockReset();
    orgUpsert.mockReset();
  });

  it('skips notification + channel accrual + tracker sync on retry when already finalized', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const mockNotifySlack = vi.mocked(notifySlackRunComplete);
    const mockTrackerSync = vi.mocked(syncTrackerOnEvent);
    mockNotifySlack.mockClear();
    mockTrackerSync.mockClear();
    updateManyRuns.mockClear();
    findRun.mockResolvedValue({
      endedAt: new Date(), // already finalized by a prior attempt
      workflowId: 'eng-test-retry',
      workRequest: {
        activeWorkflows: [],
        externalTicketId: 'JIRA-123',
        payload: null, // not a channel task
        slackChannelId: null,
        slackMessageTs: null,
      },
    } as never);
    updateManyRuns.mockResolvedValue({ count: 1 } as never);

    await finalizeWorkflowRun('run-already-done', 'SUCCESS');

    // No side effects run on retry; the prior finalization is the source of truth.
    expect(updateManyRuns).not.toHaveBeenCalled();
    // But the three side effects do NOT fire on retry
    expect(mockNotifySlack).not.toHaveBeenCalled();
    expect(mockTrackerSync).not.toHaveBeenCalled();

    findRun.mockReset();
    mockNotifySlack.mockReset();
    mockTrackerSync.mockReset();
  });
});

describe('buildChannelTaskResultText', () => {
  it('says why a task failed when the cause was a refused model call', () => {
    const text = buildChannelTaskResultText(
      null,
      'FAILED',
      'Summarise',
      'Model "x/y" has no price in the model catalog. Add the model to the model catalog.'
    );
    expect(text).toContain('finished with status *FAILED*');
    expect(text).toContain('has no price in the model catalog');
  });

  it('keeps the plain line when there is no reason', () => {
    expect(buildChannelTaskResultText(null, 'FAILED', undefined)).toBe(
      ':rotating_light: Task finished with status *FAILED*.'
    );
  });
});

describe('resolveTemplateForRepo', () => {
  beforeEach(() => {
    findRepo.mockResolvedValue({ teamId: 'team-1' } as never);
  });

  it('prefers the team default over the global default', async () => {
    findTemplate.mockResolvedValueOnce({ activeVersion: 4, id: 'team-tpl' } as never);
    const out = await resolveTemplateForRepo('repo-1');
    expect(out).toEqual({ templateId: 'team-tpl', templateVersion: 4 });
    // No fallback query needed.
    expect(findTemplate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the global default when no team default exists', async () => {
    findTemplate
      .mockResolvedValueOnce(null as never) // team-scoped lookup
      .mockResolvedValueOnce({ activeVersion: 1, id: 'global-tpl' } as never);
    const out = await resolveTemplateForRepo('repo-1');
    expect(out).toEqual({ templateId: 'global-tpl', templateVersion: 1 });
    expect(findTemplate).toHaveBeenCalledTimes(2);
  });

  it('throws when neither a team nor global default is configured', async () => {
    findTemplate.mockResolvedValue(null as never);
    await expect(resolveTemplateForRepo('repo-1')).rejects.toThrow(
      /no active default workflow template/
    );
  });

  it('throws when the matched template has no activeVersion set', async () => {
    findTemplate.mockResolvedValueOnce({ activeVersion: null, id: 'tpl' } as never);
    await expect(resolveTemplateForRepo('repo-1')).rejects.toThrow(
      /no active default workflow template/
    );
  });
});
