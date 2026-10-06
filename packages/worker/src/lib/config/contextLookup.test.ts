import { Prisma } from '@auto-swe/shared';
import { RUN_PINNED_SETTING_KEYS } from '@auto-swe/shared/config';
import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { activityInfo, snapshotPinnedSettings } = vi.hoisted(() => ({
  activityInfo: vi.fn(),
  snapshotPinnedSettings: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo,
}));

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  snapshotPinnedSettings,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    workflowRun: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
}));

import { currentRequestContext } from './contextLookup.js';

const findActive = vi.mocked(prisma.activeWorkflow.findFirst);
const findRun = vi.mocked(prisma.workflowRun.findUnique);
const updateRuns = vi.mocked(prisma.workflowRun.updateMany);

/// Every run-pinned key at a "live" value, as the snapshot would resolve it now.
const live = Object.fromEntries(RUN_PINNED_SETTING_KEYS.map((key) => [key, `live:${key}`]));
const [kept, missing] = [
  RUN_PINNED_SETTING_KEYS[0] as string,
  RUN_PINNED_SETTING_KEYS.at(-1) as string,
];
/// A snapshot taken before `missing` was declared runPinned.
const partial = Object.fromEntries(
  RUN_PINNED_SETTING_KEYS.filter((key) => key !== missing).map((key) => [key, `pinned:${key}`])
);

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    agentVersions: null,
    channel: null,
    id: 'run-1',
    pinnedSettings: partial,
    skillRevisions: null,
    templateId: 'tpl-1',
    ...overrides,
  };
}

describe('currentRequestContext pinned settings', () => {
  beforeEach(() => {
    _resetConfigCacheForTests();
    vi.clearAllMocks();
    activityInfo.mockReturnValue({ workflowExecution: { workflowId: 'wf-1' } });
    findActive.mockResolvedValue({
      repository: { team: { orgId: 'org-1' }, teamId: 'team-1' },
    } as never);
    snapshotPinnedSettings.mockResolvedValue(live);
    updateRuns.mockResolvedValue({ count: 1 } as never);
  });

  it('pins a missing key on first read, at the value this context resolves it to', async () => {
    findRun.mockResolvedValue(runRow() as never);

    const ctx = await currentRequestContext();

    // Snapshotted under the same tenant every read through this ctx uses.
    expect(snapshotPinnedSettings).toHaveBeenCalledWith({
      orgId: 'org-1',
      teamId: 'team-1',
      workflowTemplateId: 'tpl-1',
    });
    expect(updateRuns).toHaveBeenCalledTimes(1);
    expect(updateRuns.mock.calls[0]?.[0]).toEqual({
      data: { pinnedSettings: { ...partial, [missing]: live[missing] } },
      where: { id: 'run-1', pinnedSettings: { equals: partial } },
    });
    expect(ctx.pinnedSettings?.[missing]).toBe(live[missing]);
    expect(ctx.pinnedSettings?.[kept]).toBe(`pinned:${kept}`);
  });

  it('writes nothing for a run whose snapshot already has every key', async () => {
    const full = { ...partial, [missing]: `pinned:${missing}` };
    findRun.mockResolvedValue(runRow({ pinnedSettings: full }) as never);

    const ctx = await currentRequestContext();

    expect(snapshotPinnedSettings).not.toHaveBeenCalled();
    expect(updateRuns).not.toHaveBeenCalled();
    expect(ctx.pinnedSettings).toEqual(full);
  });

  it('pins every key on a row that pre-dates the column, only while it is still null', async () => {
    findRun.mockResolvedValue(runRow({ pinnedSettings: null }) as never);

    const ctx = await currentRequestContext();

    expect(updateRuns.mock.calls[0]?.[0]).toMatchObject({
      where: { pinnedSettings: { equals: Prisma.DbNull } },
    });
    expect(ctx.pinnedSettings).toEqual(live);
  });

  it('adopts what a concurrent writer pinned when it loses the compare-and-set', async () => {
    const winner = { ...partial, [missing]: `winner:${missing}` };
    findRun
      .mockResolvedValueOnce(runRow() as never)
      .mockResolvedValueOnce({ pinnedSettings: winner } as never);
    updateRuns.mockResolvedValueOnce({ count: 0 } as never);

    const ctx = await currentRequestContext();

    expect(updateRuns).toHaveBeenCalledTimes(1);
    expect(ctx.pinnedSettings).toEqual(winner);
  });

  it('pins a channel turn at its channel’s scope, the one its own reads use', async () => {
    findActive.mockResolvedValue(null as never);
    findRun.mockResolvedValue(
      runRow({
        channel: { id: 'chan-1', orgId: 'org-9', teamId: 'team-9' },
        pinnedSettings: null,
      }) as never
    );

    const ctx = await currentRequestContext();

    expect(snapshotPinnedSettings).toHaveBeenCalledWith({
      channelId: 'chan-1',
      orgId: 'org-9',
      teamId: 'team-9',
      workflowTemplateId: 'tpl-1',
    });
    expect(ctx.pinnedSettings).toEqual(live);
    // The pin's scope is not leaked into the context itself: the caller adds
    // the channel scope on top, as before.
    expect(ctx.channelId).toBeUndefined();
    expect(ctx.teamId).toBeUndefined();
  });

  it('falls back to the stored snapshot when the write fails, without throwing', async () => {
    findRun.mockResolvedValue(runRow() as never);
    updateRuns.mockRejectedValueOnce(new Error('connection reset'));

    const ctx = await currentRequestContext();

    expect(ctx.pinnedSettings).toEqual(partial);
    expect(ctx.teamId).toBe('team-1');
  });

  it('falls back to the stored snapshot when the live resolution fails, without throwing', async () => {
    findRun.mockResolvedValue(runRow() as never);
    snapshotPinnedSettings.mockRejectedValueOnce(new Error('db down'));

    const ctx = await currentRequestContext();

    expect(updateRuns).not.toHaveBeenCalled();
    expect(ctx.pinnedSettings).toEqual(partial);
  });

  it('falls back to the stored snapshot when every compare-and-set loses', async () => {
    findRun.mockResolvedValue(runRow() as never);
    updateRuns.mockResolvedValue({ count: 0 } as never);

    const ctx = await currentRequestContext();

    expect(updateRuns).toHaveBeenCalledTimes(3);
    expect(ctx.pinnedSettings).toEqual(partial);
  });
});
