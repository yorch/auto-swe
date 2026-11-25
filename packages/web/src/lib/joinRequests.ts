import {
  type JoinRequestStatusValue,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
  MAX_JOIN_REQUEST_NOTE_LENGTH,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { ApiError } from './api';
import { errMsg } from './errors';
import type { TeamRoleValue } from './roleLabels';
import { DEFAULT_TEAM_ROLE, teamRoleRank } from './roleLabels';

/**
 * Pure helpers for the team directory and join requests: the shapes the gateway sends, the words
 * each status and relationship reads as, and the messages each refusal becomes. No React, so the
 * rules are tested directly.
 */

export type { JoinRequestStatusValue };
export { MAX_JOIN_REQUEST_MESSAGE_LENGTH, MAX_JOIN_REQUEST_NOTE_LENGTH };

export type JoinRelationship = 'MEMBER' | 'REQUESTED' | 'NONE';

export interface DirectoryTeam {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  orgId: string;
  orgName: string;
  memberCount: number;
  relationship: JoinRelationship;
  requestId?: string;
}

export interface CreatableOrg {
  id: string;
  name: string;
}

/** `GET /teams/directory`. */
export interface DirectoryPage {
  teams: DirectoryTeam[];
  creatableOrgs: CreatableOrg[];
  /**
   * Every organization with at least one team the viewer may see, sorted by name. Absent on a
   * gateway that predates it; the filter then falls back to the organizations seen in pages.
   */
  organizations?: CreatableOrg[];
  /** True when more organizations exist than `organizations` lists; the search endpoint has them. */
  organizationsTruncated?: boolean;
  /**
   * The deployment-wide default of `teams.directoryScope`. It is not the scope of this viewer's
   * results (an organization may override it), so the UI does not read it. Optional so a
   * response that omits it still parses.
   */
  scope?: 'platform' | 'organization';
  nextCursor: string | null;
}

/** `GET /teams/directory/organizations`: one page of the organizations the directory lists. */
export interface DirectoryOrganizationsPage {
  organizations: CreatableOrg[];
  nextCursor: string | null;
}

/** Why a request was closed by the platform instead of decided or withdrawn by a person. */
export type JoinRequestCloseReason =
  | 'REQUESTER_DEACTIVATED'
  | 'TEAM_DEACTIVATED'
  | 'ORGANIZATION_DEACTIVATED';

/** `GET /me/join-requests`: the caller's requests, newest first, cut at a fixed count. */
export interface MyJoinRequests {
  requests: JoinRequestRow[];
  /** True when the caller has more requests than the list carries. */
  truncated: boolean;
}

export interface JoinRequestPerson {
  id?: string;
  email?: string | null;
  name?: string | null;
}

/**
 * One join request, as `GET /me/join-requests`, `GET /teams/:id/join-requests` and the
 * organization queue send it. The contract fixes the columns of the stored row and says the
 * caller's list carries team and organization names; the requester appears as `requester` (or
 * `user`) on a reviewer's list.
 */
export interface JoinRequestRow {
  id: string;
  teamId: string;
  teamName?: string | null;
  teamSlug?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  userId?: string;
  requester?: JoinRequestPerson | null;
  user?: JoinRequestPerson | null;
  message: string;
  status: JoinRequestStatusValue;
  requiresOrgApproval: boolean;
  /** Set when the platform closed the request (a deactivation); null or absent when a person did. */
  closeReason?: JoinRequestCloseReason | null;
  grantedRole?: TeamRoleValue | null;
  teamDecisionNote?: string | null;
  orgDecisionNote?: string | null;
  teamDecidedAt?: string | null;
  orgDecidedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

/* ── Status ────────────────────────────────────────────────────────────────── */

const STATUS_LABELS: Record<JoinRequestStatusValue, string> = {
  APPROVED: 'Approved',
  PENDING_ORG: 'Pending organization approval',
  PENDING_TEAM: 'Pending team approval',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

const CLOSE_REASON_TEXT: Record<JoinRequestCloseReason, string> = {
  ORGANIZATION_DEACTIVATED: 'the organization was deactivated',
  REQUESTER_DEACTIVATED: 'the requester account was deactivated',
  TEAM_DEACTIVATED: 'the team was deactivated',
};

/** True for a close reason this client knows how to word. */
function knownCloseReason(reason: unknown): reason is JoinRequestCloseReason {
  return typeof reason === 'string' && reason in CLOSE_REASON_TEXT;
}

/**
 * "Closed automatically: the team was deactivated"; null when a person decided or withdrew.
 * An unknown reason (a newer gateway) still reads as a system close.
 */
export function joinCloseReasonText(reason: string | null | undefined): string | null {
  if (!reason) {
    return null;
  }
  return knownCloseReason(reason)
    ? `Closed automatically: ${CLOSE_REASON_TEXT[reason]}`
    : 'Closed automatically';
}

/**
 * An unknown status (a newer gateway) reads as itself. A request the platform closed reads as
 * "Closed automatically" instead of Rejected or Withdrawn, which would suggest a person acted.
 */
export function joinStatusLabel(status: string, closeReason?: string | null): string {
  if (closeReason && !isOpenJoinRequest(status)) {
    return 'Closed automatically';
  }
  return STATUS_LABELS[status as JoinRequestStatusValue] ?? status;
}

export type JoinStatusTone = 'warning' | 'success' | 'danger' | 'neutral' | 'info';

export function joinStatusTone(status: string): JoinStatusTone {
  switch (status) {
    case 'PENDING_TEAM':
      return 'warning';
    case 'PENDING_ORG':
      return 'info';
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Whether the requester may still withdraw. */
export function isOpenJoinRequest(status: string): boolean {
  return status === 'PENDING_TEAM' || status === 'PENDING_ORG';
}

/** The latest decision note on a request: the organization step's, else the team step's. */
export function decisionNote(row: Pick<JoinRequestRow, 'orgDecisionNote' | 'teamDecisionNote'>): {
  by: 'organization' | 'team';
  note: string;
} | null {
  const org = row.orgDecisionNote?.trim();
  if (org) {
    return { by: 'organization', note: org };
  }
  const team = row.teamDecisionNote?.trim();
  return team ? { by: 'team', note: team } : null;
}

/** Who a reviewer reads a request as coming from. */
export function requesterLabel(row: Pick<JoinRequestRow, 'requester' | 'user'>): string {
  const person = row.requester ?? row.user;
  return person?.name?.trim() || person?.email?.trim() || 'Unknown user';
}

/* ── Relationship ──────────────────────────────────────────────────────────── */

export interface DirectoryAction {
  /** The badge text beside the team name; null for a team the viewer has no tie to. */
  badge: 'Member' | 'Requested' | null;
  /** Whether Request to join is offered. */
  canRequest: boolean;
}

/** What a directory row offers for the viewer's relationship to the team. */
export function directoryAction(relationship: JoinRelationship): DirectoryAction {
  switch (relationship) {
    case 'MEMBER':
      return { badge: 'Member', canRequest: false };
    case 'REQUESTED':
      return { badge: 'Requested', canRequest: false };
    default:
      return { badge: null, canRequest: true };
  }
}

/* ── Message and note length ───────────────────────────────────────────────── */

export interface LengthState {
  count: number;
  remaining: number;
  over: boolean;
}

/** The counter shown under a capped text field. Counts characters as the server's `max` does. */
export function lengthState(value: string, max: number): LengthState {
  const count = value.length;
  return { count, over: count > max, remaining: max - count };
}

/** `{ message }` for POST /teams/:id/join-requests; trimmed, always present. */
export function buildCreateBody(message: string): { message: string } {
  return { message: message.trim() };
}

/* ── Approve / reject bodies and the role ceiling ──────────────────────────────── */

/**
 * The roles a team approver may name: the ones they may grant (`useGrantableTeamRoles`, which the
 * server's effective permissions decide), in rank order, lowest first. A role above the approver's
 * own rank is never offered. An empty list means they may not grant any role.
 */
export function approvalRoleOptions(grantable: readonly TeamRoleValue[]): TeamRoleValue[] {
  return [...new Set(grantable)]
    .filter((r) => teamRoleRank(r) >= 0)
    .sort((a, b) => teamRoleRank(a) - teamRoleRank(b));
}

/**
 * The body of a team-step approval. `role` is left out when it is the default (`MEMBER`) or not
 * offered, so the server applies its own default; an empty note is left out.
 */
export function buildApproveBody(input: {
  role: TeamRoleValue | '';
  note: string;
  allowed: readonly TeamRoleValue[];
}): { role?: TeamRoleValue; note?: string } {
  const body: { role?: TeamRoleValue; note?: string } = {};
  if (input.role && input.role !== DEFAULT_TEAM_ROLE && input.allowed.includes(input.role)) {
    body.role = input.role;
  }
  const note = input.note.trim();
  if (note) {
    body.note = note;
  }
  return body;
}

/** The body of a rejection, or of an organization-step decision. */
export function buildDecisionBody(note: string): { note?: string } {
  const trimmed = note.trim();
  return trimmed ? { note: trimmed } : {};
}

/* ── Slug ──────────────────────────────────────────────────────────────────── */

export const MAX_TEAM_SLUG_LENGTH = 50;
export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TEAM_DESCRIPTION_LENGTH = 500;

/** A lowercase-kebab slug from a team name; empty when the name has nothing usable. */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TEAM_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/** Whether `slug` is lowercase-kebab: words of letters and digits joined by single hyphens. */
export function isValidSlug(slug: string): boolean {
  return (
    slug.length > 0 && slug.length <= MAX_TEAM_SLUG_LENGTH && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
  );
}

/* ── Errors ────────────────────────────────────────────────────────────────── */

function retryAtFromDetails(details: unknown, now: Date): Date | null {
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const d = details as Record<string, unknown>;
  if (typeof d.retryAt === 'string') {
    const at = new Date(d.retryAt);
    if (!Number.isNaN(at.getTime())) {
      return at;
    }
  }
  const seconds = d.retryAfterSeconds ?? d.retryAfter;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return new Date(now.getTime() + seconds * 1000);
  }
  return null;
}

function cooldownReason(details: unknown): 'rejected' | 'withdrawn' {
  return typeof details === 'object' &&
    details !== null &&
    (details as Record<string, unknown>).reason === 'withdrawn'
    ? 'withdrawn'
    : 'rejected';
}

/** "in about 3 hours", "in 12 minutes"; null when the time has passed. */
export function retryIn(at: Date, now: Date): string | null {
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) {
    return null;
  }
  if (minutes < 60) {
    return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `in about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(hours / 24);
  return `in about ${days} days`;
}

/** The sentence a refused join request becomes. `now` is injectable for tests. */
export function joinRequestErrorMessage(err: unknown, now: Date = new Date()): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'ALREADY_MEMBER':
        return 'You are already a member of this team.';
      case 'REQUEST_PENDING':
        return 'You already have an open request for this team. Wait for a decision or withdraw it.';
      case 'JOIN_REQUEST_COOLDOWN': {
        const at = retryAtFromDetails(err.details, now);
        const when = at ? retryIn(at, now) : null;
        const lead =
          cooldownReason(err.details) === 'withdrawn'
            ? 'You withdrew a request to this team recently.'
            : 'A recent request to this team was rejected.';
        return when ? `${lead} You can ask again ${when}.` : `${lead} Try again later.`;
      }
      case 'TOO_MANY_OPEN_REQUESTS':
        return 'You have too many open requests. Withdraw one or wait for a decision before asking another team.';
      case 'TEAM_NOT_FOUND':
        return 'This team is no longer available to join.';
      default:
        if (err.status === 404) {
          return 'This team is no longer available to join.';
        }
    }
  }
  return errMsg(err, 'Could not send the request');
}

/** Whether the refusal means the directory row is stale and should be refetched. */
export function joinRequestErrorStalesDirectory(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === 'ALREADY_MEMBER' ||
      err.code === 'REQUEST_PENDING' ||
      err.code === 'TEAM_NOT_FOUND' ||
      err.status === 404)
  );
}

/** The sentence a refused decision (approve, reject, withdraw) becomes. */
export function decisionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'REQUEST_ALREADY_DECIDED':
      case 'REQUEST_NOT_OPEN':
        return 'This request was already decided or withdrawn. The list has been refreshed.';
      case 'REQUESTER_INACTIVE':
        return "The requester's account is deactivated; reject this request.";
      case 'TEAM_INACTIVE':
        return 'This team is deactivated.';
      case 'ALREADY_MEMBER':
        return 'The requester is already a member.';
      case 'PRIVILEGE_ESCALATION':
        return 'You cannot grant a role above your own.';
      case 'SELF_DECISION':
        return 'You cannot decide your own request.';
      default:
        break;
    }
    if (err.status === 404) {
      return 'This request no longer exists.';
    }
    if (err.status === 403) {
      return 'You do not have permission to decide this request.';
    }
  }
  return errMsg(err, fallback);
}

export interface CreateTeamError {
  field: 'name' | 'slug' | null;
  message: string;
}

/** The refusal of a team creation, with the field it belongs to where the server says. */
export function createTeamError(err: unknown): CreateTeamError {
  if (err instanceof ApiError) {
    if (err.code === 'TEAM_LIMIT_REACHED') {
      return {
        field: null,
        message:
          'You have reached the limit of teams you may create. Ask an administrator to raise it.',
      };
    }
    if (err.code === 'TEAM_EXISTS' || err.code === 'SLUG_TAKEN' || err.code === 'NAME_TAKEN') {
      const field = err.code === 'NAME_TAKEN' ? 'name' : err.code === 'SLUG_TAKEN' ? 'slug' : null;
      return {
        field,
        message: 'A team with this name or slug already exists. Choose another name or slug.',
      };
    }
    if (err.status === 403) {
      return {
        field: null,
        message: 'You may not create a team in this organization.',
      };
    }
  }
  return { field: null, message: errMsg(err, 'Failed to create team') };
}

/* ── Organization filter ─────────────────────────────────────────────────────── */

/**
 * The organizations the directory filter offers: every one seen in any page loaded so far, so
 * choosing one (which narrows the results to it) does not remove the others from the list.
 * Sorted by name.
 */
export function mergeOrgOptions(
  known: readonly CreatableOrg[],
  teams: readonly Pick<DirectoryTeam, 'orgId' | 'orgName'>[]
): CreatableOrg[] {
  const byId = new Map(known.map((o) => [o.id, o]));
  for (const t of teams) {
    if (t.orgId && !byId.has(t.orgId)) {
      byId.set(t.orgId, { id: t.orgId, name: t.orgName });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The options the filter offers. The gateway's own list (`listed`) is used when it sent one, so
 * every organization is offered whatever page or search is on screen. Without it (an older
 * gateway) the organizations seen so far stand in, as `mergeOrgOptions` accumulates them.
 */
export function directoryOrgOptions(input: {
  listed: readonly CreatableOrg[] | null | undefined;
  known: readonly CreatableOrg[];
  creatable: readonly CreatableOrg[];
}): CreatableOrg[] {
  if (input.listed) {
    return [...input.listed].sort((a, b) => a.name.localeCompare(b.name));
  }
  return mergeOrgOptions(
    input.known,
    input.creatable.map((o) => ({ orgId: o.id, orgName: o.name }))
  );
}

/* ── Combined approval ───────────────────────────────────────────────────────── */

export const COMBINED_APPROVAL_HINT =
  'You also manage this organization, so this approval completes the organization step too.';

/**
 * Whether a team-step approval of `row` also completes the organization step: the request crosses
 * organizations and the viewer holds `org.members.manage` for the request's organization
 * (`managesOrg`, from `useCan`). The server decides; this only words the dialog.
 */
export function approvalCompletesOrgStep(
  row: Pick<JoinRequestRow, 'requiresOrgApproval' | 'orgId'> | null,
  managesOrg: boolean
): boolean {
  return !!row && row.requiresOrgApproval && !!row.orgId && managesOrg;
}
