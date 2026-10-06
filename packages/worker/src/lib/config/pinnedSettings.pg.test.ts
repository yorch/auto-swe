import type { Prisma } from '@auto-swe/shared';
import { RUN_PINNED_SETTING_KEYS, resolveSetting } from '@auto-swe/shared/config';
import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { activityInfo } = vi.hoisted(() => ({ activityInfo: vi.fn() }));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo,
}));

import { currentRequestContext } from './contextLookup.js';
import { backfillPinnedSettings } from './pinnedSettings.js';

/**
 * Pin-on-first-read against real Postgres: the compare-and-set on the JSON
 * column (`equals` on a jsonb value, and on SQL NULL) is the mechanism that keeps
 * concurrent activities of one run from overwriting each other's pin, and a
 * mocked Prisma does not evaluate it.
 *
 * Opt in with `PINNED_SETTINGS_PG_TEST=1` and a `DATABASE_URL` that
 * `prisma migrate deploy` has been run against (it writes and deletes rows, so
 * use a throwaway one):
 *
 *   docker run -d --rm --name pin-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55511:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55511/t yarn workspace @auto-swe/shared db:deploy
 *   PINNED_SETTINGS_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/worker/src/lib/config/pinnedSettings.pg.test.ts
 */
const enabled = process.env.PINNED_SETTINGS_PG_TEST === '1';

const KEY = 'workspace.implementerRuntime';

describe.skipIf(!enabled)('pinned settings backfill against Postgres', () => {
  const suffix = Math.random().toString(36).slice(2);
  let templateId = '';
  let settingId = '';
  const runIds: string[] = [];

  /// A snapshot taken before `KEY` was declared runPinned.
  const partial = Object.fromEntries(
    RUN_PINNED_SETTING_KEYS.filter((key) => key !== KEY).map((key) => [key, 7])
  );

  async function createRun(pinnedSettings: Prisma.InputJsonObject | null, channelId?: string) {
    const workflowId = `pin-pg-${suffix}-${runIds.length}`;
    const run = await prisma.workflowRun.create({
      data: {
        ...(channelId ? { channelId } : {}),
        ...(pinnedSettings ? { pinnedSettings } : {}),
        specSnapshot: {},
        templateId,
        templateVersion: 1,
        workflowId,
      },
    });
    runIds.push(run.id);
    return { runId: run.id, workflowId };
  }

  const stored = async (id: string) =>
    (await prisma.workflowRun.findUniqueOrThrow({ where: { id } })).pinnedSettings as Record<
      string,
      unknown
    > | null;

  beforeAll(async () => {
    const template = await prisma.workflowTemplate.create({
      data: { name: `pin-pg-${suffix}` },
    });
    templateId = template.id;
    // A template-scope override, so the value a run pins is not the default and
    // the suite touches no row another suite could read.
    const setting = await prisma.configSetting.create({
      data: {
        key: KEY,
        scope: 'WORKFLOW_TEMPLATE',
        value: 'claude-code',
        workflowTemplateId: templateId,
      },
    });
    settingId = setting.id;
  });

  beforeEach(() => {
    _resetConfigCacheForTests();
  });

  afterAll(async () => {
    await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.configSetting.delete({ where: { id: settingId } });
    await prisma.workflowTemplate.delete({ where: { id: templateId } });
    await prisma.$disconnect();
  });

  it('converges racing writers on one pin and never overwrites a value already pinned', async () => {
    const { runId } = await createRun({
      ...partial,
      [RUN_PINNED_SETTING_KEYS[0] as string]: 'kept',
    });
    const before = await stored(runId);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        backfillPinnedSettings(runId, before, {
          ...Object.fromEntries(RUN_PINNED_SETTING_KEYS.map((key) => [key, `writer-${i}`])),
        })
      )
    );

    const after = await stored(runId);
    // Every writer returns what is stored: a loser adopts the winner's pin.
    for (const result of results) {
      expect(result).toEqual(after);
    }
    expect(after?.[RUN_PINNED_SETTING_KEYS[0] as string]).toBe('kept');
    expect(String(after?.[KEY])).toMatch(/^writer-\d+$/);
  });

  it('backfills a NULL column once, under racing writers', async () => {
    const { runId } = await createRun(null);
    expect(await stored(runId)).toBeNull();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        backfillPinnedSettings(runId, null, { [KEY]: `writer-${i}` })
      )
    );

    const after = await stored(runId);
    expect(Object.keys(after ?? {})).toEqual([KEY]);
    for (const result of results) {
      expect(result).toEqual(after);
    }
  });

  it('pins a missing key on first read and holds it against a later live edit', async () => {
    const { runId, workflowId } = await createRun(partial);
    activityInfo.mockReturnValue({ workflowExecution: { workflowId } });

    // Concurrent activities of one run, each reading the context cold.
    const contexts = await Promise.all(
      Array.from({ length: 6 }, async () => {
        _resetConfigCacheForTests();
        return currentRequestContext();
      })
    );
    for (const ctx of contexts) {
      expect(ctx.pinnedSettings?.[KEY]).toBe('claude-code');
    }
    expect((await stored(runId))?.[KEY]).toBe('claude-code');

    // An operator flips the setting mid-run; the run keeps what it first read.
    await prisma.configSetting.update({ data: { value: 'mastra' }, where: { id: settingId } });
    _resetConfigCacheForTests();
    const ctx = await currentRequestContext();
    expect(await resolveSetting(KEY, ctx)).toBe('claude-code');
    expect((await stored(runId))?.[KEY]).toBe('claude-code');

    // A run that never read it would see the edit.
    _resetConfigCacheForTests();
    expect(await resolveSetting(KEY, { workflowTemplateId: templateId })).toBe('mastra');
    await prisma.configSetting.update({ data: { value: 'claude-code' }, where: { id: settingId } });
  });

  it('pins a channel turn at its channel’s team, the scope its own reads use', async () => {
    // A channel turn has no ActiveWorkflow, so the context lookup alone would
    // resolve at the template and GLOBAL only. The channel's team carries an
    // override that only a channel-scoped pin sees.
    const org = await prisma.organization.create({
      data: { name: `pin-pg-org-${suffix}`, slug: `pin-pg-org-${suffix}` },
    });
    const team = await prisma.team.create({
      data: { name: `pin-pg-team-${suffix}`, orgId: org.id, slug: `pin-pg-team-${suffix}` },
    });
    const workspace = await prisma.slackWorkspace.create({
      data: { orgId: org.id, slackTeamId: `T-pin-pg-${suffix}` },
    });
    const channel = await prisma.slackChannel.create({
      data: { orgId: org.id, slackChannelId: 'C1', teamId: team.id, workspaceId: workspace.id },
    });
    try {
      await prisma.configSetting.create({
        data: { key: 'workflow.maxTransitions', scope: 'TEAM', teamId: team.id, value: 321 },
      });
      const { runId, workflowId } = await createRun(null, channel.id);
      activityInfo.mockReturnValue({ workflowExecution: { workflowId } });

      const ctx = await currentRequestContext();

      expect(ctx.pinnedSettings?.['workflow.maxTransitions']).toBe(321);
      expect((await stored(runId))?.['workflow.maxTransitions']).toBe(321);
    } finally {
      await prisma.slackChannel.delete({ where: { id: channel.id } });
      // Cascades the TEAM setting.
      await prisma.team.delete({ where: { id: team.id } });
      // Cascades the Slack workspace.
      await prisma.organization.delete({ where: { id: org.id } });
    }
  });
});
