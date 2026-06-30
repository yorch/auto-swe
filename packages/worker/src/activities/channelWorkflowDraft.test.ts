import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tplCreate } = vi.hoisted(() => ({ tplCreate: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowTemplate: { create: tplCreate } },
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('./generateWorkflowSpec.js', () => ({ generateWorkflowSpec: vi.fn() }));

import { createChannelWorkflowDraft } from './channelWorkflowDraft.js';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';

const mockedGenerate = vi.mocked(generateWorkflowSpec);

const SPEC: WorkflowSpec = {
  description: 'demo',
  entry: 'done',
  name: 'Auto Name',
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createChannelWorkflowDraft', () => {
  it('generates a spec and persists a DRAFT scoped to the team', async () => {
    mockedGenerate.mockResolvedValue({ attempts: 1, spec: { ...SPEC }, summary: 'does a thing' });
    tplCreate.mockResolvedValue({ id: 'tpl-1' });

    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'build me a flow',
      teamId: 'team-1',
    });

    expect(result).toEqual({ name: 'Auto Name', summary: 'does a thing', templateId: 'tpl-1' });
    // allowShell is false for channel-authored drafts.
    expect(mockedGenerate).toHaveBeenCalledWith({
      allowShell: false,
      prompt: 'build me a flow',
      teamId: 'team-1',
    });
    const createArg = tplCreate.mock.calls[0][0];
    expect(createArg.data.status).toBe('DRAFT');
    expect(createArg.data.teamId).toBe('team-1');
    expect(createArg.data.versions.create.version).toBe(1);
  });

  it('honors a name override', async () => {
    mockedGenerate.mockResolvedValue({ attempts: 1, spec: { ...SPEC }, summary: '' });
    tplCreate.mockResolvedValue({ id: 'tpl-2' });

    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'x',
      name: 'My Name',
      teamId: 'team-1',
    });

    expect(result?.name).toBe('My Name');
    expect(tplCreate.mock.calls[0][0].data.name).toBe('My Name');
  });

  it('retries with a suffix when the name collides', async () => {
    mockedGenerate.mockResolvedValue({ attempts: 1, spec: { ...SPEC }, summary: '' });
    tplCreate.mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'tpl-3' });

    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'x',
      teamId: 'team-1',
    });

    expect(result?.name).toBe('Auto Name (2)');
    expect(tplCreate).toHaveBeenCalledTimes(2);
  });

  it('refuses a draft containing a shell node (channel path is not shell-authorized)', async () => {
    const shellSpec: WorkflowSpec = {
      ...SPEC,
      entry: 'sh',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: { command: 'echo hi', image: 'alpine', next: 'done', type: 'shell' },
      },
    };
    mockedGenerate.mockResolvedValue({ attempts: 1, spec: shellSpec, summary: '' });

    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'run a shell command',
      teamId: 'team-1',
    });

    expect(result).toBeNull();
    expect(tplCreate).not.toHaveBeenCalled();
  });

  it('clamps a long suffixed name to the 120-char spec cap', async () => {
    const longName = 'A'.repeat(120);
    mockedGenerate.mockResolvedValue({ attempts: 1, spec: { ...SPEC }, summary: '' });
    tplCreate.mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'tpl-9' });

    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'x',
      name: longName,
      teamId: 'team-1',
    });

    expect(result).not.toBeNull();
    expect(result?.name.length).toBeLessThanOrEqual(120);
    expect(result?.name.endsWith(' (2)')).toBe(true);
  });

  it('returns null (best-effort) when generation throws', async () => {
    mockedGenerate.mockRejectedValue(new Error('no valid spec'));
    const result = await createChannelWorkflowDraft({
      channelId: 'c1',
      description: 'x',
      teamId: 'team-1',
    });
    expect(result).toBeNull();
  });
});
