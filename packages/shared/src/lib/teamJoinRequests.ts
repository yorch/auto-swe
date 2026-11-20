import { z } from 'zod';
import { TEAM_ROLES } from '../permissions/roles.js';

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

export interface CooldownInput {
  /** When the requester's most recent request to this team was rejected; null if never. */
  lastRejectedAt: Date | null;
  now: Date;
  /** `teams.joinRequestCooldownHours`. `0` disables the cooldown. */
  cooldownHours: number;
}

export type CooldownResult =
  | { blocked: false }
  | {
      blocked: true;
      /** First instant a new request is allowed. */
      retryAt: Date;
      /** Whole seconds until then, rounded up; always at least 1. */
      retryAfterSeconds: number;
    };

/** Whether a rejection still blocks a new request to the same team. */
export function evaluateCooldown(input: CooldownInput): CooldownResult {
  const { lastRejectedAt, now, cooldownHours } = input;
  if (!lastRejectedAt || !(cooldownHours > 0)) {
    return { blocked: false };
  }
  const retryAt = new Date(lastRejectedAt.getTime() + cooldownHours * 3_600_000);
  const remainingMs = retryAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return { blocked: false };
  }
  return { blocked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000), retryAt };
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
