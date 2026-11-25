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
import { resolveSetting, resolveSettingForOrganizations } from '@auto-swe/shared/config';
import {
  clampGrantedRole,
  evaluateCooldown,
  evaluateOpenCap,
  isOpenStatus,
  type JoinRequestCloseReasonValue,
  type JoinRequestStatusValue,
  OPEN_JOIN_REQUEST_STATUSES,
  resolveGrantedRole,
  statusAfterTeamApproval,
  systemCloseFor,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  type Authority,
  actingRank,
  decide,
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
import { enqueueJoinRequestEvent, resolveCreatedRouting } from './joinRequestOutbox.js';
import { lockOpenJoinRequests, lockOrganizations, lockOrgThenTeam } from './lockOrder.js';
import { isUniqueConstraintError } from './prismaErrors.js';

type Db = FastifyInstance['prisma'];

/** A refusal the route sends as `{ error: { code, message } }`. */
export interface Refusal {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 429;
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
  closeReason: true,
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
  /** Why the platform closed the request; null when a person decided or withdrew. */
  closeReason: JoinRequestCloseReasonValue | null;
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
    closeReason: row.closeReason,
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
  closeReason?: string | null;
  grantedRole: string | null;
  id: string;
  requiresOrgApproval: boolean;
  status: string;
  teamId: string;
  userId: string;
}) {
  return {
    closeReason: row.closeReason ?? null,
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

/** How many organization names the directory filter lists; `organizationsTruncated` says more exist. */
export const DIRECTORY_ORGANIZATIONS_LIMIT = 500;

/**
 * The directory's visibility rule, shared by the listing, the organization filter, the organization
 * search endpoint and the create path so they cannot disagree. It is written once, as a filter on the
 * organization (`orgWhere`), and the team filter (`where`) is derived from it: a team is visible when
 * it and its organization are active and (the viewer belongs to the organization, or the
 * organization's effective `teams.directoryScope` is `platform`). The effective scope is the
 * organization's own valid override, else the platform value.
 *
 * Nothing here scales with the number of organizations or of overrides. The platform value says
 * which side is the short list, and the database joins the organizations' override rows itself
 * (`configSettings` of the organization), so the only list sent as parameters is the viewer's own
 * memberships. Under `platform` an organization is visible unless it chose `organization`; under
 * `organization` it is visible only if it chose `platform`. An override is valid only as the exact
 * JSON string `platform` or `organization` (the registry schema is an enum); a JSON `equals` on that
 * string treats any other stored value (wrong case, a number, an array, an object) as no override,
 * so it falls through to the platform value exactly as `resolveSetting(key, { orgId })` does.
 */
async function directoryVisibility(viewerOrgIds: readonly string[]): Promise<{
  orgWhere: Prisma.OrganizationWhereInput;
  scope: DirectoryScope;
  where: Prisma.TeamWhereInput;
}> {
  const scope = await resolveSetting('teams.directoryScope');
  const chose = (value: DirectoryScope) => ({
    key: 'teams.directoryScope',
    scope: 'ORGANIZATION' as const,
    value: { equals: value },
  });
  // The override rows are read through the organization relation, in the same statement.
  const orgWhere: Prisma.OrganizationWhereInput = {
    isActive: true,
    OR: [
      { id: { in: [...viewerOrgIds] } },
      {
        configSettings:
          scope === 'platform' ? { none: chose('organization') } : { some: chose('platform') },
      },
    ],
  };
  return { orgWhere, scope, where: { isActive: true, organization: orgWhere } };
}

/**
 * Organizations per statement in `listVisibleOrganizations`. A statement's parameter list is this
 * long however many organizations exist.
 */
const ORGANIZATION_CHUNK = 1000;

/**
 * The organizations of `orgWhere` that own at least one active team, in name order (`after` is an
 * exclusive lower bound on the name, `q` a case-insensitive substring of it), the first `take`.
 *
 * The cost follows the number of teams, not the number of organizations, and not the planner's
 * statistics. The distinct organization ids of the active teams come from one `GROUP BY` over
 * `teams`; each statement after it starts from at most `ORGANIZATION_CHUNK` primary keys it was
 * handed, so every plan is a bounded run of index probes. A single `organizations WHERE EXISTS
 * (teams …)` leaves the join order to the planner, and from stale statistics it can pick an ordered
 * walk of all organizations with one probe each. The database also does all the ordering: when
 * more than one chunk is needed, the chunks' winners are re-chunked and ordered again until one
 * statement orders what is left, so the order is the cursor's own (the same collation) and nothing
 * is compared in JavaScript.
 */
async function listVisibleOrganizations(
  prisma: Db,
  orgWhere: Prisma.OrganizationWhereInput,
  opts: { after?: string; q?: string; take: number }
): Promise<Array<{ id: string; name: string }>> {
  const withTeams = await runUnscoped(
    'the organizations that own an active team, as distinct ids',
    ['Team'],
    () => prisma.team.groupBy({ by: ['orgId'], where: { isActive: true } })
  );
  const names: Prisma.OrganizationWhereInput[] = [];
  if (opts.after !== undefined) {
    names.push({ name: { gt: opts.after } });
  }
  if (opts.q) {
    names.push({ name: { contains: opts.q, mode: 'insensitive' } });
  }
  let candidates = withTeams.map((r) => r.orgId);
  let first = true;
  for (;;) {
    const winners: Array<{ id: string; name: string }> = [];
    for (let from = 0; from < candidates.length; from += ORGANIZATION_CHUNK) {
      const ids = candidates.slice(from, from + ORGANIZATION_CHUNK);
      winners.push(
        ...(await prisma.organization.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
          take: opts.take,
          // The first round decides visibility; the later ones only re-order its winners.
          where: first ? { AND: [orgWhere, { id: { in: ids } }, ...names] } : { id: { in: ids } },
        }))
      );
    }
    if (candidates.length <= ORGANIZATION_CHUNK) {
      return winners;
    }
    candidates = winners.map((w) => w.id);
    first = false;
  }
}

/**
 * The advisory-lock key of one person's join requests. Creation and deactivation both take it, so
 * both build it here, from the id in its canonical form: a UUID is case-insensitive to the database
 * but not to a hash of its text, and a route parameter may arrive in upper case.
 */
export function joinRequestLockKey(userId: string): string {
  return `join-request:${userId.toLowerCase()}`;
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
  // One read of each setting's organization rows however many organizations the viewer is in.
  const [enabledIn, limitIn] = await Promise.all([
    resolveSettingForOrganizations('teams.selfServiceCreation', candidates),
    resolveSettingForOrganizations('teams.maxCreatedPerUser', candidates),
  ]);
  const policies = candidates.map((orgId) => ({
    enabled: enabledIn.get(orgId) === true,
    limit: limitIn.get(orgId) ?? 0,
    orgId,
  }));
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
  const memberOrgIds = await memberOrgIdsOf(prisma, viewer.sub);
  // Each team's own organization decides who may list it (see `directoryVisibility`).
  const { orgWhere, scope, where: visible } = await directoryVisibility(memberOrgIds);

  let after: string | null = null;
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor);
    if (after === null) {
      return refuse(400, 'INVALID_CURSOR', 'The cursor is not one this API issued');
    }
  }

  // A team of a deactivated organization is not joinable, so it is not listed.
  const and: Prisma.TeamWhereInput[] = [visible];
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

  const [counts, memberOf, open, creatableOrgs, orgsWithTeams, governed] = await Promise.all([
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
    // The organization filter lists organizations that have a team the viewer may see, whatever
    // the search text or page, in name order and capped: one more than the cap says it was cut.
    listVisibleOrganizations(prisma, orgWhere, { take: DIRECTORY_ORGANIZATIONS_LIMIT + 1 }),
    // Teams the viewer governs by organization or platform authority: `team.read` held without
    // being a member. They open the team instead of asking to join it.
    heldScope(prisma, userActor(viewer), 'team.read'),
  ]);
  const organizations = orgsWithTeams.slice(0, DIRECTORY_ORGANIZATIONS_LIMIT);
  const organizationsTruncated = orgsWithTeams.length > DIRECTORY_ORGANIZATIONS_LIMIT;
  const sizeOf = new Map(counts.map((c) => [c.teamId, c._count._all]));
  const memberSet = new Set(memberOf.map((m) => m.teamId));
  const governedTeams = new Set(governed.teamIds);
  const requestOf = new Map(open.map((r) => [r.teamId, r.id]));

  const teams = page.map((t) => {
    const requestId = requestOf.get(t.id);
    // A pending request outranks authority, so it can still be withdrawn from the row.
    const governs = governed.all || governedTeams.has(t.id);
    const relationship = memberSet.has(t.id)
      ? 'MEMBER'
      : requestId
        ? 'REQUESTED'
        : governs
          ? 'GOVERNS'
          : 'NONE';
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
  return {
    creatableOrgs,
    nextCursor,
    ok: true as const,
    organizations,
    organizationsTruncated,
    scope,
    teams,
  };
}

/**
 * `GET /teams/directory/organizations`: the organizations the viewer may see a team of, by the rule
 * the directory lists teams by, in name order. `q` is a case-insensitive substring of the name and
 * the cursor is the last name of the previous page (organization names are unique).
 */
export async function loadDirectoryOrganizations(
  prisma: Db,
  viewer: Viewer,
  query: { cursor?: string; limit: number; q?: string }
) {
  let after: string | undefined;
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (decoded === null) {
      return refuse(400, 'INVALID_CURSOR', 'The cursor is not one this API issued');
    }
    after = decoded;
  }
  const { orgWhere } = await directoryVisibility(await memberOrgIdsOf(prisma, viewer.sub));
  const rows = await listVisibleOrganizations(prisma, orgWhere, {
    after,
    q: query.q,
    take: query.limit + 1,
  });
  const organizations = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit
      ? encodeCursor(organizations[organizations.length - 1]?.name ?? '')
      : null;
  return { nextCursor, ok: true as const, organizations };
}

/**
 * The team, if `viewer` may see it in the directory: the same filter the listing applies. An unknown
 * team, an inactive one (or of an inactive organization) and one outside the scope are the same
 * answer.
 */
async function visibleTeam(prisma: Db, viewerId: string, teamId: string) {
  const { where } = await directoryVisibility(await memberOrgIdsOf(prisma, viewerId));
  return runUnscoped('the team directory lists public team fields', ['Team'], () =>
    prisma.team.findFirst({
      select: { id: true, name: true, orgId: true },
      where: { AND: [where, { id: teamId }] },
    })
  );
}

/* ── Locks ─────────────────────────────────────────────────────────────────── */

/**
 * The refusal for a decision on a request of an organization that has been deactivated, or `null`
 * while it is active. Read inside the decision's transaction, after the organization's lock, so a
 * deactivation that committed while the decision waited has taken effect; the request is untouched.
 */
async function inactiveOrganizationRefusal(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<Refusal | null> {
  const org = await tx.organization.findUnique({
    select: { isActive: true },
    where: { id: orgId },
  });
  return org?.isActive
    ? null
    : refuse(409, 'ORGANIZATION_INACTIVE', 'The organization is no longer active');
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
  const settingsCtx = { orgId: team.orgId, teamId };
  const [cooldownHours, withdrawCooldownHours, maxOpen] = await Promise.all([
    resolveSetting('teams.joinRequestCooldownHours', settingsCtx),
    resolveSetting('teams.withdrawCooldownHours', settingsCtx),
    resolveSetting('teams.maxOpenJoinRequests', settingsCtx),
  ]);
  // Only a closure a person made counts (`countsTowardCooldown`): a request the platform closed
  // because someone was deactivated carries a `closeReason` and never starts a cooldown.
  const [rejected, withdrawn] = await Promise.all([
    prisma.teamJoinRequest.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { orgDecidedAt: true, teamDecidedAt: true, updatedAt: true },
      where: { closeReason: null, status: 'REJECTED', teamId, userId: actor.sub },
    }),
    prisma.teamJoinRequest.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
      where: { closeReason: null, status: 'WITHDRAWN', teamId, userId: actor.sub },
    }),
  ]);
  const cooldown = evaluateCooldown({
    cooldownHours,
    lastRejectedAt: rejected
      ? (rejected.orgDecidedAt ?? rejected.teamDecidedAt ?? rejected.updatedAt)
      : null,
    lastWithdrawnAt: withdrawn ? withdrawn.updatedAt : null,
    now: new Date(),
    withdrawCooldownHours,
  });
  if (cooldown.blocked) {
    return refuse(
      429,
      'JOIN_REQUEST_COOLDOWN',
      cooldown.reason === 'rejected'
        ? 'This team rejected your last request; you may ask again later'
        : 'You withdrew your last request to this team; you may ask again later',
      {
        details: {
          reason: cooldown.reason,
          retryAfterSeconds: cooldown.retryAfterSeconds,
          retryAt: cooldown.retryAt,
        },
        retryAfterSeconds: cooldown.retryAfterSeconds,
      }
    );
  }
  const inOrg = await prisma.organizationMembership.findUnique({
    select: { id: true },
    where: { userId_orgId: { orgId: team.orgId, userId: actor.sub } },
  });
  // Read on the pool before the transaction opens, so the transaction never waits for a second
  // connection while it holds one, and a Slack configuration that fails to decrypt cannot fail the
  // request (it counts as no usable channel).
  const routing = await resolveCreatedRouting(prisma, { orgId: team.orgId, teamId });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock. It
      // serializes one person's requests, so two at once cannot both pass the open-request cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${joinRequestLockKey(actor.sub)}, 0))`;
      // A deactivation of this account or of this team may have committed since the checks above,
      // and its closing of open requests has then already run: a request committed now would stay
      // open for good. The account's deactivation takes this same lock before it closes, so past
      // here the read below is the account's state when it commits; the team's deactivation holds
      // the team row `FOR UPDATE`, so the share lock waits for it and the re-read sees its commit.
      const requester = await tx.user.findUnique({
        select: { isActive: true },
        where: { id: actor.sub },
      });
      if (!requester?.isActive) {
        return refuse(401, 'TOKEN_INVALID', 'The user this token was issued to is inactive');
      }
      // Share locks on the organization and then the team, held to commit (the order in
      // `lockOrder.ts`), so a deactivation of either (which takes the row `FOR UPDATE` and then
      // closes its open requests) cannot slip between the re-check below and the insert.
      await lockOrgThenTeam(tx, team.orgId, teamId, 'share');
      const live = await tx.team.findUnique({ select: { isActive: true }, where: { id: teamId } });
      if (!live?.isActive || (await inactiveOrganizationRefusal(tx, team.orgId))) {
        return refuse(404, 'TEAM_NOT_FOUND', 'Team not found');
      }
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
      // The notice commits with the request or not at all: an outbox row, not a send after commit.
      await enqueueJoinRequestEvent(tx, {
        event: 'CREATED',
        requestId: created.id,
        routing,
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
    return result;
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

/**
 * What `actor` may do on `team` right now, read through `db`: the team step's rank and capability
 * checks, and whether they could also take the organization step. It is called twice, on purpose:
 * before any lock, to refuse cheaply, and again by the transaction once it holds the organization
 * and team locks. Only the second answer decides, because a concurrent organization removal or
 * role change commits while an approval waits for those locks, and a standing read before the wait
 * would still grant authority the approver no longer has.
 */
async function teamApprover(
  db: Prisma.TransactionClient | Db,
  actor: JwtPayload,
  team: { id: string; orgId: string },
  role: TeamRoleValue
): Promise<
  Refusal | { ok: true; orgDecision: ReturnType<typeof decide>; teamAuthority: Authority }
> {
  const standing = await loadStanding(db, userActor(actor), { teamId: team.id });
  const rank = actingRank(standing, team.id);
  const teamDecision = decide(standing, 'team.members.manage', { teamId: team.id });
  if (!rank || !teamDecision.allowed) {
    return refuse(403, 'FORBIDDEN', 'You have no standing in this team');
  }
  // The hierarchy rule of member-add: no grant above the rank the approver acts at in this team.
  if (exceeds(role, rank)) {
    return refuse(403, 'PRIVILEGE_ESCALATION', 'Cannot grant a role higher than your own');
  }
  // Asked of the same standing, so the answer agrees with the organization queue's own route check.
  return {
    ok: true,
    orgDecision: decide(standing, 'org.members.manage', { orgId: team.orgId }),
    teamAuthority: teamDecision.authority,
  };
}

/**
 * The team step: approve (`PENDING_TEAM` → `APPROVED` or `PENDING_ORG`) with an optional role.
 *
 * When the request needs the organization step and the approver also holds `org.members.manage`
 * for the team's organization, one transaction records both decisions: the request is `APPROVED`
 * and the organization `MEMBER` and the team membership are created.
 */
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
  const role = resolveGrantedRole(input.role);
  // An early refusal only: the decision is made again under the locks, below.
  const early = await teamApprover(prisma, actor, team, role);
  if (!early.ok) {
    return early;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockOrgThenTeam(tx, team.orgId, team.id);
      // The authoritative standing: read after the locks, so a removal that committed while this
      // waited for them has taken effect.
      // A team deactivated while this waited answers as such, not as a loss of standing in it.
      const stillActive = await tx.team.findUnique({
        select: { isActive: true },
        where: { id: teamId },
      });
      if (!stillActive?.isActive) {
        return refuse(409, 'TEAM_INACTIVE', 'The team is no longer active');
      }
      const orgInactive = await inactiveOrganizationRefusal(tx, team.orgId);
      if (orgInactive) {
        return orgInactive;
      }
      // The approver's own account, read under the locks too: `loadStanding` does not look at it, and
      // an account deactivated while this waited is no longer one that may decide anything.
      const deciding = await tx.user.findUnique({
        select: { isActive: true },
        where: { id: actor.sub },
      });
      if (!deciding?.isActive) {
        return refuse(401, 'TOKEN_INVALID', 'The user this token was issued to is inactive');
      }
      const approver = await teamApprover(tx, actor, team, role);
      if (!approver.ok) {
        return approver;
      }
      const orgDecision = approver.orgDecision;
      // The ground of the team step as read under the locks, not the route's earlier check: a team
      // role removed while this waited leaves only what the approver still holds, and the audit
      // rows say so.
      const teamContext: AuditContext = { ...context, authority: approver.teamAuthority };
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
      // One person holding both decisions makes them together.
      const combined = needsOrg && !member && orgDecision.allowed;
      const next = member || combined ? 'APPROVED' : statusAfterTeamApproval(needsOrg);
      const now = new Date();
      const claim = await tx.teamJoinRequest.updateMany({
        data: {
          grantedRole: granted,
          requiresOrgApproval: needsOrg,
          status: next,
          teamDecidedAt: now,
          teamDecidedById: actor.sub,
          teamDecisionNote: input.note ?? null,
          ...(combined
            ? { orgDecidedAt: now, orgDecidedById: actor.sub, orgDecisionNote: input.note ?? null }
            : {}),
        },
        where: { id: requestId, status: 'PENDING_TEAM', teamId },
      });
      if (claim.count !== 1) {
        return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request was decided by someone else');
      }
      await enqueueJoinRequestEvent(tx, {
        event: next === 'PENDING_ORG' ? 'PENDING_ORG' : 'APPROVED',
        requestId,
      });
      if (combined && orgDecision.allowed) {
        const orgMembership = await tx.organizationMembership.create({
          data: { orgId: team.orgId, role: 'MEMBER', userId: row.userId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { orgId: team.orgId, role: 'MEMBER', userId: row.userId },
          client: tx,
          context: { ...context, authority: orgDecision.authority },
          entityId: orgMembership.id,
          entityType: 'OrganizationMembership',
        });
      }
      if (next === 'APPROVED' && !member) {
        await grantTeamMembership(fastify, tx, {
          actor,
          context: teamContext,
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
        after: {
          ...requestAuditFields(after),
          ...(combined && orgDecision.allowed
            ? {
                combinedDecision: {
                  authority: { organization: orgDecision.authority, team: approver.teamAuthority },
                  steps: ['team', 'organization'],
                },
              }
            : {}),
        },
        before: requestAuditFields(row),
        client: tx,
        context: teamContext,
        entityId: requestId,
        entityType: 'TeamJoinRequest',
      });
      return { ok: true as const, request: reviewerView(after) };
    });
    return result;
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
  const result = await fastify.prisma.$transaction(async (tx) => {
    // A rejection takes no membership lock, but it reads the organization's state under a share
    // lock, so a deactivation (which holds the row `FOR UPDATE` while it closes requests) is either
    // seen here or waits for this to commit.
    const owner = await tx.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
    if (!owner) {
      return refuse(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    }
    // A share lock on the organization row, held to commit, so the active check below cannot be
    // overtaken by a deactivation that closes this request's siblings.
    await lockOrganizations(tx, [owner.orgId], 'share');
    const orgInactive = await inactiveOrganizationRefusal(tx, owner.orgId);
    if (orgInactive) {
      return orgInactive;
    }
    const claim = await tx.teamJoinRequest.updateMany({
      data: { ...decided, status: 'REJECTED' },
      where: { id: requestId, status: from, teamId },
    });
    if (claim.count !== 1) {
      return refuse(409, 'REQUEST_ALREADY_DECIDED', 'The request was decided by someone else');
    }
    await enqueueJoinRequestEvent(tx, {
      event: 'REJECTED',
      requestId,
    });
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
  return result;
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
 * The team step's decider, as the organization step finds them now: still an active account, still
 * holding `team.members.manage` for the team, and the rank they act at in it. Asked of the same
 * standing resolver every other check uses, so this never invents a second rule.
 */
async function teamApproverStanding(
  tx: Prisma.TransactionClient,
  teamId: string,
  deciderId: string | null
): Promise<{ active: boolean; canManageMembers: boolean; rank: TeamRank | null }> {
  const gone = { active: false, canManageMembers: false, rank: null };
  if (!deciderId) {
    return gone;
  }
  const decider = await tx.user.findUnique({
    select: { id: true, isActive: true, role: true },
    where: { id: deciderId },
  });
  if (!decider?.isActive) {
    return gone;
  }
  const standing = await loadStanding(
    tx,
    { id: decider.id, kind: 'user', role: decider.role },
    { teamId }
  );
  return {
    active: true,
    canManageMembers: decide(standing, 'team.members.manage', { teamId }).allowed,
    rank: actingRank(standing, teamId),
  };
}

/**
 * The organization step: approve (`PENDING_ORG` → `APPROVED`). Creates the organization `MEMBER`
 * membership and the team membership the team step granted, in one audited transaction.
 *
 * The role the team approver chose is re-checked against who they are now: if they were
 * deactivated, lost `team.members.manage` or no longer outrank the role, it becomes `MEMBER` and
 * the audit row says so. The request is never refused for this.
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
    const result = await prisma.$transaction(async (tx) => {
      await lockOrgThenTeam(tx, orgId, teamId);
      const orgInactive = await inactiveOrganizationRefusal(tx, orgId);
      if (orgInactive) {
        return orgInactive;
      }
      // The route checked `org.members.manage` before this waited for the locks; a removal that
      // committed meanwhile has taken it away, so it is asked again of the standing read now.
      // The approver's own account is read under the locks too: `loadStanding` does not look at it,
      // and an account deactivated while this waited is no longer one that may decide anything.
      const deciding = await tx.user.findUnique({
        select: { isActive: true },
        where: { id: actor.sub },
      });
      if (!deciding?.isActive) {
        return refuse(401, 'TOKEN_INVALID', 'The user this token was issued to is inactive');
      }
      const standing = await loadStanding(tx, userActor(actor), { orgId });
      const orgDecision = decide(standing, 'org.members.manage', { orgId });
      if (!orgDecision.allowed) {
        return refuse(403, 'FORBIDDEN', 'You no longer hold authority over this organization');
      }
      // The ground of this step as read under the locks, not the route's earlier check, so the audit
      // rows say what the approver held when the decision was made.
      const orgContext: AuditContext = { ...context, authority: orgDecision.authority };
      const row = await tx.teamJoinRequest.findFirst({
        select: { ...REQUEST_SELECT, teamDecidedById: true },
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
      // The role was bounded by the team approver's rank at the team step; their standing may have
      // changed in the time the request waited here, so it is bounded again by what it is now.
      const computed = clampGrantedRole({
        granted: row.grantedRole,
        teamApproverStanding: await teamApproverStanding(tx, teamId, row.teamDecidedById),
      });
      // Someone who joined since keeps the role they hold and no membership is written, so the
      // request records that role and nothing was clamped; the audit says the same.
      const clamp = member
        ? { clamped: false, from: member.role, role: member.role, to: member.role }
        : computed;
      const claim = await tx.teamJoinRequest.updateMany({
        data: {
          grantedRole: clamp.role,
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
      await enqueueJoinRequestEvent(tx, { event: 'APPROVED', requestId });
      if (!inOrg) {
        const orgMembership = await tx.organizationMembership.create({
          data: { orgId, role: 'MEMBER', userId: row.userId },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor,
          after: { orgId, role: 'MEMBER', userId: row.userId },
          client: tx,
          context: orgContext,
          entityId: orgMembership.id,
          entityType: 'OrganizationMembership',
        });
      }
      if (!member) {
        await grantTeamMembership(fastify, tx, {
          actor,
          context: orgContext,
          role: clamp.role,
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
        after: {
          ...requestAuditFields(after),
          clamp: { clamped: clamp.clamped, from: clamp.from, to: clamp.to },
        },
        before: requestAuditFields(row),
        client: tx,
        context: orgContext,
        entityId: requestId,
        entityType: 'TeamJoinRequest',
      });
      return { ok: true as const, request: reviewerView(after) };
    });
    return result;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return refuse(409, 'ALREADY_MEMBER', 'The requester is already a member');
    }
    throw err;
  }
}

/* ── Deactivation ──────────────────────────────────────────────────────────── */

/** Whose deactivation closes requests: the requester's own, a team's, or an organization's. */
export type DeactivationScope =
  | { reason: 'ORGANIZATION_DEACTIVATED'; orgId: string }
  | { reason: 'REQUESTER_DEACTIVATED'; userId: string }
  | { reason: 'TEAM_DEACTIVATED'; teamId: string };

/**
 * Closes every open request the deactivation strands, inside the caller's transaction, so the
 * account, team or organization is never inactive with a request still waiting on it. The platform
 * closes, not a person: `closeReason` is set (so no cooldown starts), no decision time or decider
 * is recorded, the note names the reason, and nobody is notified. Each row closed gets an audit
 * entry under the acting administrator.
 *
 * A request a reviewer claimed a moment earlier is no longer open, so the conditional update skips
 * it and it is neither closed nor audited here: the decision won. Returns how many were closed.
 */
export async function closeOpenJoinRequests(
  fastify: FastifyInstance,
  tx: Prisma.TransactionClient,
  input: { actor: JwtPayload | null; context?: AuditContext; scope: DeactivationScope }
): Promise<number> {
  const { actor, context, scope } = input;
  const { closeReason, note, status } = systemCloseFor(scope.reason);
  // Every row this close will touch is locked first, in one order (`lockOrder.ts`, level 6), and
  // only then updated by id. A single `UPDATE … WHERE <scope>` takes the same locks in the order
  // the plan reads the rows, so two closes with overlapping row sets (a team's and its
  // organization's, a user's and an organization's) could each hold a row the other waits for.
  const ids = await lockOpenJoinRequests(
    tx,
    scope.reason === 'REQUESTER_DEACTIVATED'
      ? { userId: scope.userId }
      : scope.reason === 'TEAM_DEACTIVATED'
        ? { teamId: scope.teamId }
        : { orgId: scope.orgId },
    OPEN
  );
  if (ids.length === 0) {
    return 0;
  }

  let closed = 0;
  for (const from of OPEN) {
    // The note goes on the step the request was waiting at, so a reader finds it where a
    // reviewer's own would have been.
    const noteField = from === 'PENDING_TEAM' ? 'teamDecisionNote' : 'orgDecisionNote';
    const rows = await runUnscoped(
      'a deactivation closes the open join requests it strands',
      ['TeamJoinRequest'],
      () =>
        tx.teamJoinRequest.updateManyAndReturn({
          data: { closeReason, status, [noteField]: note },
          select: {
            closeReason: true,
            grantedRole: true,
            id: true,
            requiresOrgApproval: true,
            status: true,
            teamId: true,
            userId: true,
          },
          where: { id: { in: ids }, status: from },
        })
    );
    for (const row of rows) {
      await writeAuditLog(fastify, {
        action: 'UPDATE',
        actor,
        after: { ...requestAuditFields(row), note, systemClose: true },
        before: { ...requestAuditFields({ ...row, closeReason: null }), status: from },
        client: tx,
        ...(context ? { context } : {}),
        entityId: row.id,
        entityType: 'TeamJoinRequest',
      });
    }
    closed += rows.length;
  }
  return closed;
}

/** Pending requests at the team step, for the overview's count. */
export function countPendingTeamRequests(prisma: Db | Prisma.TransactionClient, teamId: string) {
  return prisma.teamJoinRequest.count({ where: { status: 'PENDING_TEAM', teamId } });
}
