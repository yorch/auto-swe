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
