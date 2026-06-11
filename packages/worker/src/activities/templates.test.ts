import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
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

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: {
      updateMany: vi.fn(),
    },
    repository: {
      findUniqueOrThrow: vi.fn(),
    },
    team: { findUnique: vi.fn() },
    workflowRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    workflowStep: {
      create: vi.fn(),
    },
    workflowTemplate: {
      findFirst: vi.fn(),
    },
    workflowTemplateVersion: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import {
  createWorkflowRun,
  finalizeWorkflowRun,
  recordWorkflowStep,
  resolveTemplateForRepo,
} from './templates.js';

const findVersion = vi.mocked(prisma.workflowTemplateVersion.findUnique);
const upsertRun = vi.mocked(prisma.workflowRun.upsert);
const updateRun = vi.mocked(prisma.workflowRun.update);
const createStep = vi.mocked(prisma.workflowStep.create);
const findRepo = vi.mocked(prisma.repository.findUniqueOrThrow);
const findTemplate = vi.mocked(prisma.workflowTemplate.findFirst);

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
  updateRun.mockReset();
  createStep.mockReset();
  findRepo.mockReset();
  findTemplate.mockReset();
});

describe('createWorkflowRun', () => {
  beforeEach(() => {
    upsertRun.mockResolvedValue({ id: 'run-1' } as never);
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
    createStep.mockResolvedValue({} as never);
    await recordWorkflowStep({ nodeId: 'a', runId: 'r1', status: 'RUNNING' });
    const argsRunning = createStep.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(argsRunning.endedAt).toBeNull();

    await recordWorkflowStep({ nodeId: 'a', runId: 'r1', status: 'PASSED' });
    const argsPassed = createStep.mock.calls[1]?.[0]?.data as Record<string, unknown>;
    expect(argsPassed.endedAt).toBeInstanceOf(Date);
  });

  it('records the attempt number on retried steps', async () => {
    createStep.mockResolvedValue({} as never);
    await recordWorkflowStep({ attempt: 3, nodeId: 'a', runId: 'r1', status: 'FAILED' });
    const args = createStep.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(args.attempt).toBe(3);
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
    updateRun.mockResolvedValue({} as never);
    await finalizeWorkflowRun('run-1', 'SUCCESS', { foo: 'bar' });
    const args = updateRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.where).toEqual({ id: 'run-1' });
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
    updateRun.mockResolvedValue({} as never);
    await finalizeWorkflowRun('run-2', 'FAILED');
    const args = updateRun.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const data = args.data as Record<string, unknown>;
    expect(data.costUsdAccrued).toBe(0);
    findRun.mockReset();
  });

  it('writes the terminal status back to the ActiveWorkflow row', async () => {
    const findRun = vi.mocked(prisma.workflowRun.findUnique);
    const updateActive = vi.mocked(prisma.activeWorkflow.updateMany);
    findRun.mockResolvedValue({ workflowId: 'eng-acme-repo-T-1', workRequest: null } as never);
    updateRun.mockResolvedValue({} as never);
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
    updateRun.mockResolvedValue({} as never);

    await finalizeWorkflowRun('run-4', 'SKIPPED');
    expect(updateActive).not.toHaveBeenCalled();

    findRun.mockReset();
    updateActive.mockReset();
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
