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

vi.mock('@auto-swe/shared/lib/trackerSync', () => ({
  syncTrackerOnEvent: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => {
  const prisma = {
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
      updateMany: vi.fn(),
    },
    agent: {
      findMany: vi.fn(),
    },
    agentTrace: {
      aggregate: vi.fn(),
    },
    // Backs the config registry: no rows means every setting resolves to its
    // definition default, i.e. the constant it replaced.
    configSetting: { findMany: vi.fn(async () => []) },
    connection: {
      findUniqueOrThrow: vi.fn(),
    },
    orgMonthlyUsage: {
      upsert: vi.fn(),
    },
    autonomyDecision: {
      findMany: vi.fn(async () => []),
    },
    pullRequest: {
      findFirst: vi.fn(),
    },
    runInput: {
      findUnique: vi.fn(async () => null),
    },
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
import { notifySlackRunComplete, notifySlackStepFailure } from '../lib/slackNotify.js';
import {
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
const aggregateTraces = vi.mocked(prisma.agentTrace.aggregate);

// Default: repo-less finalize paths (no activeWorkflows) fall back to summing the
// run's AgentTrace cost/tokens. Most finalize tests don't exercise that ledger, so
// a zero-sum default keeps their cost assertions intact.
beforeEach(() => {
  aggregateTraces.mockResolvedValue({
    _sum: { costUsd: null, inputTokens: null, outputTokens: null },
  } as never);
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

  it('snapshots the active GLOBAL Agent versions onto the run', async () => {
    findVersion.mockResolvedValue({ spec: validSpec } as never);
    await createWorkflowRun({ templateId: 'tpl-1', templateVersion: 1, workflowId: 'wf-1' });
    const args = upsertRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((args.create as Record<string, unknown>).agentVersions).toEqual({
      implementer: 1,
      reviewer: 2,
    });
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
    expect(args.where).toEqual({ endedAt: null, id: 'run-1' });
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
    updateManyRuns.mockResolvedValue({} as never);
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
    updateManyRuns.mockResolvedValue({} as never);
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
    updateManyRuns.mockResolvedValue({} as never);

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
        activeWorkflows: [{ costUsdAccrued: 2, tokensInputUsed: 100, tokensOutputUsed: 50 }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({} as never);

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
        activeWorkflows: [{ costUsdAccrued: 3, tokensInputUsed: 10, tokensOutputUsed: 5 }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({} as never);

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
        activeWorkflows: [{ costUsdAccrued: 2, tokensInputUsed: 100, tokensOutputUsed: 50 }],
        connection: { team: { orgId: 'org-1' } },
      },
    } as never);
    updateManyRuns.mockResolvedValue({} as never);

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
    updateManyRuns.mockResolvedValue({} as never);

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
