import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionFindUnique, tplFindUnique, versionFindFirst, versionCreate } = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  tplFindUnique: vi.fn(),
  versionCreate: vi.fn(),
  versionFindFirst: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    channelThreadSession: { findUnique: sessionFindUnique },
    workflowTemplate: { findUnique: tplFindUnique },
    workflowTemplateVersion: { create: versionCreate, findFirst: versionFindFirst },
  },
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('./generateWorkflowSpec.js', () => ({ generateWorkflowSpec: vi.fn() }));

import { refineChannelWorkflowDraft } from './channelWorkflowRefine.js';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';

const mockedGenerate = vi.mocked(generateWorkflowSpec);

const BASE_SPEC: WorkflowSpec = {
  description: 'demo',
  entry: 'done',
  name: 'My Flow',
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

const INPUT = {
  channelId: 'c1',
  instruction: 'add a lint step',
  teamId: 'team-1',
  threadTs: '1.1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refineChannelWorkflowDraft', () => {
  it('returns no_target when the thread has no linked draft', async () => {
    sessionFindUnique.mockResolvedValue({ lastGeneratedTemplateId: null });
    const result = await refineChannelWorkflowDraft(INPUT);
    expect(result.status).toBe('no_target');
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('returns no_target when the linked template was deleted', async () => {
    sessionFindUnique.mockResolvedValue({ lastGeneratedTemplateId: 'tpl-1' });
    tplFindUnique.mockResolvedValue(null);
    const result = await refineChannelWorkflowDraft(INPUT);
    expect(result.status).toBe('no_target');
  });

  it('refines the latest version into a new version, pinning the template name', async () => {
    sessionFindUnique.mockResolvedValue({ lastGeneratedTemplateId: 'tpl-1' });
    tplFindUnique.mockResolvedValue({ id: 'tpl-1', name: 'My Flow', teamId: 'team-1' });
    // findFirst is called twice: latest spec, then max version for the append.
    versionFindFirst
      .mockResolvedValueOnce({ spec: BASE_SPEC, version: 1 })
      .mockResolvedValueOnce({ version: 1 });
    mockedGenerate.mockResolvedValue({
      attempts: 1,
      spec: { ...BASE_SPEC, name: 'model-renamed' },
      summary: 'added a lint step',
    });
    versionCreate.mockResolvedValue({ id: 'v2' });

    const result = await refineChannelWorkflowDraft(INPUT);

    expect(result).toEqual({
      name: 'My Flow',
      status: 'refined',
      summary: 'added a lint step',
      version: 2,
    });
    // Seeded with the current spec (refine mode) and shell disabled.
    expect(mockedGenerate).toHaveBeenCalledWith({
      allowShell: false,
      baseSpec: expect.objectContaining({ name: 'My Flow' }),
      prompt: 'add a lint step',
      teamId: 'team-1',
    });
    // The stored version pins the template name, not the model's rename.
    expect(versionCreate.mock.calls[0][0].data.spec.name).toBe('My Flow');
    expect(versionCreate.mock.calls[0][0].data.version).toBe(2);
  });

  it('refuses a refinement that introduces a shell node', async () => {
    sessionFindUnique.mockResolvedValue({ lastGeneratedTemplateId: 'tpl-1' });
    tplFindUnique.mockResolvedValue({ id: 'tpl-1', name: 'My Flow', teamId: 'team-1' });
    versionFindFirst.mockResolvedValueOnce({ spec: BASE_SPEC, version: 1 });
    mockedGenerate.mockResolvedValue({
      attempts: 1,
      spec: {
        ...BASE_SPEC,
        entry: 'sh',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          sh: { command: 'echo hi', image: 'alpine', next: 'done', type: 'shell' },
        },
      },
      summary: '',
    });

    const result = await refineChannelWorkflowDraft(INPUT);
    expect(result.status).toBe('failed');
    expect(versionCreate).not.toHaveBeenCalled();
  });

  it('returns failed (best-effort) when generation throws', async () => {
    sessionFindUnique.mockResolvedValue({ lastGeneratedTemplateId: 'tpl-1' });
    tplFindUnique.mockResolvedValue({ id: 'tpl-1', name: 'My Flow', teamId: 'team-1' });
    versionFindFirst.mockResolvedValueOnce({ spec: BASE_SPEC, version: 1 });
    mockedGenerate.mockRejectedValue(new Error('no valid spec'));

    const result = await refineChannelWorkflowDraft(INPUT);
    expect(result.status).toBe('failed');
  });
});
