/**
 * Whether the person who last switched an automation on may still stand behind it.
 *
 * An automation whose source names no person to act for (CI failures, Jira filters, inbound
 * events) runs with the platform credential. The launch decision that allowed it was taken on
 * the person who saved it, once. This is the same question asked again when it fires: is that
 * person still an active user, and do they still hold `team.automations.manage` on the team that
 * manages the automation? The capability is asked, not a role, so this cannot drift from who may
 * manage automations through the API. Their GitHub permission is not read again: that check is
 * made at save and is too costly to repeat on every fire.
 *
 * The reasons are fixed strings: they reach the ledger, the audit log and a Slack channel.
 */
import type { PrismaClient } from '@auto-swe/shared';
import { can, userActor } from '@auto-swe/shared/permissions';

export const ENABLER_REASONS = {
  inactive: 'the person who switched it on is no longer an active user',
  none: 'no one is recorded as having switched it on',
  notLead: 'the person who switched it on may no longer manage the automations of the team',
} as const;

export type EnablerAuthority = { ok: true } | { ok: false; reason: string };

/** `teamId` is the team that manages the automation: the repository's owner, or its own team. */
export async function checkEnablerAuthority(
  prisma: PrismaClient,
  enablerId: string | null,
  teamId: string
): Promise<EnablerAuthority> {
  if (enablerId === null) {
    return { ok: false, reason: ENABLER_REASONS.none };
  }
  const user = await prisma.user.findUnique({
    select: { isActive: true, role: true },
    where: { id: enablerId },
  });
  if (!user?.isActive) {
    return { ok: false, reason: ENABLER_REASONS.inactive };
  }
  const decision = await can(
    prisma,
    userActor({ role: user.role, sub: enablerId }),
    'team.automations.manage',
    { teamId }
  );
  return decision.allowed ? { ok: true } : { ok: false, reason: ENABLER_REASONS.notLead };
}
