import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tplCreate } = vi.hoisted(() => ({ tplCreate: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowTemplate: { create: tplCreate } },
}));

import { persistDraftTemplate } from './persistDraftTemplate.js';

const SPEC: WorkflowSpec = {
  description: 'demo',
  entry: 'done',
  name: 'Auto Name',
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

beforeEach(() => vi.clearAllMocks());

describe('persistDraftTemplate', () => {
  it('persists a DRAFT and returns the id + name', async () => {
    tplCreate.mockResolvedValue({ id: 'tpl-1' });
    const result = await persistDraftTemplate({ spec: { ...SPEC }, teamId: 'team-1' });
    expect(result).toEqual({ name: 'Auto Name', templateId: 'tpl-1' });
    expect(tplCreate.mock.calls[0][0].data.status).toBe('DRAFT');
  });

  it('refuses a spec with shell/containerStep nodes', async () => {
    const shellSpec: WorkflowSpec = {
      ...SPEC,
      entry: 'sh',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        sh: { command: 'echo hi', image: 'alpine', next: 'done', type: 'shell' },
      },
    };
    const result = await persistDraftTemplate({ spec: shellSpec, teamId: 'team-1' });
    expect(result).toBeNull();
    expect(tplCreate).not.toHaveBeenCalled();
  });

  it('retries with a suffix on a name collision, clamped to 120 chars', async () => {
    const longName = 'A'.repeat(130);
    tplCreate.mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'tpl-2' });
    const result = await persistDraftTemplate({
      name: longName,
      spec: { ...SPEC },
      teamId: 'team-1',
    });
    expect(result?.name.length).toBeLessThanOrEqual(120);
    expect(result?.name.endsWith(' (2)')).toBe(true);
  });

  it('accepts a null team (global draft)', async () => {
    tplCreate.mockResolvedValue({ id: 'tpl-g' });
    await persistDraftTemplate({ spec: { ...SPEC }, teamId: null });
    expect(tplCreate.mock.calls[0][0].data.teamId).toBeNull();
  });
});
