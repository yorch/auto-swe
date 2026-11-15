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

  it('falls back to the run-pinned agent-run setting for an agent run, not the implementer one', async () => {
    runRow(null);
    h.resolveSetting.mockResolvedValue('pi');
    const r = await resolveAgentRuntime('contentWriter', ctx, 'agentRunSetting');
    expect(r).toEqual({ runtime: 'pi', source: 'default' });
    expect(h.resolveSetting).toHaveBeenCalledWith('workspace.agentRunRuntime', ctx);
    expect(h.resolveSetting).not.toHaveBeenCalledWith('workspace.implementerRuntime', ctx);
  });

  it('stays on Mastra for an agent run when the setting is at its default', async () => {
    runRow(null);
    const r = await resolveAgentRuntime('contentWriter', ctx, 'agentRunSetting');
    expect(r).toEqual({ runtime: 'mastra', source: 'default' });
  });

  it('reads the setting with its own context while the Agent resolves without the team', async () => {
    runRow(null);
    h.resolveSetting.mockResolvedValue('pi');
    const agentCtx = { orgId: 'org-1' };
    const settingsCtx = { orgId: 'org-1', pinnedSettings: { x: 1 }, teamId: 'team-1' };
    const r = await resolveAgentRuntime('contentWriter', agentCtx, 'agentRunSetting', settingsCtx);
    expect(r.runtime).toBe('pi');
    expect(h.resolveAgent).toHaveBeenCalledWith('contentWriter', agentCtx);
    expect(h.resolveSetting).toHaveBeenCalledWith('workspace.agentRunRuntime', settingsCtx);
  });

  it('lets the Agent’s own runtime win over the agent-run setting', async () => {
    runRow(null);
    h.resolveAgent.mockResolvedValue({ runtime: 'mastra' });
    h.resolveSetting.mockResolvedValue('pi');
    const r = await resolveAgentRuntime('contentWriter', ctx, 'agentRunSetting');
    expect(r).toEqual({ runtime: 'mastra', source: 'agent' });
    expect(h.resolveSetting).not.toHaveBeenCalled();
  });

  it('keeps a pinned runtime after the setting is edited mid-run', async () => {
    runRow({ contentWriter: 'mastra' });
    h.resolveSetting.mockResolvedValue('pi');
    const r = await resolveAgentRuntime('contentWriter', ctx, 'agentRunSetting');
    expect(r).toEqual({ runtime: 'mastra', source: 'run' });
  });

  it('reads the setting on a no-opinion pin, from the run-pinned value on a retry', async () => {
    runRow({ contentWriter: null });
    // The live cascade now says mastra; only the run's pinned value says pi.
    h.resolveSetting.mockImplementation(
      async (key: string, c?: { pinnedSettings?: Record<string, unknown> }) =>
        c?.pinnedSettings && key in c.pinnedSettings ? c.pinnedSettings[key] : 'mastra'
    );
    const settingsCtx = { pinnedSettings: { 'workspace.agentRunRuntime': 'pi' } };
    const r = await resolveAgentRuntime('contentWriter', {}, 'agentRunSetting', settingsCtx);
    expect(r).toEqual({ runtime: 'pi', source: 'default' });
    // Reading with the agent's context instead (no pins) would give the live value.
    expect(await resolveAgentRuntime('contentWriter', {}, 'agentRunSetting', {})).toEqual({
      runtime: 'mastra',
      source: 'default',
    });
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

  it('runs on the default when the run-start snapshot says the Agent had no opinion', async () => {
    const row = runRow({ implementer: null });
    // The Agent has since been given a runtime; the run must not see it.
    h.resolveAgent.mockResolvedValue({ runtime: 'claude-code' });
    h.resolveSetting.mockResolvedValue('mastra');

    const r = await resolveAgentRuntime('implementer', ctx, 'implementerSetting');

    expect(r).toEqual({ runtime: 'mastra', source: 'default' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(row.agentRuntimes).toEqual({ implementer: null });
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
  it('never overwrites a no-opinion pin', async () => {
    const row = runRow({ implementer: null });
    expect(await pinAgentRuntime('wf-1', 'implementer', 'claude-code')).toBe('claude-code');
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(row.agentRuntimes).toEqual({ implementer: null });
  });

  it('gives up, retryably, when the map keeps changing underneath', async () => {
    h.findUnique.mockResolvedValue({ agentRuntimes: null, id: 'run-1' });
    h.updateMany.mockResolvedValue({ count: 0 });
    await expect(pinAgentRuntime('wf-1', 'implementer', 'mastra')).rejects.toThrow(
      "could not pin the runtime of agent 'implementer' on run wf-1"
    );
    expect(h.updateMany).toHaveBeenCalledTimes(3);
  });
});
