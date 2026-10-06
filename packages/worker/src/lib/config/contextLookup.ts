import { RUN_PINNED_SETTING_KEYS, snapshotPinnedSettings } from '@auto-swe/shared/config';
import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';
import { logWarn } from '../activityLog.js';
import { asPinnedSettings, backfillPinnedSettings, hasEveryPin } from './pinnedSettings.js';
import type { ResolveCtx } from './types.js';

/// Look up `{ teamId, workflowTemplateId }` for the currently-executing
/// Temporal activity. Both fields may be undefined when the lookup races
/// against `createWorkflowRun` or when the activity is invoked outside a
/// real workflow (e.g. unit tests). Cached so repeated calls within one
/// activity invocation don't re-hit Postgres.
export async function currentRequestContext(): Promise<ResolveCtx> {
  let wid: string | undefined;
  try {
    wid = activityInfo().workflowExecution?.workflowId;
  } catch (err) {
    // `activityInfo()` throws with a specific message when called outside an
    // activity context (worker boot, unit tests). Any other error is a real
    // bug — let it propagate so we don't silently degrade to GLOBAL scope.
    if (
      err instanceof Error &&
      /activity context (not initialized|is not available)/i.test(err.message)
    ) {
      return {};
    }
    throw err;
  }
  if (!wid) {
    return {};
  }

  // Don't cache an empty result: if the lookup raced ahead of
  // `createWorkflowRun`/`ActiveWorkflow` (both fields undefined), caching it
  // would pin scope resolution to GLOBAL for the whole TTL. The `shouldCache`
  // predicate skips storing it so the next activity call re-resolves once the
  // rows land.
  return withCache(
    `ctx:${wid}`,
    configCacheTtlMs(),
    async () => {
      const [active, run] = await Promise.all([
        prisma.activeWorkflow.findFirst({
          select: {
            repository: { select: { team: { select: { orgId: true } }, teamId: true } },
          },
          where: { temporalWorkflowId: wid },
        }),
        prisma.workflowRun.findUnique({
          select: {
            agentVersions: true,
            channel: { select: { id: true, orgId: true, teamId: true } },
            id: true,
            pinnedSettings: true,
            skillRevisions: true,
            templateId: true,
          },
          where: { workflowId: wid },
        }),
      ]);
      const agentVersions =
        run?.agentVersions && typeof run.agentVersions === 'object'
          ? (run.agentVersions as Record<string, number>)
          : undefined;
      const skillRevisions =
        run?.skillRevisions && typeof run.skillRevisions === 'object'
          ? (run.skillRevisions as Record<string, number>)
          : undefined;
      const scope = {
        // Org is derived transitively (team → org); the ORGANIZATION cascade
        // tier sits between TEAM and GLOBAL.
        orgId: active?.repository?.team?.orgId,
        teamId: active?.repository?.teamId,
        workflowTemplateId: run?.templateId,
      };
      // Run-start snapshot of the registry settings marked `runPinned`, completed
      // here for any key it lacks. Carried on the ctx so any activity that
      // resolves a setting gets the run's frozen value without knowing that
      // pinning exists.
      const pinnedSettings = run ? await pinOnFirstRead(run, scope) : undefined;
      return { agentVersions, pinnedSettings, skillRevisions, ...scope };
    },
    (ctx) =>
      ctx.teamId !== undefined ||
      ctx.orgId !== undefined ||
      ctx.workflowTemplateId !== undefined ||
      ctx.agentVersions !== undefined ||
      ctx.skillRevisions !== undefined ||
      ctx.pinnedSettings !== undefined
  );
}

/// The run's pinned settings, with any `runPinned` key the snapshot lacks pinned
/// now — at the value this context resolves it to, which is the value the read
/// that asked would have seen live. The snapshot is taken in `createWorkflowRun`,
/// so a key is missing only when the row pre-dates the setting being declared
/// `runPinned` (or pre-dates the column); without this the run would resolve that
/// key live for the rest of its life and an edit could reach it between two
/// activities.
///
/// The write is `backfillPinnedSettings`' compare-and-set, so concurrent
/// activities of one run converge on a single pin and a value already pinned is
/// never changed. It never throws: a failed write logs and returns the snapshot
/// as stored, so the missing key resolves live exactly as it did before, and the
/// next lookup after the cache window tries again.
///
/// A channel turn's tenant comes from its Slack channel, which the caller adds
/// on top of this context rather than from `ActiveWorkflow`, so its missing keys
/// are pinned at the channel's scope — the scope `startChannelRun` snapshots at
/// and the turn's own reads use. Pinning it at this context's scope would freeze
/// a value the turn never resolves to.
async function pinOnFirstRead(
  run: {
    channel: { id: string; orgId: string | null; teamId: string | null } | null;
    id: string;
    pinnedSettings: unknown;
  },
  scope: ResolveCtx
): Promise<Record<string, unknown> | undefined> {
  const stored = asPinnedSettings(run.pinnedSettings) ?? undefined;
  if (hasEveryPin(stored, RUN_PINNED_SETTING_KEYS)) {
    return stored;
  }
  const pinScope: ResolveCtx = run.channel
    ? {
        channelId: run.channel.id,
        orgId: run.channel.orgId ?? undefined,
        teamId: run.channel.teamId ?? undefined,
        workflowTemplateId: scope.workflowTemplateId,
      }
    : scope;
  try {
    const fresh = await snapshotPinnedSettings(pinScope);
    const persisted = await backfillPinnedSettings(run.id, run.pinnedSettings, fresh);
    if (persisted) {
      return persisted;
    }
    logWarn('pinned settings backfill lost every compare-and-set; resolving live', {
      runId: run.id,
    });
  } catch (err) {
    logWarn('pinned settings backfill failed; resolving live', {
      error: err instanceof Error ? err.message : String(err),
      runId: run.id,
    });
  }
  return stored;
}
