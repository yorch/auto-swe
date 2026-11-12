import { prisma } from '@auto-swe/shared/db';

/**
 * The platform user behind a Slack id, or null when they have not linked.
 *
 * `isActive` is filtered here for the same reason the access decision filters
 * it: the two queries answer the same question — who is this Slack id — and a
 * disagreement between them is worse than either answer alone. Without it a
 * deactivated user is refused by the gate as if they had never linked, and then
 * recorded as the requester of the run they were refused.
 */
export async function platformUserIdForSlackId(
  slackId: string | undefined
): Promise<string | null> {
  if (!slackId) {
    return null;
  }
  const user = await prisma.user.findFirst({
    select: { id: true },
    where: { isActive: true, slackId },
  });
  return user?.id ?? null;
}
