import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  inActivity: { value: true },
  resolveAgent: vi.fn(),
  resolveSetting: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({ workflowExecution: { workflowId: 'wf-1' } }),
  asyncLocalStorage: { getStore: () => (h.inActivity.value ? {} : undefined) },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowRun: { findUnique: h.findUnique, updateMany: h.updateMany } },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: h.resolveSetting }));
vi.mock('./agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));

import { Prisma } from '@auto-swe/shared';
import { pinAgentRuntime, resolveAgentRuntime } from './agentRuntime.js';

const ctx = { teamId: 'team-1' };

/** A run row whose pin map the updateMany compare-and-set reads and writes. */
function runRow(initial: Record<string, unknown> | null) {
  const row = { agentRuntimes: initial, id: 'run-1' };
  h.findUnique.mockImplementation(async () => ({ ...row }));
  h.updateMany.mockImplementation(
    async ({
      data,
      where,
    }: {
      data: { agentRuntimes: unknown };
      where: { agentRuntimes: unknown };
    }) => {
      const expected = row.agentRuntimes
        ? { equals: row.agentRuntimes }
        : { equals: Prisma.DbNull };
      if (JSON.stringify(where.agentRuntimes) !== JSON.stringify(expected)) {
        return { count: 0 };
      }
      row.agentRuntimes = data.agentRuntimes as Record<string, unknown>;
      return { count: 1 };
    }
  );
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.inActivity.value = true;
  h.resolveAgent.mockResolvedValue({ runtime: null });
  h.resolveSetting.mockResolvedValue('mastra');
});

describe('resolveAgentRuntime', () => {
  it('uses the Agent’s own runtime over the setting, and pins it on the run', async () => {
    const row = runRow(null);
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });

    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');

    expect(r).toEqual({ runtime: 'claude-code', source: 'agent' });
    expect(h.resolveAgent).toHaveBeenCalledWith('implementer', ctx);
    expect(h.resolveSetting).not.toHaveBeenCalled();
    expect(row.agentRuntimes).toEqual({ implementer: 'claude-code' });
  });

  it('falls back to the run-pinned setting for the implementer family', async () => {
    runRow(null);
    h.resolveSetting.mockResolvedValue('claude-code');
    const r = await resolveAgentRuntime('ciFixer', ctx, 'implementerSetting');
    expect(r).toEqual({ runtime: 'claude-code', source: 'default' });
    expect(h.resolveSetting).toHaveBeenCalledWith('workspace.implementerRuntime', ctx);
  });

  it('falls back to Mastra for an agent run, whatever the setting says', async () => {
    runRow(null);
    h.resolveSetting.mockResolvedValue('claude-code');
    const r = await resolveAgentRuntime('contentWriter', ctx, 'mastra');
    expect(r).toEqual({ runtime: 'mastra', source: 'default' });
    expect(h.resolveSetting).not.toHaveBeenCalled();
  });

  it('keeps a pinned runtime after the agent changes mid-run', async () => {
    const row = runRow({ implementer: 'mastra' });
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });

    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');

    expect(r).toEqual({ runtime: 'mastra', source: 'run' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(row.agentRuntimes).toEqual({ implementer: 'mastra' });
  });

  it('adds a key to the map without disturbing the others', async () => {
    const row = runRow({ implementer: 'mastra' });
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });
    await resolveAgentRuntime('ciFixer', ctx, 'implementerSetting');
    expect(row.agentRuntimes).toEqual({ ciFixer: 'claude-code', implementer: 'mastra' });
  });

  it('ignores a pin value it does not recognise and pins afresh', async () => {
    const row = runRow({ implementer: 'bogus' });
    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');
    expect(r.runtime).toBe('mastra');
    expect(row.agentRuntimes).toEqual({ implementer: 'mastra' });
  });

  it('defers to a concurrent resolution that pinned first', async () => {
    const row = { agentRuntimes: null as Record<string, unknown> | null, id: 'run-1' };
    h.findUnique
      .mockResolvedValueOnce({ ...row }) // readPin: nothing yet
      .mockResolvedValueOnce({ ...row }) // pin attempt 1 reads the empty map…
      .mockResolvedValueOnce({ agentRuntimes: { implementer: 'mastra' }, id: 'run-1' });
    h.updateMany.mockResolvedValueOnce({ count: 0 }); // …and loses the race.
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });

    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');

    expect(r).toEqual({ runtime: 'mastra', source: 'run' });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it('puts a caller-supplied pin before the run’s pin and the Agent, and never writes it', async () => {
    const row = runRow({ implementer: 'claude-code' });
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });
    const r = await resolveAgentRuntime(
      'implementer',
      { ...ctx, agentRuntimes: { implementer: 'mastra' } },
      'implementerSetting'
    );
    expect(r).toEqual({ runtime: 'mastra', source: 'run' });
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(row.agentRuntimes).toEqual({ implementer: 'claude-code' });
  });

  it('ignores a caller-supplied pin for another agent, or one it does not recognise', async () => {
    runRow(null);
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });
    for (const agentRuntimes of [{ ciFixer: 'mastra' }, { implementer: 'bogus' }] as Record<
      string,
      string
    >[]) {
      const r = await resolveAgentRuntime(
        'implementer',
        { ...ctx, agentRuntimes },
        'implementerSetting'
      );
      expect(r.runtime).toBe('claude-code');
    }
  });

  it('pins nothing outside an activity', async () => {
    h.inActivity.value = false;
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });
    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');
    expect(r).toEqual({ runtime: 'claude-code', source: 'agent' });
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it('pins nothing for a workflow with no run row', async () => {
    h.findUnique.mockResolvedValue(null);
    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');
    expect(r).toEqual({ runtime: 'mastra', source: 'default' });
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});

describe('pinAgentRuntime', () => {
  it('gives up, retryably, when the map keeps changing underneath', async () => {
    h.findUnique.mockResolvedValue({ agentRuntimes: null, id: 'run-1' });
    h.updateMany.mockResolvedValue({ count: 0 });
    await expect(pinAgentRuntime('wf-1', 'implementer', 'mastra')).rejects.toThrow(
      "could not pin the runtime of agent 'implementer' on run wf-1"
    );
    expect(h.updateMany).toHaveBeenCalledTimes(3);
  });
});
