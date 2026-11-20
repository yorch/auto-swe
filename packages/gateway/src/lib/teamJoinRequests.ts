/**
 * Team directory and join requests (`docs/specs/2026-11-20-team-join-requests.md`).
 *
 * The routes in `routes/teamJoinRequests.ts` authenticate and shape the answer; the rules live
 * here so the transactional parts can be run against a real database (`teamJoinRequests.pg.test.ts`).
 * A function answers `{ ok: true, … }` or a `Refusal` the route sends as the gateway's error
 * envelope. Nothing here reads the request.
 *
 * Every state change is a conditional update on the status the caller read, inside a transaction
 * that holds the organization row lock and then the team's (the order every membership write takes
 * them in). A decision claims the request first, so a withdrawal or a second reviewer that arrives
 * later finds the status moved and loses: it matches no row and answers 409.
 */
import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  evaluateCooldown,
  evaluateOpenCap,
  isOpenStatus,
  type JoinRequestStatusValue,
  OPEN_JOIN_REQUEST_STATUSES,
  resolveGrantedRole,
  statusAfterTeamApproval,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  actingRank,
  heldScope,
  loadStanding,
  TEAM_ROLE_RANK,
  type TeamRank,
  type TeamRoleValue,
  teamRankOf,
  userActor,
} from '@auto-swe/shared/permissions';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import type { AuditContext } from './auditContext.js';
import { writeAuditLog } from './auditLog.js';
import { isUniqueConstraintError } from './prismaErrors.js';

type Db = FastifyInstance['prisma'];

/** A refusal the route sends as `{ error: { code, message } }`. */
export interface Refusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 429;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** Seconds, for a `429`'s `Retry-After` header. */
  retryAfterSeconds?: number;
}

export type Outcome<T> = ({ ok: true } & T) | Refusal;

function refuse(
  status: Refusal['status'],
  code: string,
  message: string,
  extra: Partial<Pick<Refusal, 'details' | 'retryAfterSeconds'>> = {}
): Refusal {
  return { code, message, ok: false, status, ...extra };
}

const OPEN = [...OPEN_JOIN_REQUEST_STATUSES];

/* ── Views ─────────────────────────────────────────────────────────────────── */

const REQUEST_SELECT = {
  createdAt: true,
  grantedRole: true,
  id: true,
  message: true,
  orgDecidedAt: true,
  orgDecisionNote: true,
  requiresOrgApproval: true,
  status: true,
  team: {
    select: {
      id: true,
      name: true,
      organization: { select: { name: true } },
      orgId: true,
      slug: true,
    },
  },
  teamDecidedAt: true,
  teamDecisionNote: true,
  teamId: true,
  updatedAt: true,
  userId: true,
} satisfies Prisma.TeamJoinRequestSelect;

type RequestRow = Prisma.TeamJoinRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

/** A request as its requester sees it: the team, the organization and the decisions, no person. */
export interface RequesterView {
  createdAt: Date;
  grantedRole: TeamRoleValue | null;
  id: string;
  message: string;
  orgDecidedAt: Date | null;
  orgDecisionNote: string | null;
  orgId: string;
  orgName: string;
  requiresOrgApproval: boolean;
  status: JoinRequestStatusValue;
  teamDecidedAt: Date | null;
  teamDecisionNote: string | null;
  teamId: string;
  teamName: string;
  teamSlug: string;
  updatedAt: Date;
}

/** A request as a reviewer sees it: the requester's name and email are theirs to read. */
export interface ReviewerView extends RequesterView {
  requester: { email: string; id: string; name: string | null };
}

export function requesterView(row: RequestRow): RequesterView {
  return {
    createdAt: row.createdAt,
    grantedRole: row.grantedRole,
    id: row.id,
    message: row.message,
    orgDecidedAt: row.orgDecidedAt,
    orgDecisionNote: row.orgDecisionNote,
    orgId: row.team.orgId,
    orgName: row.team.organization.name,
    requiresOrgApproval: row.requiresOrgApproval,
    status: row.status,
    teamDecidedAt: row.teamDecidedAt,
    teamDecisionNote: row.teamDecisionNote,
    teamId: row.teamId,
    teamName: row.team.name,
    teamSlug: row.team.slug,
    updatedAt: row.updatedAt,
  };
}

const REVIEWER_SELECT = {
  ...REQUEST_SELECT,
  user: { select: { email: true, id: true, name: true } },
} satisfies Prisma.TeamJoinRequestSelect;

type ReviewerRow = Prisma.TeamJoinRequestGetPayload<{ select: typeof REVIEWER_SELECT }>;

export function reviewerView(row: ReviewerRow): ReviewerView {
  const { user, ...rest } = row;
  return {
    ...requesterView(rest),
    requester: { email: user.email, id: user.id, name: user.name },
  };
}

function requestAuditFields(row: {
  grantedRole: string | null;
  id: string;
  requiresOrgApproval: boolean;
  status: string;
  teamId: string;
  userId: string;
}) {
  return {
    grantedRole: row.grantedRole,
    id: row.id,
    requiresOrgApproval: row.requiresOrgApproval,
    status: row.status,
    teamId: row.teamId,
    userId: row.userId,
  };
}

function membershipAuditFields(row: { role: string; teamId: string; userId: string }) {
  return { role: row.role, teamId: row.teamId, userId: row.userId };
}

/* ── Directory ─────────────────────────────────────────────────────────────── */

export type DirectoryScope = 'platform' | 'organization';

export interface DirectoryQuery {
  /** Case-insensitive search over name, slug and description. */
  q?: string;
  orgId?: string;
  limit: number;
  /** The opaque `nextCursor` of the previous page. */
  cursor?: string;
}

interface Viewer {
  role: string;
  sub: string;
}

/** `teams.directoryScope` (platform-wide, so it takes no context). */
export function directoryScope(): Promise<DirectoryScope> {
  return resolveSetting('teams.directoryScope');
}

/** The organizations the viewer belongs to. Their own rows, by user, so named unscoped. */
async function memberOrgIdsOf(prisma: Db, userId: string): Promise<string[]> {
  const rows = await runUnscoped(
    "the viewer's own organization memberships",
    ['OrganizationMembership'],
    () =>
      prisma.organizationMembership.findMany({
        select: { orgId: true },
        where: { userId },
      })
  );
  return rows.map((r) => r.orgId);
}

/** How many teams `userId` created through self-service creation (active ones, in any organization). */
export function countCreatedTeams(db: Prisma.TransactionClient | Db, userId: string) {
  return runUnscoped('the number of teams one user created, across organizations', ['Team'], () =>
    db.team.count({ where: { createdById: userId, isActive: true } })
  );
}

function encodeCursor(name: string): string {
  return Buffer.from(JSON.stringify({ n: name }), 'utf8').toString('base64url');
}

/** The team name a cursor resumes after, or `null` for a cursor this API did not issue. */
function decodeCursor(cursor: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const name = (parsed as { n?: unknown } | null)?.n;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Organizations where `viewer` may create a team now: those where they hold `org.teams.create`
 * (administrators of the organization, and platform administrators for every active one), plus those
 * they belong to where `teams.selfServiceCreation` is on and they are under `teams.maxCreatedPerUser`.
 * The administrator path is never limited by the cap.
 */
export async function loadCreatableOrgs(
  prisma: Db,
  viewer: Viewer,
  memberOrgIds: readonly string[]
): Promise<Array<{ id: string; name: string }>> {
  const held = await heldScope(prisma, userActor(viewer), 'org.teams.create');
  const adminOrgs =
    held.all || held.orgIds.length > 0
      ? await prisma.organization.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
          take: 500,
          where: { isActive: true, ...(held.all ? {} : { id: { in: held.orgIds } }) },
        })
      : [];
  const adminIds = new Set(adminOrgs.map((o) => o.id));

  const candidates = memberOrgIds.filter((id) => !adminIds.has(id));
  const policies = await Promise.all(
    candidates.map(async (orgId) => ({
      enabled: await resolveSetting('teams.selfServiceCreation', { orgId }),
      limit: await resolveSetting('teams.maxCreatedPerUser', { orgId }),
      orgId,
    }))
  );
  const enabled = policies.filter((p) => p.enabled);
  let selfServiceOrgs: Array<{ id: string; name: string }> = [];
  if (enabled.length > 0) {
    const created = await countCreatedTeams(prisma, viewer.sub);
    const allowed = enabled.filter((p) => created < p.limit).map((p) => p.orgId);
    if (allowed.length > 0) {
      selfServiceOrgs = await prisma.organization.findMany({
        select: { id: true, name: true },
        where: { id: { in: allowed }, isActive: true },
      });
    }
  }
  return [...adminOrgs, ...selfServiceOrgs].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The directory page for `viewer`: active teams, public fields only. It lists no member, repository
 * or setting, and `requestId` is the viewer's own open request.
 */
export async function loadDirectory(prisma: Db, viewer: Viewer, query: DirectoryQuery) {
  const scope = await directoryScope();
  const memberOrgIds = await memberOrgIdsOf(prisma, viewer.sub);

  let after: string | null = null;
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor);
    if (after === null) {
      return refuse(400, 'INVALID_CURSOR', 'The cursor is not one this API issued');
    }
  }

  // A team of a deactivated organization is not joinable, so it is not listed.
  const and: Prisma.TeamWhereInput[] = [{ isActive: true, organization: { isActive: true } }];
  if (scope === 'organization') {
    and.push({ orgId: { in: memberOrgIds } });
  }
  if (query.orgId) {
    and.push({ orgId: query.orgId });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({ OR: [{ name: contains }, { slug: contains }, { description: contains }] });
  }
  if (after !== null) {
    and.push({ name: { gt: after } });
  }

  // The directory is deliberately platform-wide: it names every active team the scope allows and
  // only their public fields, so it carries an explicit exemption instead of a tenant predicate.
  const rows = await runUnscoped('the team directory lists public team fields', ['Team'], () =>
    prisma.team.findMany({
      orderBy: { name: 'asc' },
      select: {
        description: true,
        id: true,
        name: true,
        organization: { select: { name: true } },
        orgId: true,
        slug: true,
      },
      take: query.limit + 1,
      where: { AND: and },
    })
  );
  const page = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit ? encodeCursor(page[page.length - 1]?.name ?? '') : null;
  const ids = page.map((t) => t.id);

  const [counts, memberOf, open, creatableOrgs] = await Promise.all([
    ids.length > 0
      ? prisma.teamMembership.groupBy({
          _count: { _all: true },
          by: ['teamId'],
          // A deactivated user is not a member anyone could ask to join alongside.
          where: { teamId: { in: ids }, user: { isActive: true } },
        })
      : Promise.resolve([]),
    ids.length > 0
      ? prisma.teamMembership.findMany({
          select: { teamId: true },
          where: { teamId: { in: ids }, userId: viewer.sub },
        })
      : Promise.resolve([]),
    ids.length > 0
      ? prisma.teamJoinRequest.findMany({
          select: { id: true, teamId: true },
          where: { status: { in: OPEN }, teamId: { in: ids }, userId: viewer.sub },
        })
      : Promise.resolve([]),
    loadCreatableOrgs(prisma, viewer, memberOrgIds),
  ]);
  const sizeOf = new Map(counts.map((c) => [c.teamId, c._count._all]));
  const memberSet = new Set(memberOf.map((m) => m.teamId));
  const requestOf = new Map(open.map((r) => [r.teamId, r.id]));

  const teams = page.map((t) => {
    const requestId = requestOf.get(t.id);
    const relationship = memberSet.has(t.id) ? 'MEMBER' : requestId ? 'REQUESTED' : 'NONE';
    return {
      description: t.description,
      id: t.id,
      memberCount: sizeOf.get(t.id) ?? 0,
      name: t.name,
      orgId: t.orgId,
      orgName: t.organization.name,
      relationship,
      ...(relationship === 'REQUESTED' && requestId ? { requestId } : {}),
      slug: t.slug,
    } as const;
  });
  return { creatableOrgs, nextCursor, ok: true as const, scope, teams };
}

/**
 * The team, if `viewer` may see it in the directory: active, in an active organization, and inside
 * the directory scope. An unknown team, an inactive one (or of an inactive organization) and one
 * outside the scope are the same answer.
 */
async function visibleTeam(prisma: Db, viewerId: string, teamId: string) {
  const team = await prisma.team.findUnique({
    select: {
      id: true,
      isActive: true,
      name: true,
      organization: { select: { isActive: true } },
      orgId: true,
    },
    where: { id: teamId },
  });
  if (!team?.isActive || !team.organization.isActive) {
    return null;
  }
  if ((await directoryScope()) === 'organization') {
    const member = await prisma.organizationMembership.findUnique({
      select: { id: true },
      where: { userId_orgId: { orgId: team.orgId, userId: viewerId } },
    });
    if (!member) {
      return null;
    }
  }
  return team;
}

/* ── Locks ─────────────────────────────────────────────────────────────────── */

/**
 * The organization's row lock, then the team's: the order every membership write takes them in, so
 * an organization removal (which deletes the team memberships under the same two locks) cannot
 * interleave with an approval.
 */
async function lockOrgThenTeam(tx: Prisma.TransactionClient, orgId: string, teamId: string) {
  // CLAUDE.md §7 exception: the organization lock serializes this membership write with an
  // organization removal, which deletes the user's team memberships under the same lock.
  await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
  // CLAUDE.md §7 exception: the team lock every membership write takes, after the organization's.
  await tx.$executeRaw`SELECT 1 FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`;
}

/** Whether a role is above `rank`. */
function exceeds(role: string, rank: TeamRank): boolean {
  return TEAM_ROLE_RANK[teamRankOf(role) ?? 'MEMBER'] > TEAM_ROLE_RANK[rank];
}

/* ── Requester side ────────────────────────────────────────────────────────── */

/** `POST /teams/:id/join-requests` */
export async function createJoinRequest(
  fastify: FastifyInstance,
  input: { actor: JwtPayload; context: AuditContext; message: string; teamId: string }
): Promise<Outcome<{ request: RequesterView }>> {
  const { actor, context, message, teamId } = input;
  const prisma = fastify.prisma;
  const team = await visibleTeam(prisma, actor.sub, teamId);
  if (!team) {
    return refuse(404, 'TEAM_NOT_FOUND', 'Team not found');
  }
  const member = await prisma.teamMembership.findUnique({
    select: { id: true },
    where: { userId_teamId: { teamId, userId: actor.sub } },
  });
  if (member) {
    return refuse(409, 'ALREADY_MEMBER', 'You are already a member of this team');
  }
  const pending = await prisma.teamJoinRequest.findFirst({
    select: { id: true },
    where: { status: { in: OPEN }, teamId, userId: actor.sub },
  });
  if (pending) {
    return refuse(409, 'REQUEST_PENDING', 'You already have an open request for this team', {
      details: { requestId: pending.id },
    });
  }
  const [cooldownHours, maxOpen] = await Promise.all([
    resolveSetting('teams.joinRequestCooldownHours'),
    resolveSetting('teams.maxOpenJoinRequests'),
  ]);
  const rejected = await prisma.teamJoinRequest.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { orgDecidedAt: true, teamDecidedAt: true, updatedAt: true },
    where: { status: 'REJECTED', teamId, userId: actor.sub },
  });
  const cooldown = evaluateCooldown({
    cooldownHours,
    lastRejectedAt: rejected
      ? (rejected.orgDecidedAt ?? rejected.teamDecidedAt ?? rejected.updatedAt)
      : null,
    now: new Date(),
  });
  if (cooldown.blocked) {
    return refuse(
      429,
      'JOIN_REQUEST_COOLDOWN',
      'This team rejected your last request; you may ask again later',
      {
        details: { retryAfterSeconds: cooldown.retryAfterSeconds, retryAt: cooldown.retryAt },
        retryAfterSeconds: cooldown.retryAfterSeconds,
      }
    );
  }
  const inOrg = await prisma.organizationMembership.findUnique({
    select: { id: true },
    where: { userId_orgId: { orgId: team.orgId, userId: actor.sub } },
  });

  try {
    return await prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock. It
      // serializes one person's requests, so two at once cannot both pass the open-request cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`join-request:${actor.sub}`}, 0))`;
      const openCount = await runUnscoped(
        "the number of the caller's own open join requests",
        ['TeamJoinRequest'],
        () => tx.teamJoinRequest.count({ where: { status: { in: OPEN }, userId: actor.sub } })
      );
      if (evaluateOpenCap({ maxOpen, openCount }).blocked) {
        return refuse(
          429,
          'TOO_MANY_OPEN_REQUESTS',
          `You may have at most ${maxOpen} open requests`
        );
      }
      const created = await tx.teamJoinRequest.create({
        data: { message, requiresOrgApproval: !inOrg, teamId, userId: actor.sub },
        select: REQUEST_SELECT,
      });
      await writeAuditLog(fastify, {
        action: 'CREATE',
        actor,
        after: requestAuditFields(created),
        client: tx,
        context,
        entityId: created.id,
        entityType: 'TeamJoinRequest',
      });
      return { ok: true as const, request: requesterView(created) };
    });
  } catch (err) {
    // The partial unique index decides a concurrent double request.
    if (isUniqueConstraintError(err)) {
      return refuse(409, 'REQUEST_PENDING', 'You already have an open request for this team');
    }
    throw err;
  }
}

/** How many of their own requests `GET /me/join-requests` returns; `truncated` says more exist. */
const OWN_REQUESTS_LIMIT = 200;

/** `GET /me/join-requests`: the caller's own requests, newest first. */
export async function listOwnRequests(
  prisma: Db,
  userId: string
): Promise<{ requests: RequesterView[]; truncated: boolean }> {
  const rows = await runUnscoped("the caller's own join requests", ['TeamJoinRequest'], () =>
    prisma.teamJoinRequest.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: REQUEST_SELECT,
      take: OWN_REQUESTS_LIMIT + 1,
      where: { userId },
    })
  );
  return {
    requests: rows.slice(0, OWN_REQUESTS_LIMIT).map(requesterView),
    truncated: rows.length > OWN_REQUESTS_LIMIT,
  };
}

/** `POST /me/join-requests/:requestId/withdraw` */
export async function withdrawRequest(
  fastify: FastifyInstance,
  input: { actor: JwtPayload; context: AuditContext; requestId: string }
): Promise<Outcome<{ request: RequesterView }>> {
  const { actor, context, requestId } = input;
  // Another person's request answers as an unknown one.
  const row = await fastify.prisma.teamJoinRequest.findFirst({
    select: REQUEST_SELECT,
    where: { id: requestId, userId: actor.sub },
  });
  if (!row) {
    return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  if (!isOpenStatus(row.status)) {
    return refuse(409, 'REQUEST_NOT_OPEN', 'Only an open request can be withdrawn');
  }
  return fastify.prisma.$transaction(async (tx) => {
    const claim = await tx.teamJoinRequest.updateMany({
      data: { status: 'WITHDRAWN' },
      where: { id: row.id, status: row.status, teamId: row.teamId, userId: actor.sub },
    });
    if (claim.count !== 1) {
      return refuse(
        409,
        'REQUEST_ALREADY_DECIDED',
        'The request was decided before it was withdrawn'
      );
    }
    const after = await tx.teamJoinRequest.findFirstOrThrow({
      select: REQUEST_SELECT,
      where: { id: row.id, teamId: row.teamId },
    });
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: requestAuditFields(after),
      before: requestAuditFields(row),
      client: tx,
      context,
      entityId: row.id,
      entityType: 'TeamJoinRequest',
    });
    return { ok: true as const, request: requesterView(after) };
  });
}

/* ── Reviewer queues ───────────────────────────────────────────────────────── */

/** `?status=` on a queue: one status, or every one. */
export type StatusFilter = JoinRequestStatusValue | 'ALL';

/** `GET /teams/:id/join-requests` (the caller holds `team.members.manage`). */
export async function listTeamRequests(
  prisma: Db,
  teamId: string,
  status: StatusFilter,
  limit: number
): Promise<ReviewerView[]> {
  const rows = await prisma.teamJoinRequest.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: REVIEWER_SELECT,
    take: limit,
    where: { teamId, ...(status === 'ALL' ? {} : { status }) },
  });
  return rows.map(reviewerView);
}

/**
 * `GET /platform/organizations/:orgId/join-requests` (the caller holds `org.members.manage`): the
 * cross-organization requests for the organization's teams. A same-organization request never needs
 * the organization step and is not listed.
 */
export async function listOrgRequests(
  prisma: Db,
  orgId: string,
  status: StatusFilter,
  limit: number
): Promise<ReviewerView[]> {
  const rows = await prisma.teamJoinRequest.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: REVIEWER_SELECT,
    take: limit,
    where: {
      requiresOrgApproval: true,
      team: { orgId },
      ...(status === 'ALL' ? {} : { status }),
    },
  });
  return rows.map(reviewerView);
}

/* ── Decisions ─────────────────────────────────────────────────────────────── */

interface DecisionInput {
  actor: JwtPayload;
  context: AuditContext;
  note?: string | undefined;
  requestId: string;
}

/**
 * Writes `userId`'s team membership as the grant the request carries, unless one exists, and audits
 * it. The caller holds the team's lock, so the read and the create cannot interleave with another
 * membership write.
 */
async function grantTeamMembership(
  fastify: FastifyInstance,
  tx: Prisma.TransactionClient,
  args: {
    actor: JwtPayload;
    context: AuditContext;
    role: TeamRoleValue;
    teamId: string;
    userId: string;
  }
): Promise<void> {
  const { actor, context, role, teamId, userId } = args;
  const created = await tx.teamMembership.create({ data: { role, teamId, userId } });
  await writeAuditLog(fastify, {
    action: 'CREATE',
    actor,
    after: membershipAuditFields(created),
    client: tx,
    context,
    entityId: created.id,
    entityType: 'TeamMembership',
  });
}

/** The team step: approve (`PENDING_TEAM` → `APPROVED` or `PENDING_ORG`) with an optional role. */
export async function approveAtTeamStep(
  fastify: FastifyInstance,
  input: DecisionInput & { role?: TeamRoleValue | undefined; teamId: string }
): Promise<Outcome<{ request: ReviewerView }>> {
  const { actor, context, requestId, teamId } = input;
  const prisma = fastify.prisma;
  const team = await prisma.team.findUnique({
    select: { id: true, isActive: true, orgId: true },
    where: { id: teamId },
  });
  if (!team) {
    return refuse(404, 'TEAM_NOT_FOUND', 'Team not found');
  }
  // A request of another team answers as an unknown one.
  const seen = await prisma.teamJoinRequest.findFirst({
    select: { userId: true },
    where: { id: requestId, teamId },
  });
  if (!seen) {
    return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  if (seen.userId === actor.sub) {
    return refuse(403, 'SELF_DECISION', 'You cannot decide your own request');
  }
  if (!team.isActive) {
    return refuse(409, 'TEAM_INACTIVE', 'The team is no longer active');
  }
  // The hierarchy rule of member-add: no grant above the rank the approver acts at in this team.
  const role = resolveGrantedRole(input.role);
  const rank = actingRank(await loadStanding(prisma, userActor(actor), { teamId }), teamId);
  if (!rank) {
    return refuse(403, 'FORBIDDEN', 'You have no standing in this team');
  }
  if (exceeds(role, rank)) {
    return refuse(403, 'PRIVILEGE_ESCALATION', 'Cannot grant a role higher than your own');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await lockOrgThenTeam(tx, team.orgId, team.id);
      const row = await tx.teamJoinRequest.findFirst({
        select: REQUEST_SELECT,
        where: { id: requestId, teamId },
      });
      if (!row) {
        return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
      }
      if (row.status !== 'PENDING_TEAM') {
        return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request is no longer awaiting the team');
      }
      const [current, requester, inOrg, member] = await Promise.all([
        tx.team.findUnique({ select: { isActive: true }, where: { id: teamId } }),
        tx.user.findUnique({ select: { isActive: true }, where: { id: row.userId } }),
        tx.organizationMembership.findUnique({
          select: { id: true },
          where: { userId_orgId: { orgId: team.orgId, userId: row.userId } },
        }),
        tx.teamMembership.findUnique({
          select: { id: true, role: true },
          where: { userId_teamId: { teamId, userId: row.userId } },
        }),
      ]);
      if (!current?.isActive) {
        return refuse(409, 'TEAM_INACTIVE', 'The team is no longer active');
      }
      if (!requester?.isActive) {
        return refuse(409, 'REQUESTER_INACTIVE', 'The requester is no longer an active user');
      }
      // Someone who joined since asking keeps the role they hold; the request records that one,
      // not the role the approver named, so the requester's own view is truthful.
      const granted = member ? member.role : role;
      // The organization membership is read now, under its lock: whoever is in the organization
      // needs no second decision, and whoever left it since asking needs one.
      const needsOrg = !inOrg;
      const next = member ? 'APPROVED' : statusAfterTeamApproval(needsOrg);
      const claim = await tx.teamJoinRequest.updateMany({
        data: {
          grantedRole: granted,
          requiresOrgApproval: needsOrg,
          status: next,
          teamDecidedAt: new Date(),
          teamDecidedById: actor.sub,
          teamDecisionNote: input.note ?? null,
        },
        where: { id: requestId, status: 'PENDING_TEAM', teamId },
      });
      if (claim.count !== 1) {
        return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request was decided by someone else');
      }
      if (next === 'APPROVED' && !member) {
        await grantTeamMembership(fastify, tx, {
          actor,
          context,
          role,
          teamId,
          userId: row.userId,
        });
      }
      const after = await tx.teamJoinRequest.findFirstOrThrow({
        select: REVIEWER_SELECT,
        where: { id: requestId, teamId },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: requestAuditFields(after),
        before: requestAuditFields(row),
        client: tx,
        context,
        entityId: requestId,
        entityType: 'TeamJoinRequest',
      });
      return { ok: true as const, request: reviewerView(after) };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return refuse(409, 'ALREADY_MEMBER', 'The requester is already a member of this team');
    }
    throw err;
  }
}

/**
 * A rejection at either step: `from` → `REJECTED`. Nothing but the request changes, so it needs no
 * membership lock; the conditional update on `from` is the whole guard.
 */
async function reject(
  fastify: FastifyInstance,
  input: DecisionInput & { from: 'PENDING_ORG' | 'PENDING_TEAM'; teamId: string }
): Promise<Outcome<{ request: ReviewerView }>> {
  const { actor, context, from, requestId, teamId } = input;
  const row = await fastify.prisma.teamJoinRequest.findFirst({
    select: REQUEST_SELECT,
    where: { id: requestId, teamId },
  });
  if (!row) {
    return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  if (row.userId === actor.sub) {
    return refuse(403, 'SELF_DECISION', 'You cannot decide your own request');
  }
  if (row.status !== from) {
    return refuse(
      409,
      'REQUEST_ALREADY_DECIDED',
      'The request is no longer awaiting this decision'
    );
  }
  const decided =
    from === 'PENDING_TEAM'
      ? {
          teamDecidedAt: new Date(),
          teamDecidedById: actor.sub,
          teamDecisionNote: input.note ?? null,
        }
      : {
          orgDecidedAt: new Date(),
          orgDecidedById: actor.sub,
          orgDecisionNote: input.note ?? null,
        };
  return fastify.prisma.$transaction(async (tx) => {
    const claim = await tx.teamJoinRequest.updateMany({
      data: { ...decided, status: 'REJECTED' },
      where: { id: requestId, status: from, teamId },
    });
    if (claim.count !== 1) {
      return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request was decided by someone else');
    }
    const after = await tx.teamJoinRequest.findFirstOrThrow({
      select: REVIEWER_SELECT,
      where: { id: requestId, teamId },
    });
    await writeAuditLog(fastify, {
      action: 'UPDATE',
      actor,
      after: requestAuditFields(after),
      before: requestAuditFields(row),
      client: tx,
      context,
      entityId: requestId,
      entityType: 'TeamJoinRequest',
    });
    return { ok: true as const, request: reviewerView(after) };
  });
}

/** The team step: reject. */
export function rejectAtTeamStep(
  fastify: FastifyInstance,
  input: DecisionInput & { teamId: string }
) {
  return reject(fastify, { ...input, from: 'PENDING_TEAM' });
}

/** The team a request in `orgId` is for, or `null` when the request is not one of that organization's. */
async function teamOfOrgRequest(prisma: Db, orgId: string, requestId: string) {
  return prisma.teamJoinRequest.findFirst({
    select: {
      team: { select: { id: true, isActive: true, orgId: true } },
      teamId: true,
      userId: true,
    },
    where: { id: requestId, team: { orgId } },
  });
}

/** The organization step: reject. */
export async function rejectAtOrgStep(
  fastify: FastifyInstance,
  input: DecisionInput & { orgId: string }
): Promise<Outcome<{ request: ReviewerView }>> {
  const found = await teamOfOrgRequest(fastify.prisma, input.orgId, input.requestId);
  if (!found) {
    return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  return reject(fastify, { ...input, from: 'PENDING_ORG', teamId: found.teamId });
}

/**
 * The organization step: approve (`PENDING_ORG` → `APPROVED`). Creates the organization `MEMBER`
 * membership and the team membership the team step granted, in one audited transaction.
 */
export async function approveAtOrgStep(
  fastify: FastifyInstance,
  input: DecisionInput & { orgId: string }
): Promise<Outcome<{ request: ReviewerView }>> {
  const { actor, context, orgId, requestId } = input;
  const prisma = fastify.prisma;
  const found = await teamOfOrgRequest(prisma, orgId, requestId);
  if (!found) {
    return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  const { teamId } = found;
  if (found.userId === actor.sub) {
    return refuse(403, 'SELF_DECISION', 'You cannot decide your own request');
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await lockOrgThenTeam(tx, orgId, teamId);
      const row = await tx.teamJoinRequest.findFirst({
        select: REQUEST_SELECT,
        where: { id: requestId, team: { orgId }, teamId },
      });
      if (!row) {
        return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
      }
      if (row.status !== 'PENDING_ORG') {
        return refuse(
          409,
          'REQUEST_ALREADY_DECIDED',
          'The request is no longer awaiting the organization'
        );
      }
      const [current, requester, inOrg, member] = await Promise.all([
        tx.team.findUnique({ select: { isActive: true }, where: { id: teamId } }),
        tx.user.findUnique({ select: { isActive: true }, where: { id: row.userId } }),
        tx.organizationMembership.findUnique({
          select: { id: true },
          where: { userId_orgId: { orgId, userId: row.userId } },
        }),
        tx.teamMembership.findUnique({
          select: { id: true },
          where: { userId_teamId: { teamId, userId: row.userId } },
        }),
      ]);
      if (!current?.isActive) {
        return refuse(409, 'TEAM_INACTIVE', 'The team is no longer active');
      }
      if (!requester?.isActive) {
        return refuse(409, 'REQUESTER_INACTIVE', 'The requester is no longer an active user');
      }
      // The role was bounded by the team approver's rank at the team step, and holding
      // `org.members.manage` always acts at ADMIN rank, so no further bound applies here.
      const role = resolveGrantedRole(row.grantedRole);
      const claim = await tx.teamJoinRequest.updateMany({
        data: {
          orgDecidedAt: new Date(),
          orgDecidedById: actor.sub,
          orgDecisionNote: input.note ?? null,
          status: 'APPROVED',
        },
        where: { id: requestId, status: 'PENDING_ORG', teamId },
      });
      if (claim.count !== 1) {
        return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request was decided by someone else');
      }
      if (!inOrg) {
        const orgMembership = await tx.organizationMembership.create({
          data: { orgId, role: 'MEMBER', userId: row.userId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { orgId, role: 'MEMBER', userId: row.userId },
          client: tx,
          context,
          entityId: orgMembership.id,
          entityType: 'OrganizationMembership',
        });
      }
      if (!member) {
        await grantTeamMembership(fastify, tx, {
          actor,
          context,
          role,
          teamId,
          userId: row.userId,
        });
      }
      const after = await tx.teamJoinRequest.findFirstOrThrow({
        select: REVIEWER_SELECT,
        where: { id: requestId, teamId },
      });
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: requestAuditFields(after),
        before: requestAuditFields(row),
        client: tx,
        context,
        entityId: requestId,
        entityType: 'TeamJoinRequest',
      });
      return { ok: true as const, request: reviewerView(after) };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return refuse(409, 'ALREADY_MEMBER', 'The requester is already a member');
    }
    throw err;
  }
}

/** Pending requests at the team step, for the overview's count. */
export function countPendingTeamRequests(prisma: Db | Prisma.TransactionClient, teamId: string) {
  return prisma.teamJoinRequest.count({ where: { status: 'PENDING_TEAM', teamId } });
}
