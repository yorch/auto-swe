import { createHash, createHmac } from 'node:crypto';
import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  currentKeyVersion,
  deriveSubkey,
  deriveSubkeyForVersion,
} from '@auto-swe/shared/lib/crypto';
import {
  resolveBetterAuthConfig,
  resolveSlackBotTokenForSlackChannel,
} from '@auto-swe/shared/lib/systemConfig';
import {
  capRecipients,
  type JoinRequestNotificationAudienceValue,
  type JoinRequestNotificationErrorCode,
  type JoinRequestNotificationEventValue,
  MAX_NOTIFICATION_RECIPIENTS,
  mergeReached,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { orgRolesAtLeast, teamRolesAtLeast } from '@auto-swe/shared/permissions';
import { escapeSlackMrkdwn } from './hitlSlackSync.js';
import { escapeHtml, sendNotificationEmailsEach } from './notificationEmail.js';
import { postSlackMessage } from './slack.js';

/**
 * Delivery of one join-request outbox row (docs/specs/2026-11-24-team-join-requests-hardening.md §5).
 *
 * `deliverJoinRequestNotification` is what the poller calls for a row it claimed. It loads the
 * request by id, decides whether the row is still worth sending, resolves the recipients NOW and
 * sends. It reports an outcome and writes nothing itself except through `persistReached`; the
 * poller records the outcome on the row. It never throws for an expected failure: every failure is
 * one of the fixed error codes, never a message, an address or a body.
 */

/** The row fields delivery reads. */
export interface OutboxRow {
  id: string;
  requestId: string;
  event: JoinRequestNotificationEventValue;
  audience: JoinRequestNotificationAudienceValue;
  /** Failed attempts so far. */
  attempts: number;
  /** The recorded keys of the recipients already reached (a JSON array). */
  reached: unknown;
}

export type DeliveryOutcome =
  | { kind: 'delivered'; reached: string[] }
  | { kind: 'skipped'; code: JoinRequestNotificationErrorCode; reached: string[] }
  | { kind: 'failed'; code: JoinRequestNotificationErrorCode; reached: string[] }
  /** The row's lease was taken over mid-delivery: nothing further was sent and nothing is recorded. */
  | { kind: 'lease_lost' }
  /**
   * The poller is stopping: nothing further was started. Not a failed attempt; the row goes back to
   * the queue due at once, with the recipients reached so far recorded.
   */
  | { kind: 'interrupted'; reached: string[] };

export interface DeliveryDeps {
  /** Replaces `https://slack.com/api`. Tests only. */
  slackApiBase?: string;
  /**
   * Called with the whole `reached` set after each recipient a send reaches, so a crash between two
   * recipients never resends to the first. The poller writes it to the row.
   */
  persistReached?: (reached: string[]) => Promise<void>;
  /**
   * Extends the row's lease and says whether it is still held. Called before each recipient and
   * before a Slack post, so one slow recipient cannot let the lease lapse under the ones after it;
   * `false` means another poller owns the row now, and delivery stops without sending.
   */
  renewLease?: () => Promise<boolean>;
  /**
   * True once the poller is stopping. Checked before each recipient and before a Slack post, never
   * during a send: a send that has started runs to its own deadline.
   */
  shouldStop?: () => boolean;
  /** Replaces the per-message email deadline (`NOTIFICATION_SEND_DEADLINE_MS`). Tests only. */
  emailDeadlineMs?: number;
  /**
   * Aborts a send that is in flight, for a gateway that is closing. An email send abandoned this
   * way has an unknown outcome, exactly like one that hit its deadline: the delivery ends as
   * `interrupted` (no failed attempt counted) and the recipient is not recorded, so the next
   * attempt sends to it again. It may already have been delivered, which is the at-least-once
   * duplicate the module comment on `sendEach` describes.
   */
  signal?: AbortSignal;
}

const MESSAGE_MAX_CHARS = 500;
const NOTE_MAX_CHARS = 1000;
/** Candidates read before deduplication and the cap, so a few duplicates do not shorten the list. */
const RECIPIENT_FETCH = MAX_NOTIFICATION_RECIPIENTS * 5;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Collapses whitespace, so a name with a line break cannot start a second header line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The web app's public origin: the first `CORS_ORIGIN` entry, the same one sign-in links use. */
function webBaseUrl(): string {
  return resolveBetterAuthConfig().clientOrigin.replace(/\/+$/, '');
}

/** The HKDF purpose string of the key `reachedKey` signs with; never reuse it for anything else. */
const REACHED_KEY_PURPOSE = 'auto-swe/join-request-reached/v1';
/** Marks the keyed form, so it can never be mistaken for the 32-hex unkeyed form it replaced. */
const REACHED_KEYED_PREFIX = 'k1:';

function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

function keyedReached(key: Buffer, address: string): string {
  return `${REACHED_KEYED_PREFIX}${createHmac('sha256', key)
    .update(normaliseAddress(address))
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * What `reached` stores for an address: a keyed hash (HMAC-SHA256, truncated to 128 bits) of the
 * lower-cased address. The key is derived from `CONFIG_ENCRYPTION_KEY` for this one purpose
 * (HKDF-SHA256, domain separated; the encryption key itself is never the MAC key), so a row at rest,
 * an export of it, and the users table together cannot be used to test a guessed address: that
 * needs the key. A retry still recognises who it already reached, because the same key yields the
 * same value. The only form ever written.
 */
export function reachedKey(address: string): string {
  return keyedReached(deriveSubkey(REACHED_KEY_PURPOSE).key, address);
}

/**
 * The unkeyed form earlier builds wrote: a SHA-256 of the lower-cased address with a fixed prefix.
 * Read, never written, so a row queued before the keyed form existed does not send again to a
 * recipient it already reached.
 */
function legacyReachedKey(address: string): string {
  return createHash('sha256')
    .update(`join-request-reached:${normaliseAddress(address)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Every spelling under which `address` counts as already reached: the keyed form under the
 * current `CONFIG_ENCRYPTION_KEY`, under `CONFIG_ENCRYPTION_KEY_PREVIOUS` while a rotation is in
 * flight, and the legacy unkeyed form. The first element is the one to write.
 *
 * After the previous key is dropped, an old-key entry no longer matches: a row still pending
 * across that moment can send once more to a recipient it had reached (a duplicate, never a
 * missed recipient). Rows do not live long enough for that to matter in practice, since they retry
 * for hours and are purged after the retention period.
 */
export function reachedKeyForms(address: string): string[] {
  const forms = [reachedKey(address)];
  const version = currentKeyVersion();
  if (version > 1) {
    const previous = deriveSubkeyForVersion(REACHED_KEY_PURPOSE, version - 1);
    if (previous) {
      forms.push(keyedReached(previous, address));
    }
  }
  forms.push(legacyReachedKey(address));
  return forms;
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
  return oneLine(request.user.name ?? '') || 'Someone';
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

/** The Slack text for a new request. Names the requester, never their address. */
function renderSlackCreated(request: LoadedRequest): string {
  const link = `${webBaseUrl()}/teams/${encodeURIComponent(request.team.slug)}/members`;
  const lines = [
    `*${escapeSlackMrkdwn(requesterLabel(request))}* asked to join *${escapeSlackMrkdwn(request.team.name)}* in ${escapeSlackMrkdwn(request.team.organization.name)}`,
  ];
  const message = clip(request.message, MESSAGE_MAX_CHARS);
  if (message) {
    lines.push(`> ${escapeSlackMrkdwn(message).replaceAll(/\r?\n/g, '\n> ')}`);
  }
  lines.push(`<${link}|Review the request>`);
  return lines.join('\n');
}

/** The reviewer email for a new request: the requester by name only, a link to the member page. */
function renderReviewerEmail(request: LoadedRequest): Rendered {
  const requester = requesterLabel(request);
  const team = oneLine(request.team.name);
  const paragraphs = [
    `${requester} asked to join ${team} in ${oneLine(request.team.organization.name)}.`,
  ];
  const message = clip(request.message, MESSAGE_MAX_CHARS);
  if (message) {
    paragraphs.push(`They wrote: ${message}`);
  }
  return render(
    `${requester} asked to join ${team}`,
    paragraphs,
    '',
    `${webBaseUrl()}/teams/${encodeURIComponent(request.team.slug)}/members`
  );
}

/** The email a requester gets for a decision, or for a request now waiting on the organization. */
function renderRequesterEmail(
  request: LoadedRequest,
  event: 'APPROVED' | 'REJECTED' | 'PENDING_ORG'
): Rendered {
  const team = oneLine(request.team.name);
  const org = oneLine(request.team.organization.name);
  const base = webBaseUrl();
  const note = clip(
    (request.orgDecidedAt ? request.orgDecisionNote : request.teamDecisionNote) ?? '',
    NOTE_MAX_CHARS
  );
  if (event === 'APPROVED') {
    return render(
      `You joined ${team}`,
      [`Your request to join ${team} was approved. You are now a member.`],
      note,
      `${base}/teams/${encodeURIComponent(request.team.slug)}`
    );
  }
  if (event === 'REJECTED') {
    return render(
      `Your request to join ${team}`,
      [`Your request to join ${team} was not approved.`],
      note,
      `${base}/teams`
    );
  }
  return render(
    `Your request to join ${team} is waiting for ${org}`,
    [
      `The ${team} team approved your request. It is now waiting for an administrator of ${org} to approve it.`,
    ],
    note,
    `${base}/teams`
  );
}

/** The email an organization admin gets for a request that needs them. */
function renderOrgAdminEmail(request: LoadedRequest): Rendered {
  const team = oneLine(request.team.name);
  return render(
    `A request to join ${team} needs your approval`,
    [
      `${requesterLabel(request)} asked to join ${team} in ${oneLine(request.team.organization.name)}. The team approved the request and it now needs an organization administrator.`,
    ],
    '',
    `${webBaseUrl()}/admin/organizations/${encodeURIComponent(request.team.orgId)}`
  );
}

const warnedNoTransport = new Set<string>();

/** Test hook: forget which no-transport warnings were printed. */
export function resetDeliveryWarningsForTests(): void {
  warnedNoTransport.clear();
}

function warnNoTransport(channel: 'email' | 'slack'): void {
  if (warnedNoTransport.has(channel)) {
    return;
  }
  warnedNoTransport.add(channel);
  console.warn(
    channel === 'email'
      ? '[join-request-notify] no email transport is configured (set SMTP_* or RESEND_API_KEY, plus AUTH_FROM_EMAIL); join-request emails are skipped'
      : '[join-request-notify] no Slack bot token resolves for a team channel; join-request Slack posts are skipped'
  );
}

/**
 * Sends `messages` one at a time, skipping every recipient already in `reached` and recording each
 * one reached. Delivered once all recipients are reached, failed when any is not.
 *
 * Delivery is at-least-once, never exactly-once. A recipient is recorded only after a transport
 * ACCEPTED the message, so a message whose outcome is unknown (abandoned at the send deadline, the
 * connection lost after the relay read it, a crash before `persistReached`) is not recorded and
 * the retry sends it again. That message may already have been delivered, and then the recipient
 * gets a second copy. No other recipient is repeated. A recipient counts as reached under any form
 * of its key (`reachedKeyForms`); only the current keyed form is written.
 */
async function sendEach(
  messages: Array<Rendered & { to: string }>,
  reachedBefore: unknown,
  deps: DeliveryDeps
): Promise<DeliveryOutcome> {
  let reached = mergeReached(reachedBefore, []);
  const done = new Set(reached);
  let failed = false;
  for (const message of messages) {
    const [key = '', ...otherForms] = reachedKeyForms(message.to);
    if (done.has(key) || otherForms.some((form) => done.has(form))) {
      continue;
    }
    if (deps.shouldStop?.()) {
      return { kind: 'interrupted', reached };
    }
    if (deps.renewLease && !(await deps.renewLease())) {
      return { kind: 'lease_lost' };
    }
    const result = await sendNotificationEmailsEach(
      'join-request-notify',
      [message],
      deps.emailDeadlineMs,
      deps.signal
    );
    if (!result.configured) {
      warnNoTransport('email');
      return { code: 'transport_not_configured', kind: 'skipped', reached };
    }
    if (result.delivered.length > 0) {
      done.add(key);
      reached = mergeReached(reached, [key]);
      await deps.persistReached?.(reached);
    } else if (result.aborted === true) {
      // Abandoned because the gateway is closing, not because the recipient failed: hand the row
      // back unpenalised. This recipient's outcome is unknown, so it is not recorded.
      return { kind: 'interrupted', reached };
    } else {
      failed = true;
    }
  }
  return failed
    ? { code: 'transport_error', kind: 'failed', reached }
    : { kind: 'delivered', reached };
}

async function reviewerEmails(prisma: PrismaClient, teamId: string): Promise<string[]> {
  const members = await runUnscoped(
    'a join-request notification lists the active leads and admins of the request team',
    ['TeamMembership', 'User'],
    () =>
      prisma.teamMembership.findMany({
        orderBy: { createdAt: 'asc' },
        select: { user: { select: { email: true } } },
        take: RECIPIENT_FETCH,
        where: { role: { in: teamRolesAtLeast('LEAD') }, teamId, user: { isActive: true } },
      })
  );
  return capRecipients(members.map((m) => m.user.email ?? ''));
}

async function orgAdminEmails(prisma: PrismaClient, orgId: string): Promise<string[]> {
  const admins = await runUnscoped(
    'a join-request notification lists the active admins of the request organization',
    ['OrganizationMembership', 'User'],
    () =>
      prisma.organizationMembership.findMany({
        orderBy: { createdAt: 'asc' },
        select: { user: { select: { email: true } } },
        take: RECIPIENT_FETCH,
        where: { orgId, role: { in: orgRolesAtLeast('ADMIN') }, user: { isActive: true } },
      })
  );
  const emails = capRecipients(
    admins.map((a) => a.user.email ?? ''),
    RECIPIENT_FETCH
  );
  if (emails.length > MAX_NOTIFICATION_RECIPIENTS) {
    console.warn(
      `[join-request-notify] organization ${orgId} has more than ${MAX_NOTIFICATION_RECIPIENTS} admins; emailing the first ${MAX_NOTIFICATION_RECIPIENTS}`
    );
  }
  return emails.slice(0, MAX_NOTIFICATION_RECIPIENTS);
}

const STATUS_FOR_EVENT: Record<JoinRequestNotificationEventValue, string> = {
  APPROVED: 'APPROVED',
  CREATED: 'PENDING_TEAM',
  PENDING_ORG: 'PENDING_ORG',
  REJECTED: 'REJECTED',
};

const skip = (code: JoinRequestNotificationErrorCode, row: OutboxRow): DeliveryOutcome => ({
  code,
  kind: 'skipped',
  reached: mergeReached(row.reached, []),
});

/**
 * Delivers one outbox row. Order of the refusals: the kill switch, then whether the request is
 * still in the state the event announces, then whether anyone involved is still active, then the
 * transport. Recipients are resolved here, at send time.
 */
export async function deliverJoinRequestNotification(
  prisma: PrismaClient,
  row: OutboxRow,
  deps: DeliveryDeps = {}
): Promise<DeliveryOutcome> {
  const request = await loadRequest(prisma, row.requestId);
  if (!request) {
    return skip('request_state_changed', row);
  }
  const enabled = await resolveSetting('teams.joinRequestNotifications', {
    orgId: request.team.orgId,
    teamId: request.team.id,
  });
  if (!enabled) {
    return skip('notifications_disabled', row);
  }
  if (request.closeReason !== null || request.status !== STATUS_FOR_EVENT[row.event]) {
    return skip('request_state_changed', row);
  }
  if (!(request.team.isActive && request.team.organization.isActive && request.user.isActive)) {
    return skip('party_inactive', row);
  }

  switch (row.audience) {
    case 'TEAM_CHANNEL': {
      const channel = request.team.slackNotifyChannel;
      if (!channel) {
        return skip('no_recipients', row);
      }
      const token = await resolveSlackBotTokenForSlackChannel(channel);
      if (!token) {
        warnNoTransport('slack');
        return skip('transport_not_configured', row);
      }
      if (deps.shouldStop?.()) {
        return { kind: 'interrupted', reached: mergeReached(row.reached, []) };
      }
      if (deps.renewLease && !(await deps.renewLease())) {
        return { kind: 'lease_lost' };
      }
      // The post is not idempotent: a timeout or a dropped answer (`null`) leaves it unknown whether
      // Slack posted, and the retry then posts again. A Slack error code is a definite refusal.
      const ts = await postSlackMessage(
        { channel, text: renderSlackCreated(request) },
        token,
        deps.slackApiBase ? { apiBase: deps.slackApiBase } : {}
      );
      return ts
        ? { kind: 'delivered', reached: mergeReached(row.reached, []) }
        : { code: 'slack_error', kind: 'failed', reached: mergeReached(row.reached, []) };
    }
    case 'TEAM_REVIEWERS': {
      const to = await reviewerEmails(prisma, request.team.id);
      if (to.length === 0) {
        return skip('no_recipients', row);
      }
      const rendered = renderReviewerEmail(request);
      return sendEach(
        to.map((address) => ({ to: address, ...rendered })),
        row.reached,
        deps
      );
    }
    case 'REQUESTER': {
      const email = request.user.email?.trim();
      if (!email || row.event === 'CREATED') {
        return skip('no_recipients', row);
      }
      const rendered = renderRequesterEmail(request, row.event);
      return sendEach([{ to: email, ...rendered }], row.reached, deps);
    }
    case 'ORG_ADMINS': {
      const to = await orgAdminEmails(prisma, request.team.orgId);
      if (to.length === 0) {
        return skip('no_recipients', row);
      }
      const rendered = renderOrgAdminEmail(request);
      return sendEach(
        to.map((address) => ({ to: address, ...rendered })),
        row.reached,
        deps
      );
    }
  }
}
