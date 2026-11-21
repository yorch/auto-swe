import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  resolveBetterAuthConfig,
  resolveSlackBotTokenForSlackChannel,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { orgRolesAtLeast } from '@auto-swe/shared/permissions';
import { escapeSlackMrkdwn } from './hitlSlackSync.js';
import { escapeHtml, sendNotificationEmails } from './notificationEmail.js';
import { postSlackMessage } from './slack.js';

/**
 * What the join-request service tells the notifier after a transaction commits. The notifier loads
 * everything else it needs by id, so a caller never passes names, emails or message text.
 */
export type JoinRequestEvent =
  | { kind: 'created'; requestId: string }
  | { kind: 'decided'; requestId: string; outcome: 'APPROVED' | 'REJECTED' | 'PENDING_ORG' };

/** The most organization admins one request emails. A larger organization is truncated and logged. */
export const MAX_ORG_ADMIN_RECIPIENTS = 20;

const MESSAGE_MAX_CHARS = 500;
const NOTE_MAX_CHARS = 1000;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The web app's public origin: the first `CORS_ORIGIN` entry, the same one sign-in links use. */
function webBaseUrl(): string {
  return resolveBetterAuthConfig().clientOrigin.replace(/\/+$/, '');
}

async function loadRequest(prisma: PrismaClient, requestId: string) {
  return runUnscoped(
    'a join-request notification loads one request by id, after the transaction that made it',
    ['TeamJoinRequest', 'Team', 'User', 'Organization'],
    () =>
      prisma.teamJoinRequest.findUnique({
        select: {
          closeReason: true,
          message: true,
          orgDecidedAt: true,
          orgDecisionNote: true,
          status: true,
          team: {
            select: {
              id: true,
              isActive: true,
              name: true,
              organization: { select: { id: true, isActive: true, name: true } },
              orgId: true,
              slackNotifyChannel: true,
              slug: true,
            },
          },
          teamDecisionNote: true,
          user: { select: { email: true, isActive: true, name: true } },
        },
        where: { id: requestId },
      })
  );
}

type LoadedRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

function requesterLabel(request: LoadedRequest): string {
  return request.user.name?.trim() || 'Someone';
}

async function postCreated(request: LoadedRequest): Promise<void> {
  const channel = request.team.slackNotifyChannel;
  if (!channel) {
    return;
  }
  const token = await resolveSlackBotTokenForSlackChannel(channel);
  if (!token) {
    return;
  }
  const link = `${webBaseUrl()}/teams/${encodeURIComponent(request.team.slug)}/members`;
  const lines = [
    `*${escapeSlackMrkdwn(requesterLabel(request))}* asked to join *${escapeSlackMrkdwn(request.team.name)}* in ${escapeSlackMrkdwn(request.team.organization.name)}`,
  ];
  const message = clip(request.message, MESSAGE_MAX_CHARS);
  if (message) {
    lines.push(`> ${escapeSlackMrkdwn(message).replaceAll(/\r?\n/g, '\n> ')}`);
  }
  lines.push(`<${link}|Review the request>`);
  await postSlackMessage({ channel, text: lines.join('\n') }, token);
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

function render(subject: string, paragraphs: string[], note: string, link: string): Rendered {
  const textParts = [...paragraphs];
  const htmlParts = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (note) {
    textParts.push(`Note: ${note}`);
    htmlParts.push(`<p>Note: ${escapeHtml(note)}</p>`);
  }
  textParts.push(link);
  htmlParts.push(`<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`);
  return { html: htmlParts.join('\n'), subject, text: textParts.join('\n\n') };
}

async function emailDecision(
  prisma: PrismaClient,
  request: LoadedRequest,
  outcome: 'APPROVED' | 'REJECTED' | 'PENDING_ORG'
): Promise<void> {
  const team = request.team.name;
  const org = request.team.organization.name;
  const base = webBaseUrl();
  const note = clip(
    (request.orgDecidedAt ? request.orgDecisionNote : request.teamDecisionNote) ?? '',
    NOTE_MAX_CHARS
  );
  const messages: Array<Rendered & { to: string }> = [];

  const requesterEmail = request.user.email?.trim();
  if (request.user.isActive && requesterEmail) {
    if (outcome === 'APPROVED') {
      messages.push({
        to: requesterEmail,
        ...render(
          `You joined ${team}`,
          [`Your request to join ${team} was approved. You are now a member.`],
          note,
          `${base}/teams/${encodeURIComponent(request.team.slug)}`
        ),
      });
    } else if (outcome === 'REJECTED') {
      messages.push({
        to: requesterEmail,
        ...render(
          `Your request to join ${team}`,
          [`Your request to join ${team} was not approved.`],
          note,
          `${base}/teams`
        ),
      });
    } else {
      messages.push({
        to: requesterEmail,
        ...render(
          `Your request to join ${team} is waiting for ${org}`,
          [
            `The ${team} team approved your request. It is now waiting for an administrator of ${org} to approve it.`,
          ],
          note,
          `${base}/teams`
        ),
      });
    }
  }

  if (outcome === 'PENDING_ORG') {
    const admins = await runUnscoped(
      'a join-request notification lists the active admins of the request organization',
      ['OrganizationMembership', 'User'],
      () =>
        prisma.organizationMembership.findMany({
          orderBy: { createdAt: 'asc' },
          select: { user: { select: { email: true, isActive: true } } },
          take: MAX_ORG_ADMIN_RECIPIENTS + 1,
          where: {
            orgId: request.team.orgId,
            role: { in: orgRolesAtLeast('ADMIN') },
            user: { isActive: true },
          },
        })
    );
    if (admins.length > MAX_ORG_ADMIN_RECIPIENTS) {
      console.warn(
        `[join-request-notify] organization ${request.team.orgId} has more than ${MAX_ORG_ADMIN_RECIPIENTS} admins; emailing the first ${MAX_ORG_ADMIN_RECIPIENTS}`
      );
    }
    const seen = new Set(messages.map((m) => m.to.toLowerCase()));
    const rendered = render(
      `A request to join ${team} needs your approval`,
      [
        `${requesterLabel(request)} asked to join ${team} in ${org}. The team approved the request and it now needs an organization administrator.`,
      ],
      '',
      `${base}/admin/organizations/${encodeURIComponent(request.team.orgId)}`
    );
    for (const admin of admins.slice(0, MAX_ORG_ADMIN_RECIPIENTS)) {
      const email = admin.user.email?.trim();
      if (!(admin.user.isActive && email) || seen.has(email.toLowerCase())) {
        continue;
      }
      seen.add(email.toLowerCase());
      messages.push({ to: email, ...rendered });
    }
  }

  await sendNotificationEmails('join-request-decided', messages);
}

const STATUS_FOR_OUTCOME = {
  APPROVED: 'APPROVED',
  PENDING_ORG: 'PENDING_ORG',
  REJECTED: 'REJECTED',
} as const;

/**
 * Best-effort delivery of the notifications in docs/specs/2026-11-20-team-join-requests-followup.md §6.
 * Never throws and never rejects: a failed send is logged and swallowed, and must not change the
 * outcome of the request or decision that triggered it.
 */
export async function notifyJoinRequestEvent(
  prisma: PrismaClient,
  event: JoinRequestEvent
): Promise<void> {
  try {
    const request = await loadRequest(prisma, event.requestId);
    if (!request || request.closeReason !== null || !request.team.isActive) {
      return;
    }
    if (!request.team.organization.isActive) {
      return;
    }
    const enabled = await resolveSetting('teams.joinRequestNotifications', {
      orgId: request.team.orgId,
      teamId: request.team.id,
    });
    if (!enabled) {
      return;
    }
    if (event.kind === 'created') {
      if (request.status !== 'PENDING_TEAM') {
        return;
      }
      await postCreated(request);
      return;
    }
    if (request.status !== STATUS_FOR_OUTCOME[event.outcome]) {
      return;
    }
    await emailDecision(prisma, request, event.outcome);
  } catch (err) {
    console.warn(
      `[join-request-notify] ${event.kind} notification for ${event.requestId} failed: ${(err as Error).message}`
    );
  }
}
