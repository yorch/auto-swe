import { prisma } from '@auto-swe/shared/db';
import { activityInfo } from '@temporalio/activity';
import { configCacheTtlMs, withCache } from './cache.js';
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
          select: { repository: { select: { teamId: true } } },
          where: { temporalWorkflowId: wid },
        }),
        prisma.workflowRun.findUnique({
          select: { agentVersions: true, templateId: true },
          where: { workflowId: wid },
        }),
      ]);
      const agentVersions =
        run?.agentVersions && typeof run.agentVersions === 'object'
          ? (run.agentVersions as Record<string, number>)
          : undefined;
      return {
        agentVersions,
        teamId: active?.repository?.teamId,
        workflowTemplateId: run?.templateId,
      };
    },
    (ctx) =>
      ctx.teamId !== undefined ||
      ctx.workflowTemplateId !== undefined ||
      ctx.agentVersions !== undefined
  );
}
