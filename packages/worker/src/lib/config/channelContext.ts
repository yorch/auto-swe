import { prisma } from '@auto-swe/shared/db';
import type { ResolveCtx } from './types.js';

/**
 * Adds a channel-resident run's channel scope to its request context.
 *
 * `currentRequestContext()` derives `teamId` / `orgId` from the run's
 * `ActiveWorkflow -> repository` row, which a repo-less run (a general channel
 * task) does not have. Setting `channelId` alone fires the CHANNEL tier but
 * leaves TEAM and ORGANIZATION out of the cascade, so an override at either tier
 * would apply to the assistant's reply — which resolves with all three — and not
 * to the task it delegated. When the ambient context carries no team, the
 * channel's own team and org stand in for it, the same values the mention turn
 * resolves with.
 *
 * Scoping only: it never widens what a run may do, and a run that already has a
 * team (a ledger row) keeps it. A missing channel row degrades to the channel id
 * alone, as before.
 */
export async function withChannelScope(
  baseCtx: ResolveCtx,
  channelId: string | undefined
): Promise<ResolveCtx> {
  if (!channelId) {
    return baseCtx;
  }
  const ctx = { ...baseCtx, channelId };
  if (baseCtx.teamId) {
    return ctx;
  }
  const channel = await prisma.slackChannel.findUnique({
    select: { orgId: true, teamId: true },
    where: { id: channelId },
  });
  return channel ? { ...ctx, orgId: channel.orgId, teamId: channel.teamId } : ctx;
}
