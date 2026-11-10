/**
 * What happens when an automation's authority has lapsed (see `enablerAuthority.ts`): it is
 * switched off, the reason is kept on the row for the dashboard, the change is audited as the
 * system's, and the managing team's Slack channel is told when it has one.
 *
 * It stays off until a current lead switches it back on, which is a launch decision made on
 * that person and makes them the one it answers to.
 */
import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { writeAuditLog } from '../auditLog.js';
import { postSlackMessage } from '../slack.js';

/** Slack's control characters, so a name or reason someone typed cannot ping a channel. */
function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function orphanedAutomationNotice(name: string, source: string, reason: string): string {
  return (
    `:warning: The automation *${escapeSlack(name.slice(0, 100))}* (${escapeSlack(source)}) ` +
    `was switched off: ${escapeSlack(reason)}. ` +
    'A lead of the team can review it and switch it back on from the Automations page.'
  );
}

/**
 * Switch the automation off if it is still on. True when this call did it, so that two fires
 * racing on the same automation audit and notify once. Never throws for the notice: the
 * automation is already off by then.
 */
export async function disableOrphanedAutomation(
  fastify: FastifyInstance,
  args: {
    automation: { id: string; name: string; source: string };
    now: Date;
    reason: string;
    teamId: string;
  }
): Promise<boolean> {
  const { automation, now, reason, teamId } = args;
  const changed = await runUnscoped('switching off one automation by its id', ['Automation'], () =>
    fastify.prisma.automation.updateMany({
      data: { autoDisabledAt: now, autoDisabledReason: reason, enabled: false },
      where: { enabled: true, id: automation.id },
    })
  );
  if (changed.count === 0) {
    return false;
  }
  await writeAuditLog(fastify, {
    action: 'UPDATE',
    actor: null,
    after: { autoDisabledReason: reason, enabled: false },
    before: { enabled: true },
    entityId: automation.id,
    entityType: 'Automation',
  });
  try {
    const team = await fastify.prisma.team.findUnique({
      select: { slackNotifyChannel: true },
      where: { id: teamId },
    });
    if (team?.slackNotifyChannel) {
      const token = await resolveSlackBotTokenForSlackChannel(team.slackNotifyChannel);
      if (token) {
        await postSlackMessage(
          {
            channel: team.slackNotifyChannel,
            text: orphanedAutomationNotice(automation.name, automation.source, reason),
          },
          token
        );
      }
    }
  } catch (err) {
    fastify.log.warn({ err }, 'could not tell the team an automation was switched off');
  }
  return true;
}
