import { z } from 'zod';
import { TEAM_ROLES } from '../permissions/roles.js';
import { TEAM_ROLE_RANK } from '../permissions/standing.js';
import type { TeamRank } from '../permissions/types.js';

/**
 * Pure rules for team join requests, shared by the gateway, the CLI and the web client. No
 * database access: callers pass plain data in and act on the answer.
 *
 * A same-organization request is decided once by the team's managers. A cross-organization request
 * (`requiresOrgApproval`) is decided twice: the team step moves it to `PENDING_ORG`, then an admin
 * of the team's organization approves or rejects it.
 */

/** The values of the Prisma enum `JoinRequestStatus` (`joinRequests.test` pins them together). */
export const JOIN_REQUEST_STATUSES = [
  'PENDING_TEAM',
  'PENDING_ORG',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type JoinRequestStatusValue = (typeof JOIN_REQUEST_STATUSES)[number];

/** Statuses a request can still leave. At most one such request per user and team may exist. */
export const OPEN_JOIN_REQUEST_STATUSES = ['PENDING_TEAM', 'PENDING_ORG'] as const;

/** Statuses a request never leaves. */
export const FINAL_JOIN_REQUEST_STATUSES = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

/** The longest message a requester may attach, in characters. */
export const MAX_JOIN_REQUEST_MESSAGE_LENGTH = 500;

/** The longest decision note a reviewer may attach, in characters. */
export const MAX_JOIN_REQUEST_NOTE_LENGTH = 500;

/** Where a request in each status may go next. A final status maps to nothing. */
export const JOIN_REQUEST_TRANSITIONS: Readonly<
  Record<JoinRequestStatusValue, readonly JoinRequestStatusValue[]>
> = {
  APPROVED: [],
  PENDING_ORG: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  PENDING_TEAM: ['APPROVED', 'PENDING_ORG', 'REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
};

/** Whether the request is still awaiting a decision (it counts against the open-request cap). */
export function isOpenStatus(status: JoinRequestStatusValue): boolean {
  return (OPEN_JOIN_REQUEST_STATUSES as readonly string[]).includes(status);
}

/** Whether a request may move from `from` to `to`. A status never moves to itself. */
export function canTransition(from: JoinRequestStatusValue, to: JoinRequestStatusValue): boolean {
  return JOIN_REQUEST_TRANSITIONS[from].includes(to);
}

/**
 * The status a team-step approval leads to: the request is complete for a same-organization
 * requester and waits for the organization step otherwise.
 */
export function statusAfterTeamApproval(requiresOrgApproval: boolean): 'APPROVED' | 'PENDING_ORG' {
  return requiresOrgApproval ? 'PENDING_ORG' : 'APPROVED';
}

/** The values of the Prisma enum `JoinRequestCloseReason` (`teamJoinRequests.test` pins them together). */
export const JOIN_REQUEST_CLOSE_REASONS = [
  'REQUESTER_DEACTIVATED',
  'TEAM_DEACTIVATED',
  'ORGANIZATION_DEACTIVATED',
] as const;

export type JoinRequestCloseReasonValue = (typeof JOIN_REQUEST_CLOSE_REASONS)[number];

/**
 * Whether a closed request counts toward a cooldown. Only a request a person decided or withdrew
 * does (`closeReason` null); a close by the platform never starts a cooldown.
 */
export function countsTowardCooldown(row: {
  closeReason: JoinRequestCloseReasonValue | null | undefined;
}): boolean {
  return row.closeReason == null;
}

/** What a system close writes: the final status, the reason, and the decision note. */
export interface SystemClose {
  status: 'WITHDRAWN' | 'REJECTED';
  closeReason: JoinRequestCloseReasonValue;
  note: string;
}

/** The decision note written on a system close, per reason. */
export const SYSTEM_CLOSE_NOTES: Readonly<Record<JoinRequestCloseReasonValue, string>> = {
  ORGANIZATION_DEACTIVATED: 'Closed automatically: the organization was deactivated.',
  REQUESTER_DEACTIVATED: 'Closed automatically: the requester was deactivated.',
  TEAM_DEACTIVATED: 'Closed automatically: the team was deactivated.',
};

/**
 * How an open request is closed when the requester, the team or the organization is deactivated.
 * A deactivated requester withdraws; a deactivated team or organization rejects.
 */
export function systemCloseFor(reason: JoinRequestCloseReasonValue): SystemClose {
  return {
    closeReason: reason,
    note: SYSTEM_CLOSE_NOTES[reason],
    status: reason === 'REQUESTER_DEACTIVATED' ? 'WITHDRAWN' : 'REJECTED',
  };
}

export interface CooldownInput {
  /** When a person last rejected the requester's request to this team; null if never. */
  lastRejectedAt: Date | null;
  /** When the requester last withdrew their own request to this team; null if never. */
  lastWithdrawnAt?: Date | null;
  now: Date;
  /** `teams.joinRequestCooldownHours`. `0` disables the rejection cooldown. */
  cooldownHours: number;
  /** `teams.withdrawCooldownHours`. `0` or omitted disables the withdrawal cooldown. */
  withdrawCooldownHours?: number;
}

export type CooldownReason = 'rejected' | 'withdrawn';

export type CooldownResult =
  | { blocked: false }
  | {
      blocked: true;
      /** Which cooldown blocks; when both do, the one that lifts later. */
      reason: CooldownReason;
      /** First instant a new request is allowed. */
      retryAt: Date;
      /** Whole seconds until then, rounded up; always at least 1. */
      retryAfterSeconds: number;
    };

function retryAtOf(since: Date | null | undefined, hours: number | undefined, now: Date) {
  if (!since || !(hours !== undefined && hours > 0)) {
    return null;
  }
  const retryAt = new Date(since.getTime() + hours * 3_600_000);
  return retryAt.getTime() > now.getTime() ? retryAt : null;
}

/**
 * Whether a rejection or a withdrawal still blocks a new request to the same team. Callers pass
 * only the times of rows a person closed (`countsTowardCooldown`). When both cooldowns apply, the
 * later retry time wins and names the reason; a tie names `rejected`.
 */
export function evaluateCooldown(input: CooldownInput): CooldownResult {
  const { now } = input;
  const rejected = retryAtOf(input.lastRejectedAt, input.cooldownHours, now);
  const withdrawn = retryAtOf(input.lastWithdrawnAt, input.withdrawCooldownHours, now);
  let reason: CooldownReason;
  let retryAt: Date;
  if (rejected && (!withdrawn || rejected.getTime() >= withdrawn.getTime())) {
    reason = 'rejected';
    retryAt = rejected;
  } else if (withdrawn) {
    reason = 'withdrawn';
    retryAt = withdrawn;
  } else {
    return { blocked: false };
  }
  return {
    blocked: true,
    reason,
    retryAfterSeconds: Math.ceil((retryAt.getTime() - now.getTime()) / 1000),
    retryAt,
  };
}

export interface OpenCapInput {
  /** How many requests the user has open now (`PENDING_TEAM` plus `PENDING_ORG`). */
  openCount: number;
  /** `teams.maxOpenJoinRequests`. */
  maxOpen: number;
}

/** Whether the user is at the cap and so may not open another request. */
export function evaluateOpenCap(input: OpenCapInput): { blocked: boolean; remaining: number } {
  const remaining = Math.max(0, input.maxOpen - input.openCount);
  return { blocked: remaining === 0, remaining };
}

/** The role a request grants: the approver's choice, else `MEMBER`. */
export function resolveGrantedRole(
  chosen: (typeof TEAM_ROLES)[number] | null | undefined
): (typeof TEAM_ROLES)[number] {
  return chosen ?? 'MEMBER';
}

export interface ClampGrantedRoleInput {
  /** The role the team approver chose (null: the default, `MEMBER`). */
  granted: (typeof TEAM_ROLES)[number] | null | undefined;
  /** The team step's decider as the organization step finds them now. */
  teamApproverStanding: {
    /** The decider's account is still active (and the row still exists). */
    active: boolean;
    /** The decider still holds `team.members.manage` for the team. */
    canManageMembers: boolean;
    /** The decider's current acting rank in the team; null when they hold none. */
    rank: TeamRank | null;
  };
}

export interface ClampGrantedRoleResult {
  /** The role to apply. */
  role: (typeof TEAM_ROLES)[number];
  clamped: boolean;
  /** The role the team approver chose. */
  from: (typeof TEAM_ROLES)[number];
  /** The role applied (equals `role`). */
  to: (typeof TEAM_ROLES)[number];
}

/**
 * The organization-step re-check: the granted role stands only while the team approver is still
 * active, still holds `team.members.manage` and still acts at a rank no lower than the role they
 * granted (the member-add hierarchy rule: no grant above one's own rank). Otherwise it falls to
 * `MEMBER`. The request is never refused for this.
 */
export function clampGrantedRole(input: ClampGrantedRoleInput): ClampGrantedRoleResult {
  const from = resolveGrantedRole(input.granted);
  const { active, canManageMembers, rank } = input.teamApproverStanding;
  const withinRank =
    active && canManageMembers && rank !== null && TEAM_ROLE_RANK[from] <= TEAM_ROLE_RANK[rank];
  const to = withinRank ? from : 'MEMBER';
  return { clamped: to !== from, from, role: to, to };
}

/* ── Request bodies and queries (§7) ───────────────────────────────────────── */

const note = z.string().trim().max(MAX_JOIN_REQUEST_NOTE_LENGTH);

/** `POST /teams/:id/join-requests` */
export const createJoinRequestBodySchema = z.object({
  message: z.string().trim().max(MAX_JOIN_REQUEST_MESSAGE_LENGTH).default(''),
});
export type CreateJoinRequestBody = z.infer<typeof createJoinRequestBodySchema>;

/** `POST /teams/:id/join-requests/:requestId/approve` (the team step) */
export const approveJoinRequestBodySchema = z.object({
  note: note.optional(),
  role: z.enum(TEAM_ROLES).optional(),
});
export type ApproveJoinRequestBody = z.infer<typeof approveJoinRequestBodySchema>;

/** `POST .../reject` at either step, and `POST /platform/organizations/:orgId/join-requests/:requestId/approve` */
export const decideJoinRequestBodySchema = z.object({
  note: note.optional(),
});
export type DecideJoinRequestBody = z.infer<typeof decideJoinRequestBodySchema>;

/** `?status=` on the team and organization queues. */
export const joinRequestStatusSchema = z.enum(JOIN_REQUEST_STATUSES);

// ---------------------------------------------------------------------------------------------
// Notification outbox (`JoinRequestNotification`). Pure rules: the gateway's poller owns the I/O.
// ---------------------------------------------------------------------------------------------

/** The values of the Prisma enum `JoinRequestNotificationEvent`. */
export const JOIN_REQUEST_NOTIFICATION_EVENTS = [
  'CREATED',
  'APPROVED',
  'REJECTED',
  'PENDING_ORG',
] as const;
export type JoinRequestNotificationEventValue = (typeof JOIN_REQUEST_NOTIFICATION_EVENTS)[number];

/** The values of the Prisma enum `JoinRequestNotificationChannel`. */
export const JOIN_REQUEST_NOTIFICATION_CHANNELS = ['SLACK', 'EMAIL'] as const;
export type JoinRequestNotificationChannelValue =
  (typeof JOIN_REQUEST_NOTIFICATION_CHANNELS)[number];

/** The values of the Prisma enum `JoinRequestNotificationAudience`. */
export const JOIN_REQUEST_NOTIFICATION_AUDIENCES = [
  'TEAM_CHANNEL',
  'TEAM_REVIEWERS',
  'REQUESTER',
  'ORG_ADMINS',
] as const;
export type JoinRequestNotificationAudienceValue =
  (typeof JOIN_REQUEST_NOTIFICATION_AUDIENCES)[number];

/** The values of the Prisma enum `JoinRequestNotificationStatus`. */
export const JOIN_REQUEST_NOTIFICATION_STATUSES = [
  'PENDING',
  'DELIVERED',
  'SKIPPED',
  'FAILED',
] as const;
export type JoinRequestNotificationStatusValue =
  (typeof JOIN_REQUEST_NOTIFICATION_STATUSES)[number];

/**
 * Where a notification row may go next. `PENDING` ends as `DELIVERED`, `SKIPPED` or `FAILED`;
 * `FAILED` returns to `PENDING` only through an admin retry. `DELIVERED` and `SKIPPED` are final.
 */
export const JOIN_REQUEST_NOTIFICATION_TRANSITIONS: Readonly<
  Record<JoinRequestNotificationStatusValue, readonly JoinRequestNotificationStatusValue[]>
> = {
  DELIVERED: [],
  FAILED: ['PENDING'],
  PENDING: ['DELIVERED', 'SKIPPED', 'FAILED'],
  SKIPPED: [],
};

/** Whether a notification row may move from `from` to `to`. */
export function canTransitionNotification(
  from: JoinRequestNotificationStatusValue,
  to: JoinRequestNotificationStatusValue
): boolean {
  return JOIN_REQUEST_NOTIFICATION_TRANSITIONS[from].includes(to);
}

/** Whether an admin may re-queue a row in this status (only `FAILED`). */
export function isNotificationRetryable(status: JoinRequestNotificationStatusValue): boolean {
  return canTransitionNotification(status, 'PENDING');
}

/** Failed attempts after which a row stops retrying and is `FAILED`. */
export const MAX_NOTIFICATION_ATTEMPTS = 6;

/** Delay before the next attempt, indexed by the number of failed attempts so far minus one. */
export const NOTIFICATION_BACKOFF_MS: readonly number[] = [
  30_000, // 30 s
  120_000, // 2 min
  600_000, // 10 min
  3_600_000, // 1 h
  21_600_000, // 6 h
];

/**
 * When the poller may next claim a row that has now failed `attempts` times (so the first failure
 * is `attempts` 1), or `null` when the attempts are exhausted and the row becomes `FAILED`.
 */
export function nextAttempt(attempts: number, now: Date): Date | null {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    return null;
  }
  const delay = NOTIFICATION_BACKOFF_MS[attempts - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

export type NotificationFailureOutcome =
  | { status: 'PENDING'; attempts: number; nextAttemptAt: Date }
  | { status: 'FAILED'; attempts: number; nextAttemptAt: null };

/** What a failed send does to a row that had made `previousAttempts` failed attempts. */
export function outcomeAfterFailure(
  previousAttempts: number,
  now: Date
): NotificationFailureOutcome {
  const attempts = previousAttempts + 1;
  const next = nextAttempt(attempts, now);
  return next
    ? { attempts, nextAttemptAt: next, status: 'PENDING' }
    : { attempts, nextAttemptAt: null, status: 'FAILED' };
}

/** What an admin retry writes: attempts reset, due now, error cleared. */
export function retryReset(now: Date): {
  status: 'PENDING';
  attempts: 0;
  nextAttemptAt: Date;
  lastError: null;
} {
  return { attempts: 0, lastError: null, nextAttemptAt: now, status: 'PENDING' };
}

/** The most recipients one reviewer or organization-admin email goes to. */
export const MAX_NOTIFICATION_RECIPIENTS = 20;

/**
 * Fixed `lastError` vocabulary. A value is never an address, a body or a credential; the sender
 * maps every failure to one of these.
 */
export const JOIN_REQUEST_NOTIFICATION_ERROR_CODES = [
  'transport_not_configured',
  'transport_error',
  'slack_error',
  'no_recipients',
  'request_state_changed',
  'notifications_disabled',
  'party_inactive',
] as const;
export type JoinRequestNotificationErrorCode =
  (typeof JOIN_REQUEST_NOTIFICATION_ERROR_CODES)[number];

/** The channel an audience is delivered over. */
export const AUDIENCE_CHANNEL: Readonly<
  Record<JoinRequestNotificationAudienceValue, JoinRequestNotificationChannelValue>
> = {
  ORG_ADMINS: 'EMAIL',
  REQUESTER: 'EMAIL',
  TEAM_CHANNEL: 'SLACK',
  TEAM_REVIEWERS: 'EMAIL',
};

export interface NotificationRouteInput {
  event: JoinRequestNotificationEventValue;
  /** The team has a Slack channel and the workspace has a bot token. */
  teamHasSlackChannel: boolean;
  /** `teams.joinRequestReviewerEmail`. */
  reviewerEmailEnabled: boolean;
}

export interface NotificationRoute {
  audience: JoinRequestNotificationAudienceValue;
  channel: JoinRequestNotificationChannelValue;
}

/**
 * The outbox rows to write for an event. `CREATED` goes to the team's Slack channel when it has
 * one, otherwise to its reviewers by email when that is enabled (possibly none). `APPROVED` and
 * `REJECTED` go to the requester; `PENDING_ORG` to the requester and the organization's admins.
 */
export function routeAudiences(input: NotificationRouteInput): NotificationRoute[] {
  const audiences: JoinRequestNotificationAudienceValue[] = [];
  switch (input.event) {
    case 'CREATED':
      if (input.teamHasSlackChannel) {
        audiences.push('TEAM_CHANNEL');
      } else if (input.reviewerEmailEnabled) {
        audiences.push('TEAM_REVIEWERS');
      }
      break;
    case 'APPROVED':
    case 'REJECTED':
      audiences.push('REQUESTER');
      break;
    case 'PENDING_ORG':
      audiences.push('REQUESTER', 'ORG_ADMINS');
      break;
  }
  return audiences.map((audience) => ({ audience, channel: AUDIENCE_CHANNEL[audience] }));
}

/** Deduplicates (case-insensitively, keeping the first spelling) and caps a recipient list. */
export function capRecipients(
  recipients: readonly string[],
  max: number = MAX_NOTIFICATION_RECIPIENTS
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const recipient of recipients) {
    const key = recipient.trim().toLowerCase();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(recipient.trim());
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/**
 * The `reached` array after a partly successful send: the union of what was reached before and
 * now, deduplicated (case-insensitively) with the earlier spelling kept and order preserved. A
 * value that is not an array (a corrupt row) counts as empty.
 */
export function mergeReached(reached: unknown, newlyReached: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    const key = value.trim().toLowerCase();
    if (key === '' || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(value.trim());
  };
  if (Array.isArray(reached)) {
    for (const value of reached) {
      add(value);
    }
  }
  for (const value of newlyReached) {
    add(value);
  }
  return out;
}
