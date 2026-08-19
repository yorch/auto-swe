import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn(async (_args?: unknown) => [] as unknown[]);

vi.mock('../db.js', () => ({ prisma: { configSetting: { findMany } } }));

import { _resetConfigCacheForTests } from './cache.js';
import {
  invalidateSettingsCache,
  resolveEffectiveSettings,
  resolveSetting,
  resolveSettings,
  snapshotPinnedSettings,
} from './resolveSetting.js';

type Row = { key: string; scope: string; value: unknown };

function rows(...list: Row[]) {
  findMany.mockResolvedValue(list);
}

const TEAM_CTX = { orgId: 'org-1', teamId: 'team-1' };

beforeEach(() => {
  _resetConfigCacheForTests();
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  delete process.env.WORKER_MAX_CONCURRENT_ACTIVITIES;
});

describe('resolveSetting', () => {
  it('falls back to the definition default when nothing overrides it', async () => {
    await expect(resolveSetting('channel.historyMessageLimit')).resolves.toBe(30);
  });

  it('uses a GLOBAL override', async () => {
    rows({ key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 12 });
    await expect(resolveSetting('channel.historyMessageLimit')).resolves.toBe(12);
  });

  it('prefers the most specific scope', async () => {
    rows(
      { key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 10 },
      { key: 'channel.historyMessageLimit', scope: 'ORGANIZATION', value: 20 },
      { key: 'channel.historyMessageLimit', scope: 'TEAM', value: 30 },
      { key: 'channel.historyMessageLimit', scope: 'CHANNEL', value: 40 }
    );
    await expect(
      resolveSetting('channel.historyMessageLimit', { ...TEAM_CTX, channelId: 'c-1' })
    ).resolves.toBe(40);
  });

  it('falls through to the next scope down when the narrower one has no row', async () => {
    rows(
      { key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 10 },
      { key: 'channel.historyMessageLimit', scope: 'ORGANIZATION', value: 20 }
    );
    await expect(resolveSetting('channel.historyMessageLimit', TEAM_CTX)).resolves.toBe(20);
  });

  it('ignores a stored value the schema rejects rather than failing the read', async () => {
    // A row written before a schema tightened, or hand-edited. Degrading one
    // key to its default beats throwing on every activity that reads config.
    rows({ key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 'not a number' });
    await expect(resolveSetting('channel.historyMessageLimit')).resolves.toBe(30);
  });

  it('skips an invalid narrow override and uses the valid broader one', async () => {
    rows(
      { key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 7 },
      { key: 'channel.historyMessageLimit', scope: 'TEAM', value: -5 }
    );
    await expect(resolveSetting('channel.historyMessageLimit', TEAM_CTX)).resolves.toBe(7);
  });

  it('reads an env var when no override exists, and lets a DB row beat it', async () => {
    process.env.WORKER_MAX_CONCURRENT_ACTIVITIES = '25';
    await expect(resolveSetting('workspace.maxConcurrentActivities')).resolves.toBe(25);

    _resetConfigCacheForTests();
    rows({ key: 'workspace.maxConcurrentActivities', scope: 'GLOBAL', value: 40 });
    await expect(resolveSetting('workspace.maxConcurrentActivities')).resolves.toBe(40);
  });

  it('ignores an unparseable env var', async () => {
    process.env.WORKER_MAX_CONCURRENT_ACTIVITIES = 'lots';
    await expect(resolveSetting('workspace.maxConcurrentActivities')).resolves.toBe(10);
  });

  it('honours WORKSPACE_BLOCK_METADATA only-false semantics', async () => {
    process.env.WORKSPACE_BLOCK_METADATA = 'false';
    await expect(resolveSetting('workspace.blockMetadata')).resolves.toBe(false);
    _resetConfigCacheForTests();
    process.env.WORKSPACE_BLOCK_METADATA = 'anything-else';
    await expect(resolveSetting('workspace.blockMetadata')).resolves.toBe(true);
    delete process.env.WORKSPACE_BLOCK_METADATA;
  });
});

describe('run pinning', () => {
  it('reads a pinned value instead of the live cascade', async () => {
    rows({ key: 'workflow.maxTransitions', scope: 'GLOBAL', value: 900 });
    await expect(
      resolveSetting('workflow.maxTransitions', {
        pinnedSettings: { 'workflow.maxTransitions': 250 },
      })
    ).resolves.toBe(250);
  });

  it('does not pin a setting that is not marked runPinned', async () => {
    rows({ key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 11 });
    await expect(
      resolveSetting('channel.historyMessageLimit', {
        pinnedSettings: { 'channel.historyMessageLimit': 99 },
      })
    ).resolves.toBe(11);
  });

  it('falls back to the live cascade when a pinned value is invalid', async () => {
    rows({ key: 'workflow.maxTransitions', scope: 'GLOBAL', value: 900 });
    await expect(
      resolveSetting('workflow.maxTransitions', {
        pinnedSettings: { 'workflow.maxTransitions': 0 },
      })
    ).resolves.toBe(900);
  });

  it('snapshots exactly the run-pinned keys, resolved through the cascade', async () => {
    rows({ key: 'workflow.fanoutConcurrency', scope: 'TEAM', value: 8 });
    const snapshot = await snapshotPinnedSettings(TEAM_CTX);
    expect(snapshot).toEqual({
      'workflow.fanoutConcurrency': 8,
      'workflow.maxTransitions': 500,
    });
  });
});

describe('batching and caching', () => {
  it('resolves many keys in one query', async () => {
    rows({ key: 'channel.historyMessageLimit', scope: 'GLOBAL', value: 15 });
    const values = await resolveSettings(
      ['channel.historyMessageLimit', 'channel.memoryContextItems'],
      TEAM_CTX
    );
    expect(values).toEqual({
      'channel.historyMessageLimit': 15,
      'channel.memoryContextItems': 5,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('serves a repeat read for the same context from cache', async () => {
    await resolveSetting('channel.historyMessageLimit', TEAM_CTX);
    await resolveSetting('channel.memoryContextItems', TEAM_CTX);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps separate contexts apart', async () => {
    await resolveSetting('channel.historyMessageLimit', { teamId: 'team-1' });
    await resolveSetting('channel.historyMessageLimit', { teamId: 'team-2' });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('re-queries after an invalidation so a save is visible immediately', async () => {
    await resolveSetting('channel.historyMessageLimit', TEAM_CTX);
    invalidateSettingsCache();
    await resolveSetting('channel.historyMessageLimit', TEAM_CTX);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('only queries the scopes the context can actually select', async () => {
    await resolveSetting('channel.historyMessageLimit');
    const args = findMany.mock.calls[0]?.[0] as { where: { OR: unknown[] } } | undefined;
    expect(args?.where.OR).toEqual([{ scope: 'GLOBAL' }]);
  });
});

describe('resolveEffectiveSettings', () => {
  it('reports the scope each value came from', async () => {
    process.env.WORKER_MAX_CONCURRENT_ACTIVITIES = '25';
    rows({ key: 'channel.historyMessageLimit', scope: 'TEAM', value: 21 });
    const effective = await resolveEffectiveSettings(TEAM_CTX);
    const byKey = new Map(effective.map((e) => [e.key, e]));

    expect(byKey.get('channel.historyMessageLimit')).toMatchObject({ source: 'TEAM', value: 21 });
    expect(byKey.get('channel.memoryContextItems')).toMatchObject({ source: 'DEFAULT', value: 5 });
    expect(byKey.get('workspace.maxConcurrentActivities')).toMatchObject({
      source: 'ENV',
      value: 25,
    });
  });

  it('marks a pinned value as PINNED so a stalled live edit is explainable', async () => {
    const effective = await resolveEffectiveSettings({
      pinnedSettings: { 'workflow.maxTransitions': 250 },
    });
    const pinned = effective.find((e) => e.key === 'workflow.maxTransitions');
    expect(pinned).toMatchObject({ source: 'PINNED', value: 250 });
  });
});
