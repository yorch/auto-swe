import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import {
  ApproveKnowledgeItemSchema,
  CreateCuratedKnowledgeItemSchema,
  CreateKnowledgeLearningSchema,
  canApproveKnowledge,
  type KnowledgeEvidence,
  KnowledgeEvidenceSchema,
  KnowledgeManagementFilterSchema,
  type KnowledgeManagementProjection,
  type KnowledgeScalarProjection,
  knowledgeReadableWhere,
  ReviseKnowledgeItemSchema,
  toKnowledgeScalarProjection,
} from './knowledge.js';
import { repoMemberWhere } from './repoMembership.js';
import { runUnscoped } from './tenantGuard.js';

type Db = PrismaClient | Prisma.TransactionClient;

async function lockCurrentWorkflowRun(
  tx: Prisma.TransactionClient,
  runId: string,
  temporalRunId: string
): Promise<void> {
  // CLAUDE.md §7 exception: Prisma cannot express SELECT FOR UPDATE; lock the exact execution before inserting.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM workflow_runs
    WHERE id = ${runId}::uuid
      AND temporal_run_id = ${temporalRunId}
      AND status = 'RUNNING'
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new KnowledgeAccessError('Workflow execution is no longer running');
  }
}

async function lockAndValidateRepository(
  tx: Prisma.TransactionClient,
  repoId: string,
  teamId: string,
  orgId: string
) {
  // CLAUDE.md §7 exception: Prisma cannot express SELECT FOR UPDATE; serialize source inserts against reassignment.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM connections WHERE id = ${repoId}::uuid FOR UPDATE`);
  const source = await tx.connection.findFirst({
    select: { id: true },
    where: {
      id: repoId,
      isActive: true,
      team: { isActive: true, organization: { isActive: true }, orgId },
      teamId,
      type: 'git_repo',
    },
  });
  if (!source) {
    throw new KnowledgeAccessError('Invalid source repository');
  }
}

export class KnowledgeAccessError extends Error {
  constructor(message = 'Knowledge access denied') {
    super(message);
    this.name = 'KnowledgeAccessError';
  }
}

export class KnowledgeVersionConflictError extends Error {
  constructor() {
    super('Knowledge item changed; reload before retrying');
    this.name = 'KnowledgeVersionConflictError';
  }
}

const workflowPrincipalTag = Symbol('trustedKnowledgeWorkflowPrincipal');
const repositoryCapabilityTag = Symbol('knowledgeRepositoryCapability');
const issuedRepositoryCapabilities = new WeakMap<
  object,
  {
    kind: 'user' | 'workflow';
    principalId: string;
    repoIds: string[];
    teamScopeAllowed: boolean;
    orgScopeAllowed: boolean;
    expiresAt: number;
  }
>();
export interface TrustedKnowledgeWorkflowPrincipal {
  readonly [workflowPrincipalTag]: true;
  readonly runId: string;
  readonly teamId: string;
  readonly orgId: string;
  readonly repoId: string | null;
  readonly temporalRunId: string;
  readonly launchedById: string | null;
  /** Current launcher membership in the saved source scope, resolved from the database. */
  readonly launcherHasTeamMembership: boolean;
  readonly launcherHasOrgMembership: boolean;
}

export interface KnowledgeRepositoryGateCapability {
  readonly [repositoryCapabilityTag]: true;
}

export interface ValidatedKnowledgeEvidence {
  nodeId: string;
  producerAgentKey: string | null;
  modelSpec: string | null;
  evidence: KnowledgeEvidence[];
}

export type KnowledgeEvidenceResolver = (
  refs: KnowledgeEvidence[],
  execution: { runId: string; requestedNodeId: string }
) => Promise<ValidatedKnowledgeEvidence>;

export type KnowledgeRepositoryGate = (
  repoId: string,
  actor:
    | { kind: 'user'; userId: string; isPlatformAdmin: boolean }
    | { kind: 'workflow'; runId: string; temporalRunId: string; launchedById: string | null }
) => Promise<boolean>;

type KnowledgeUserRepositoryGate = (
  repoId: string,
  actor: { kind: 'user'; userId: string; isPlatformAdmin: boolean }
) => Promise<boolean>;

type KnowledgeWorkflowRepositoryGate = (
  repoId: string,
  actor: { kind: 'workflow'; runId: string; temporalRunId: string; launchedById: string | null }
) => Promise<boolean>;

function issueRepositoryCapability(
  kind: 'user' | 'workflow',
  principalId: string,
  repoIds: string[],
  tenantScope: { team: boolean; org: boolean } = { org: false, team: false }
): KnowledgeRepositoryGateCapability {
  const capability = Object.freeze({ [repositoryCapabilityTag]: true as const });
  issuedRepositoryCapabilities.set(capability, {
    expiresAt: Date.now() + 30_000,
    kind,
    orgScopeAllowed: tenantScope.org,
    principalId,
    repoIds: [...new Set(repoIds)],
    teamScopeAllowed: tenantScope.team,
  });
  return capability;
}

function capabilityRepositories(
  capability: KnowledgeRepositoryGateCapability,
  kind: 'user' | 'workflow',
  principalId: string
): string[] {
  const issued = capability && issuedRepositoryCapabilities.get(capability as object);
  if (
    !issued ||
    issued.expiresAt < Date.now() ||
    issued.kind !== kind ||
    issued.principalId !== principalId
  ) {
    throw new KnowledgeAccessError('Missing, expired, or mismatched repository access capability');
  }
  return issued.repoIds;
}

function workflowTenantScope(
  capability: KnowledgeRepositoryGateCapability,
  principalId: string
): { team: boolean; org: boolean } {
  const issued = capability && issuedRepositoryCapabilities.get(capability as object);
  if (
    !issued ||
    issued.expiresAt < Date.now() ||
    issued.kind !== 'workflow' ||
    issued.principalId !== principalId
  ) {
    throw new KnowledgeAccessError('Missing, expired, or mismatched repository access capability');
  }
  return { org: issued.orgScopeAllowed, team: issued.teamScopeAllowed };
}

/** Derives authority only from the current stored workflow execution and a matching Temporal run id. */
export async function resolveKnowledgeWorkflowPrincipal(
  db: Db,
  input: { workflowId: string; temporalRunId: string }
): Promise<TrustedKnowledgeWorkflowPrincipal> {
  if (!input.workflowId || !input.temporalRunId) {
    throw new KnowledgeAccessError();
  }
  const run = await db.workflowRun.findFirst({
    select: {
      channel: { select: { isPrivate: true, orgId: true, teamId: true } },
      connection: { select: { id: true, teamId: true } },
      id: true,
      knowledgeSourceKind: true,
      knowledgeSourceOrgId: true,
      knowledgeSourceRepoId: true,
      knowledgeSourceTeamId: true,
      launchedById: true,
      workRequest: { select: { connection: { select: { id: true } } } },
    },
    where: { status: 'RUNNING', temporalRunId: input.temporalRunId, workflowId: input.workflowId },
  });
  if (!run?.knowledgeSourceKind || !run.knowledgeSourceTeamId || !run.knowledgeSourceOrgId) {
    throw new KnowledgeAccessError('Workflow source identity is missing or unknown');
  }
  const activeRepository = await db.activeWorkflow.findFirst({
    select: { repository: { select: { id: true } } },
    where: { temporalWorkflowId: input.workflowId },
  });
  let repoId: string | null = null;
  if (run.knowledgeSourceKind === 'REPOSITORY') {
    const sourceRepoId = run.knowledgeSourceRepoId;
    const repository = sourceRepoId
      ? await db.connection.findFirst({
          select: {
            id: true,
            team: {
              select: { isActive: true, organization: { select: { isActive: true } }, orgId: true },
            },
            teamId: true,
          },
          where: { id: sourceRepoId, isActive: true, type: 'git_repo' },
        })
      : null;
    if (
      !repository ||
      repository.id !== sourceRepoId ||
      repository.teamId !== run.knowledgeSourceTeamId ||
      repository.team.orgId !== run.knowledgeSourceOrgId ||
      !repository.team.isActive ||
      !repository.team.organization.isActive ||
      (run.connection && run.connection.id !== sourceRepoId) ||
      (run.workRequest?.connection && run.workRequest.connection.id !== sourceRepoId) ||
      (activeRepository?.repository && activeRepository.repository.id !== sourceRepoId)
    ) {
      throw new KnowledgeAccessError('Workflow source repository is missing, inactive, or changed');
    }
    repoId = sourceRepoId;
  } else if (run.knowledgeSourceKind === 'TEAM') {
    const team = await db.team.findFirst({
      select: {
        id: true,
        isActive: true,
        organization: { select: { isActive: true } },
        orgId: true,
      },
      where: { id: run.knowledgeSourceTeamId },
    });
    if (
      run.knowledgeSourceRepoId !== null ||
      run.connection !== null ||
      (run.workRequest?.connection !== null && run.workRequest?.connection !== undefined) ||
      activeRepository?.repository ||
      team?.id !== run.knowledgeSourceTeamId ||
      team.orgId !== run.knowledgeSourceOrgId ||
      !team.isActive ||
      !team.organization.isActive ||
      (run.channel && (run.channel.teamId !== team.id || run.channel.orgId !== team.orgId))
    ) {
      throw new KnowledgeAccessError('Workflow was not a verified repo-less team execution');
    }
  } else {
    throw new KnowledgeAccessError('Workflow source identity is unsupported');
  }
  if (run.channel?.isPrivate) {
    throw new KnowledgeAccessError('Private-channel knowledge is not supported');
  }
  const launcher = run.launchedById
    ? await db.user.findUnique({
        select: { isActive: true },
        where: { id: run.launchedById },
      })
    : null;
  const [teamMembership, orgMembership] =
    launcher?.isActive && run.launchedById
      ? await Promise.all([
          db.teamMembership.findUnique({
            select: { userId: true },
            where: {
              userId_teamId: { teamId: run.knowledgeSourceTeamId, userId: run.launchedById },
            },
          }),
          db.organizationMembership.findUnique({
            select: { userId: true },
            where: {
              userId_orgId: { orgId: run.knowledgeSourceOrgId, userId: run.launchedById },
            },
          }),
        ])
      : [null, null];
  return Object.freeze({
    [workflowPrincipalTag]: true as const,
    launchedById: run.launchedById,
    launcherHasOrgMembership: Boolean(launcher?.isActive && orgMembership),
    launcherHasTeamMembership: Boolean(launcher?.isActive && teamMembership),
    orgId: run.knowledgeSourceOrgId,
    repoId,
    runId: run.id,
    teamId: run.knowledgeSourceTeamId,
    temporalRunId: input.temporalRunId,
  });
}

export async function createUserKnowledgeRepositoryCapability(
  db: Db,
  authenticatedUserId: string,
  authorizeRepository: KnowledgeUserRepositoryGate
): Promise<KnowledgeRepositoryGateCapability> {
  const actor = await resolveKnowledgeActorScope(db, authenticatedUserId);
  const allowed = await Promise.all(
    actor.repoIds.map(async (repoId) =>
      (await authorizeRepository(repoId, {
        isPlatformAdmin: actor.isPlatformAdmin,
        kind: 'user',
        userId: authenticatedUserId,
      }))
        ? repoId
        : null
    )
  );
  return issueRepositoryCapability(
    'user',
    authenticatedUserId,
    allowed.filter((id): id is string => id !== null)
  );
}

export async function createWorkflowKnowledgeRepositoryCapability(
  db: Db,
  principal: TrustedKnowledgeWorkflowPrincipal,
  authorizeRepository: KnowledgeWorkflowRepositoryGate
): Promise<KnowledgeRepositoryGateCapability> {
  if (!principal?.[workflowPrincipalTag]) {
    throw new KnowledgeAccessError();
  }
  const noScope = () => issueRepositoryCapability('workflow', principal.runId, []);
  if (!principal.launchedById) {
    return noScope();
  }
  const launcher = await db.user.findUnique({
    select: { isActive: true, role: true },
    where: { id: principal.launchedById },
  });
  if (!launcher?.isActive) {
    return noScope();
  }
  const [teamMembership, orgMembership] = await Promise.all([
    db.teamMembership.findUnique({
      select: { userId: true },
      where: { userId_teamId: { teamId: principal.teamId, userId: principal.launchedById } },
    }),
    db.organizationMembership.findUnique({
      select: { userId: true },
      where: { userId_orgId: { orgId: principal.orgId, userId: principal.launchedById } },
    }),
  ]);
  const hasCurrentTeamMembership = Boolean(teamMembership);
  const hasCurrentOrgMembership = Boolean(orgMembership);
  // A repo-less TEAM source has no repository gate. Team and org visibility each
  // require their corresponding current membership; loss of one does not imply the other.
  if (!principal.repoId) {
    return issueRepositoryCapability('workflow', principal.runId, [], {
      org: hasCurrentOrgMembership,
      team: hasCurrentTeamMembership,
    });
  }
  if (!hasCurrentTeamMembership || !hasCurrentOrgMembership) {
    return noScope();
  }
  const repository = await db.connection.findFirst({
    select: { id: true, team: { select: { orgId: true } }, teamId: true },
    where: {
      id: principal.repoId,
      isActive: true,
      team: { isActive: true, organization: { isActive: true } },
      type: 'git_repo',
    },
  });
  if (
    !repository ||
    repository.teamId !== principal.teamId ||
    repository.team.orgId !== principal.orgId
  ) {
    return noScope();
  }
  const memberRepository =
    launcher.role === 'ADMIN'
      ? { id: repository.id }
      : await db.connection.findFirst({
          select: { id: true },
          where: {
            id: repository.id,
            isActive: true,
            type: 'git_repo',
            ...repoMemberWhere({ userId: principal.launchedById }),
          },
        });
  if (!memberRepository) {
    return noScope();
  }
  const allowed = await authorizeRepository(repository.id, {
    kind: 'workflow',
    launchedById: principal.launchedById,
    runId: principal.runId,
    temporalRunId: principal.temporalRunId,
  });
  return allowed
    ? issueRepositoryCapability('workflow', principal.runId, [repository.id], {
        org: true,
        team: true,
      })
    : noScope();
}

interface KnowledgeActorScope {
  userId: string;
  teamIds: string[];
  orgIds: string[];
  repoIds: string[];
  isPlatformAdmin: boolean;
}

/** Resolves membership and shared-repository reachability from DB; caller-supplied tenant ids are not accepted. */
async function resolveKnowledgeActorScope(db: Db, userId: string): Promise<KnowledgeActorScope> {
  if (!userId) {
    throw new KnowledgeAccessError();
  }
  const [user, memberships, orgMemberships, repos] = await Promise.all([
    db.user.findUnique({ select: { isActive: true, role: true }, where: { id: userId } }),
    db.teamMembership.findMany({
      select: { teamId: true },
      where: { team: { isActive: true, organization: { isActive: true } }, userId },
    }),
    db.organizationMembership.findMany({
      select: { orgId: true },
      where: { organization: { isActive: true }, userId },
    }),
    db.connection.findMany({
      select: { id: true },
      where: {
        isActive: true,
        type: 'git_repo',
        ...repoMemberWhere({ team: { isActive: true, organization: { isActive: true } }, userId }),
      },
    }),
  ]);
  if (!user?.isActive) {
    throw new KnowledgeAccessError();
  }
  let repoIds = repos.map((r) => r.id);
  if (user.role === 'ADMIN') {
    const platformRepositories = await runUnscoped(
      'explicit platform ADMIN knowledge repository gate candidates',
      ['Connection'],
      () =>
        db.connection.findMany({
          select: { id: true },
          take: 1001,
          where: { isActive: true, type: 'git_repo' },
        })
    );
    if (platformRepositories.length > 1000) {
      throw new KnowledgeAccessError(
        'Repository gate candidate limit exceeded for platform administrator'
      );
    }
    repoIds = platformRepositories.map((repository) => repository.id);
  }
  return {
    isPlatformAdmin: user.role === 'ADMIN',
    orgIds: orgMemberships.map((m) => m.orgId),
    repoIds,
    teamIds: memberships.map((m) => m.teamId),
    userId,
  };
}

export async function getReadableKnowledgeItem(
  db: Db,
  authenticatedUserId: string,
  itemId: string,
  repositoryCapability: KnowledgeRepositoryGateCapability
): Promise<KnowledgeScalarProjection | null> {
  const repositories = capabilityRepositories(repositoryCapability, 'user', authenticatedUserId);
  const actor = await resolveKnowledgeActorScope(db, authenticatedUserId);
  actor.repoIds = actor.repoIds.filter((repoId) => repositories.includes(repoId));
  const row = await db.knowledgeItem.findFirst({
    select: {
      content: true,
      createdAt: true,
      id: true,
      status: true,
      title: true,
      type: true,
      version: true,
      visibility: true,
    },
    where: { AND: [knowledgeReadableWhere(actor), { id: itemId }] },
  });
  return row ? toKnowledgeScalarProjection(row) : null;
}

function workflowKnowledgeActorScope(
  principal: TrustedKnowledgeWorkflowPrincipal,
  repositoryCapability: KnowledgeRepositoryGateCapability
): KnowledgeActorScope {
  const repositories = capabilityRepositories(repositoryCapability, 'workflow', principal.runId);
  const tenantScope = workflowTenantScope(repositoryCapability, principal.runId);
  const repositoryAllowed = !principal.repoId || repositories.includes(principal.repoId);
  const tenantAllowed = repositoryAllowed;
  return {
    isPlatformAdmin: false,
    orgIds:
      tenantAllowed && tenantScope.org && principal.launcherHasOrgMembership
        ? [principal.orgId]
        : [],
    repoIds: principal.repoId && repositoryAllowed ? [principal.repoId] : [],
    teamIds:
      tenantAllowed && tenantScope.team && principal.launcherHasTeamMembership
        ? [principal.teamId]
        : [],
    userId: `workflow:${principal.runId}`,
  };
}

export async function getKnowledgeWorkflowEligibilityWhere(
  principal: TrustedKnowledgeWorkflowPrincipal,
  repositoryCapability: KnowledgeRepositoryGateCapability
): Promise<Prisma.KnowledgeItemWhereInput> {
  if (!principal?.[workflowPrincipalTag]) {
    throw new KnowledgeAccessError();
  }
  return knowledgeReadableWhere(workflowKnowledgeActorScope(principal, repositoryCapability));
}

export async function listReadableKnowledge(
  db: Db,
  authenticatedUserId: string,
  repositoryCapability: KnowledgeRepositoryGateCapability,
  limit = 25
): Promise<KnowledgeScalarProjection[]> {
  const repositories = capabilityRepositories(repositoryCapability, 'user', authenticatedUserId);
  const actor = await resolveKnowledgeActorScope(db, authenticatedUserId);
  actor.repoIds = actor.repoIds.filter((repoId) => repositories.includes(repoId));
  return listByKnowledgeScope(db, actor, limit);
}

export async function listKnowledgeForWorkflow(
  db: Db,
  principal: TrustedKnowledgeWorkflowPrincipal,
  repositoryCapability: KnowledgeRepositoryGateCapability,
  limit = 25
): Promise<KnowledgeScalarProjection[]> {
  if (!principal?.[workflowPrincipalTag]) {
    throw new KnowledgeAccessError();
  }
  return listByKnowledgeScope(
    db,
    workflowKnowledgeActorScope(principal, repositoryCapability),
    limit
  );
}

async function listByKnowledgeScope(
  db: Db,
  actor: KnowledgeActorScope,
  limit: number
): Promise<KnowledgeScalarProjection[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be 1..100');
  }
  const query = () =>
    db.knowledgeItem.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        content: true,
        createdAt: true,
        id: true,
        status: true,
        title: true,
        type: true,
        version: true,
        visibility: true,
      },
      take: limit,
      where: knowledgeReadableWhere(actor),
    });
  const rows = actor.isPlatformAdmin
    ? await runUnscoped('explicit platform ADMIN readable knowledge list', ['KnowledgeItem'], query)
    : await query();
  return rows.map((row) => toKnowledgeScalarProjection(row));
}

export async function listManagedKnowledge(
  db: Db,
  authenticatedUserId: string,
  repositoryCapability: KnowledgeRepositoryGateCapability,
  input: unknown = {}
): Promise<KnowledgeManagementProjection[]> {
  return queryManagedKnowledge(db, authenticatedUserId, repositoryCapability, input);
}

export async function getManagedKnowledgeItem(
  db: Db,
  authenticatedUserId: string,
  itemId: string,
  repositoryCapability: KnowledgeRepositoryGateCapability
): Promise<KnowledgeManagementProjection | null> {
  const items = await queryManagedKnowledge(
    db,
    authenticatedUserId,
    repositoryCapability,
    { limit: 1 },
    itemId
  );
  return items[0] ?? null;
}

async function queryManagedKnowledge(
  db: Db,
  authenticatedUserId: string,
  repositoryCapability: KnowledgeRepositoryGateCapability,
  input: unknown,
  itemId?: string
): Promise<KnowledgeManagementProjection[]> {
  const repoIds = new Set(
    capabilityRepositories(repositoryCapability, 'user', authenticatedUserId)
  );
  const filter = KnowledgeManagementFilterSchema.parse(input);
  const [user, teams, organizations] = await Promise.all([
    db.user.findUnique({
      select: { isActive: true, role: true },
      where: { id: authenticatedUserId },
    }),
    db.team.findMany({
      select: { id: true },
      where: {
        isActive: true,
        memberships: { some: { role: { in: ['LEAD', 'ADMIN'] }, userId: authenticatedUserId } },
      },
    }),
    db.organization.findMany({
      select: { id: true },
      where: {
        isActive: true,
        memberships: { some: { role: 'ORG_ADMIN', userId: authenticatedUserId } },
      },
    }),
  ]);
  if (!user?.isActive) {
    throw new KnowledgeAccessError();
  }
  const platformAdmin = user.role === 'ADMIN';
  const teamIds = teams.map(({ id }) => id);
  const orgIds = organizations.map(({ id }) => id);
  if (!platformAdmin && !teamIds.length && !orgIds.length) {
    throw new KnowledgeAccessError();
  }
  const scope: Prisma.KnowledgeItemWhereInput = platformAdmin
    ? {}
    : {
        OR: [
          ...(teamIds.length ? [{ ownerTeamId: { in: teamIds } }] : []),
          ...(orgIds.length ? [{ orgId: { in: orgIds } }] : []),
        ],
      };
  const conditions: Prisma.KnowledgeItemWhereInput[] = [scope];
  if (filter.type) {
    conditions.push({ type: filter.type });
  }
  if (filter.status) {
    conditions.push({ status: filter.status });
  }
  if (filter.query) {
    conditions.push({
      OR: [
        { title: { contains: filter.query, mode: 'insensitive' as const } },
        { content: { contains: filter.query, mode: 'insensitive' as const } },
      ],
    });
  }
  if (itemId) {
    conditions.push({ id: itemId });
  }
  if (!platformAdmin) {
    conditions.push({ OR: [{ repoId: null }, { repoId: { in: [...repoIds] } }] });
  }
  const where: Prisma.KnowledgeItemWhereInput = { AND: conditions };
  const query = () =>
    db.knowledgeItem.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        content: true,
        contentDigest: true,
        createdAt: true,
        evidence: true,
        id: true,
        modelSpec: true,
        originTeamId: true,
        ownerTeamId: true,
        producerAgentKey: true,
        producerNodeId: true,
        producerRunId: true,
        repoId: true,
        status: true,
        title: true,
        type: true,
        version: true,
        visibility: true,
      },
      take: filter.limit,
      where,
    });
  const rows = platformAdmin
    ? await runUnscoped(
        'explicit platform ADMIN knowledge management listing',
        ['KnowledgeItem'],
        query
      )
    : await query();
  return rows.map((row) => {
    const sourceAccessible = row.repoId === null || repoIds.has(row.repoId);
    const parsedEvidence = KnowledgeEvidenceSchema.array().safeParse(row.evidence);
    const provenance = sourceAccessible
      ? {
          evidence: parsedEvidence.success ? parsedEvidence.data : [],
          modelSpec: row.modelSpec,
          producerAgentKey: row.producerAgentKey,
          producerNodeId: row.producerNodeId,
          producerRunId: row.producerRunId,
        }
      : null;
    return { ...toKnowledgeScalarProjection(row), provenance };
  });
}

export async function createCuratedKnowledgeItem(
  db: PrismaClient,
  userId: string,
  input: unknown,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; version: 1 }> {
  const parsed = CreateCuratedKnowledgeItemSchema.parse(input);
  const team = await db.team.findUnique({ select: { orgId: true }, where: { id: parsed.teamId } });
  if (!team) {
    throw new KnowledgeAccessError();
  }
  const actor = await humanMembership(db, userId, parsed.teamId, team.orgId);
  if (!actor.platformAdmin && actor.role !== 'LEAD' && actor.role !== 'ADMIN') {
    throw new KnowledgeAccessError();
  }
  if (parsed.repoId) {
    const repository = await db.connection.findFirst({
      select: { id: true },
      where: {
        id: parsed.repoId,
        isActive: true,
        team: { isActive: true, organization: { isActive: true } },
        teamId: parsed.teamId,
        type: 'git_repo',
      },
    });
    if (!repository) {
      throw new KnowledgeAccessError('Invalid source repository');
    }
  }
  await requireKnowledgeSourceCapability(db, userId, parsed.repoId ?? null, repositoryCapability);
  const digest = createHash('sha256')
    .update(parsed.title)
    .update('\0')
    .update(parsed.content)
    .digest('hex');
  const created = await db.$transaction(async (tx) => {
    if (parsed.repoId) {
      await lockAndValidateRepository(tx, parsed.repoId, parsed.teamId, team.orgId);
    }
    return tx.knowledgeItem.create({
      data: {
        content: parsed.content,
        contentDigest: digest,
        events: { create: { action: 'CREATE_CURATED', actorId: userId, version: 1 } },
        orgId: team.orgId,
        originTeamId: parsed.teamId,
        ownerTeamId: parsed.teamId,
        repoId: parsed.repoId,
        status: 'UNREVIEWED',
        title: parsed.title,
        type: parsed.type,
        visibility: 'REPOSITORY',
      },
      select: { id: true, version: true },
    });
  });
  return { id: created.id, version: 1 };
}

export async function submitKnowledgeLearning(
  db: PrismaClient,
  principal: TrustedKnowledgeWorkflowPrincipal,
  input: unknown,
  resolveEvidence: KnowledgeEvidenceResolver,
  producer: { recordingId: string; specNodeId: string; stepAttempt: number }
): Promise<{ id: string; version: number; created: boolean }> {
  const parsed = CreateKnowledgeLearningSchema.parse(input);
  if (!principal?.[workflowPrincipalTag]) {
    throw new KnowledgeAccessError();
  }
  const digest = createHash('sha256')
    .update(parsed.title)
    .update('\0')
    .update(parsed.content)
    .digest('hex');
  if (
    !producer.recordingId ||
    !producer.specNodeId ||
    !Number.isInteger(producer.stepAttempt) ||
    producer.stepAttempt < 1 ||
    parsed.nodeId !== producer.specNodeId
  ) {
    throw new KnowledgeAccessError('Learning producer does not match the current workflow node');
  }
  // Every attempt, including an idempotent retry, must still prove the exact evidence references.
  const validation = await resolveEvidence(parsed.evidence, {
    requestedNodeId: producer.specNodeId,
    runId: principal.runId,
  });
  if (validation.nodeId !== producer.specNodeId) {
    throw new KnowledgeAccessError('Evidence resolver returned mismatched execution attribution');
  }
  const evidence = KnowledgeEvidenceSchema.array().min(1).max(10).parse(validation.evidence);
  const existing = await db.knowledgeItem.findFirst({
    select: {
      contentDigest: true,
      evidence: true,
      id: true,
      modelSpec: true,
      producerAgentKey: true,
      producerNodeId: true,
      version: true,
    },
    where: {
      idempotencyKey: parsed.idempotencyKey,
      producerNodeId: producer.specNodeId,
      producerRunId: principal.runId,
    },
  });
  if (existing) {
    if (
      existing.contentDigest !== digest ||
      existing.producerNodeId !== validation.nodeId ||
      existing.producerAgentKey !== validation.producerAgentKey ||
      existing.modelSpec !== validation.modelSpec ||
      !sameKnowledgeEvidence(existing.evidence, evidence)
    ) {
      throw new KnowledgeVersionConflictError();
    }
    return { created: false, id: existing.id, version: existing.version };
  }
  let created: { id: string; version: number };
  try {
    created = await db.$transaction(async (tx) => {
      await lockCurrentWorkflowRun(tx, principal.runId, principal.temporalRunId);
      if (principal.repoId) {
        await lockAndValidateRepository(tx, principal.repoId, principal.teamId, principal.orgId);
      }
      return tx.knowledgeItem.create({
        data: {
          content: parsed.content,
          contentDigest: digest,
          events: { create: { action: 'SUBMIT', actorId: null, version: 1 } },
          evidence,
          idempotencyKey: parsed.idempotencyKey,
          modelSpec: validation.modelSpec,
          orgId: principal.orgId,
          originTeamId: principal.teamId,
          ownerTeamId: principal.teamId,
          producerAgentKey: validation.producerAgentKey,
          producerNodeId: validation.nodeId,
          producerRunId: principal.runId,
          repoId: principal.repoId,
          status: 'UNREVIEWED',
          title: parsed.title,
          type: 'LEARNING',
          visibility: 'REPOSITORY',
        },
        select: { id: true, version: true },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const retryWinner = await db.knowledgeItem.findFirst({
      select: {
        contentDigest: true,
        evidence: true,
        id: true,
        modelSpec: true,
        producerAgentKey: true,
        producerNodeId: true,
        version: true,
      },
      where: {
        idempotencyKey: parsed.idempotencyKey,
        producerNodeId: producer.specNodeId,
        producerRunId: principal.runId,
      },
    });
    if (
      !retryWinner ||
      retryWinner.contentDigest !== digest ||
      retryWinner.producerNodeId !== validation.nodeId ||
      retryWinner.producerAgentKey !== validation.producerAgentKey ||
      retryWinner.modelSpec !== validation.modelSpec ||
      !sameKnowledgeEvidence(retryWinner.evidence, evidence)
    ) {
      throw new KnowledgeVersionConflictError();
    }
    return { created: false, id: retryWinner.id, version: retryWinner.version };
  }
  return { ...created, created: true };
}

function sameKnowledgeEvidence(value: unknown, expected: KnowledgeEvidence[]): boolean {
  const parsed = KnowledgeEvidenceSchema.array().safeParse(value);
  return (
    parsed.success &&
    parsed.data.length === expected.length &&
    parsed.data.every((item, index) => {
      const candidate = expected[index];
      return (
        candidate !== undefined &&
        item.kind === candidate.kind &&
        item.reference === candidate.reference &&
        item.note === candidate.note
      );
    })
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

async function requireKnowledgeSourceCapability(
  db: Db,
  userId: string,
  repoId: string | null,
  capability?: KnowledgeRepositoryGateCapability
): Promise<void> {
  if (repoId === null) {
    return;
  }
  const repositories = capabilityRepositories(
    capability as KnowledgeRepositoryGateCapability,
    'user',
    userId
  );
  if (!repositories.includes(repoId)) {
    throw new KnowledgeAccessError('Source repository access required');
  }
  const repository = await db.connection.findFirst({
    select: { id: true },
    where: {
      id: repoId,
      isActive: true,
      team: { isActive: true, organization: { isActive: true } },
      type: 'git_repo',
    },
  });
  if (!repository) {
    throw new KnowledgeAccessError('Source repository is no longer available');
  }
}

async function humanMembership(db: Db, userId: string, teamId: string, orgId: string) {
  const [user, member, orgMember, team] = await Promise.all([
    db.user.findUnique({ select: { isActive: true, role: true }, where: { id: userId } }),
    db.teamMembership.findUnique({
      select: { role: true },
      where: {
        team: { isActive: true, organization: { isActive: true } },
        userId_teamId: { teamId, userId },
      },
    }),
    db.organizationMembership.findUnique({
      select: { role: true },
      where: { organization: { isActive: true }, userId_orgId: { orgId, userId } },
    }),
    db.team.findUnique({
      select: { isActive: true, organization: { select: { isActive: true } }, orgId: true },
      where: { id: teamId },
    }),
  ]);
  if (!user?.isActive || !team?.isActive || !team.organization.isActive || team.orgId !== orgId) {
    throw new KnowledgeAccessError();
  }
  return {
    orgRole: orgMember?.role ?? null,
    platformAdmin: user.role === 'ADMIN',
    role: member?.role ?? null,
  };
}

export async function approveKnowledgeItem(
  db: PrismaClient,
  userId: string,
  itemId: string,
  input: unknown,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: 'APPROVED'; version: number }> {
  const parsed = ApproveKnowledgeItemSchema.parse(input);
  return db.$transaction(async (tx) => {
    const item = await tx.knowledgeItem.findUnique({
      select: { orgId: true, ownerTeamId: true, repoId: true, status: true, version: true },
      where: { id: itemId },
    });
    if (!item) {
      throw new KnowledgeAccessError();
    }
    if (parsed.visibility === 'REPOSITORY' || parsed.visibility === 'TEAM') {
      if (parsed.selectedTeamIds.length) {
        throw new KnowledgeAccessError('Unexpected selected teams');
      }
    } else if (parsed.visibility === 'ORGANIZATION' && parsed.selectedTeamIds.length) {
      throw new KnowledgeAccessError('Unexpected selected teams');
    } else if (parsed.visibility === 'SELECTED_TEAMS' && parsed.selectedTeamIds.length === 0) {
      throw new KnowledgeAccessError('Selected-team publication requires at least one recipient');
    }
    await requireKnowledgeSourceCapability(tx, userId, item.repoId, repositoryCapability);
    const actor = await humanMembership(tx, userId, item.ownerTeamId, item.orgId);
    if (!canApproveKnowledge(actor.role, actor.orgRole, actor.platformAdmin, parsed.visibility)) {
      throw new KnowledgeAccessError();
    }
    if (
      item.version !== parsed.expectedVersion ||
      !['UNREVIEWED', 'REJECTED'].includes(item.status)
    ) {
      throw new KnowledgeVersionConflictError();
    }
    if (parsed.visibility === 'SELECTED_TEAMS' && parsed.selectedTeamIds.length) {
      const recipients = await tx.team.findMany({
        select: { id: true },
        where: {
          id: { in: parsed.selectedTeamIds },
          isActive: true,
          organization: { isActive: true },
          orgId: item.orgId,
        },
      });
      if (recipients.length !== parsed.selectedTeamIds.length) {
        throw new KnowledgeAccessError('Selected teams must belong to the owning organization');
      }
    }
    const updated = await tx.knowledgeItem.updateMany({
      data: {
        approvedAt: new Date(),
        approvedById: userId,
        approvedVersion: parsed.expectedVersion + 1,
        status: 'APPROVED',
        version: parsed.expectedVersion + 1,
        visibility: parsed.visibility,
      },
      where: {
        id: itemId,
        ownerTeamId: item.ownerTeamId,
        status: item.status,
        version: parsed.expectedVersion,
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeVersionConflictError();
    }
    await tx.knowledgeItemTeamGrant.deleteMany({
      where: { knowledgeItem: { ownerTeamId: item.ownerTeamId }, knowledgeItemId: itemId },
    });
    if (parsed.visibility === 'SELECTED_TEAMS') {
      await tx.knowledgeItemTeamGrant.createMany({
        data: parsed.selectedTeamIds.map((teamId) => ({ knowledgeItemId: itemId, teamId })),
      });
    }
    await tx.knowledgeItemEvent.create({
      data: {
        action: `APPROVE:${parsed.visibility}`,
        actorId: userId,
        knowledgeItemId: itemId,
        version: parsed.expectedVersion + 1,
      },
    });
    return { id: itemId, status: 'APPROVED', version: parsed.expectedVersion + 1 };
  });
}

export async function publishApprovedKnowledgeItem(
  db: PrismaClient,
  userId: string,
  itemId: string,
  input: unknown,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: 'APPROVED'; version: number }> {
  const parsed = ApproveKnowledgeItemSchema.parse(input);
  return db.$transaction(async (tx) => {
    const item = await tx.knowledgeItem.findUnique({
      select: { orgId: true, ownerTeamId: true, repoId: true, status: true, version: true },
      where: { id: itemId },
    });
    if (!item) {
      throw new KnowledgeAccessError();
    }
    if (parsed.visibility === 'SELECTED_TEAMS' && parsed.selectedTeamIds.length === 0) {
      throw new KnowledgeAccessError('Selected-team publication requires at least one recipient');
    }
    if (parsed.visibility !== 'SELECTED_TEAMS' && parsed.selectedTeamIds.length !== 0) {
      throw new KnowledgeAccessError('Unexpected selected teams');
    }
    await requireKnowledgeSourceCapability(tx, userId, item.repoId, repositoryCapability);
    const actor = await humanMembership(tx, userId, item.ownerTeamId, item.orgId);
    if (!canApproveKnowledge(actor.role, actor.orgRole, actor.platformAdmin, parsed.visibility)) {
      throw new KnowledgeAccessError();
    }
    if (item.status !== 'APPROVED' || item.version !== parsed.expectedVersion) {
      throw new KnowledgeVersionConflictError();
    }
    if (parsed.visibility === 'SELECTED_TEAMS') {
      const recipients = await tx.team.findMany({
        select: { id: true },
        where: {
          id: { in: parsed.selectedTeamIds },
          isActive: true,
          organization: { isActive: true },
          orgId: item.orgId,
        },
      });
      if (recipients.length !== parsed.selectedTeamIds.length) {
        throw new KnowledgeAccessError(
          'Selected teams must be active and belong to the owning organization'
        );
      }
    }
    const version = parsed.expectedVersion + 1;
    const updated = await tx.knowledgeItem.updateMany({
      data: {
        approvedAt: new Date(),
        approvedById: userId,
        approvedVersion: version,
        version,
        visibility: parsed.visibility,
      },
      where: {
        id: itemId,
        ownerTeamId: item.ownerTeamId,
        status: 'APPROVED',
        version: parsed.expectedVersion,
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeVersionConflictError();
    }
    await tx.knowledgeItemTeamGrant.deleteMany({
      where: { knowledgeItem: { ownerTeamId: item.ownerTeamId }, knowledgeItemId: itemId },
    });
    if (parsed.visibility === 'SELECTED_TEAMS') {
      await tx.knowledgeItemTeamGrant.createMany({
        data: parsed.selectedTeamIds.map((teamId) => ({ knowledgeItemId: itemId, teamId })),
      });
    }
    await tx.knowledgeItemEvent.create({
      data: {
        action: `PUBLISH:${parsed.visibility}`,
        actorId: userId,
        knowledgeItemId: itemId,
        version,
      },
    });
    return { id: itemId, status: 'APPROVED', version };
  });
}

export async function rejectKnowledgeItem(
  db: PrismaClient,
  userId: string,
  itemId: string,
  expectedVersion: number,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: 'REJECTED'; version: number }> {
  return transitionKnowledgeItem(
    db,
    userId,
    itemId,
    expectedVersion,
    'REJECTED',
    ['UNREVIEWED'],
    'REJECT',
    repositoryCapability
  );
}

export async function supersedeKnowledgeItem(
  db: PrismaClient,
  userId: string,
  itemId: string,
  expectedVersion: number,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: 'SUPERSEDED'; version: number }> {
  return transitionKnowledgeItem(
    db,
    userId,
    itemId,
    expectedVersion,
    'SUPERSEDED',
    ['APPROVED'],
    'SUPERSEDE',
    repositoryCapability
  );
}

async function transitionKnowledgeItem<S extends 'REJECTED' | 'SUPERSEDED'>(
  db: PrismaClient,
  userId: string,
  itemId: string,
  expectedVersion: number,
  status: S,
  allowedStatuses: Array<'UNREVIEWED' | 'APPROVED'>,
  action: string,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: S; version: number }> {
  return db.$transaction(async (tx) => {
    const item = await tx.knowledgeItem.findUnique({
      select: { orgId: true, ownerTeamId: true, repoId: true, status: true, version: true },
      where: { id: itemId },
    });
    if (!item) {
      throw new KnowledgeAccessError();
    }
    await requireKnowledgeSourceCapability(tx, userId, item.repoId, repositoryCapability);
    const actor = await humanMembership(tx, userId, item.ownerTeamId, item.orgId);
    if (!actor.platformAdmin && actor.role !== 'LEAD' && actor.role !== 'ADMIN') {
      throw new KnowledgeAccessError();
    }
    if (
      item.version !== expectedVersion ||
      !allowedStatuses.includes(item.status as 'UNREVIEWED' | 'APPROVED')
    ) {
      throw new KnowledgeVersionConflictError();
    }
    const updated = await tx.knowledgeItem.updateMany({
      data: {
        approvedAt: null,
        approvedById: null,
        approvedVersion: null,
        status,
        version: expectedVersion + 1,
        visibility: 'REPOSITORY',
      },
      where: {
        id: itemId,
        ownerTeamId: item.ownerTeamId,
        status: item.status,
        version: expectedVersion,
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeVersionConflictError();
    }
    await tx.knowledgeItemTeamGrant.deleteMany({
      where: { knowledgeItem: { ownerTeamId: item.ownerTeamId }, knowledgeItemId: itemId },
    });
    await tx.knowledgeItemEvent.create({
      data: { action, actorId: userId, knowledgeItemId: itemId, version: expectedVersion + 1 },
    });
    return { id: itemId, status, version: expectedVersion + 1 };
  });
}

export async function reviseKnowledgeItem(
  db: PrismaClient,
  userId: string,
  itemId: string,
  input: unknown,
  repositoryCapability?: KnowledgeRepositoryGateCapability
): Promise<{ id: string; status: 'UNREVIEWED'; version: number }> {
  const parsed = ReviseKnowledgeItemSchema.parse(input);
  return db.$transaction(async (tx) => {
    const item = await tx.knowledgeItem.findUnique({
      select: { orgId: true, ownerTeamId: true, repoId: true, status: true, version: true },
      where: { id: itemId },
    });
    if (!item) {
      throw new KnowledgeAccessError();
    }
    await requireKnowledgeSourceCapability(tx, userId, item.repoId, repositoryCapability);
    const actor = await humanMembership(tx, userId, item.ownerTeamId, item.orgId);
    if (!actor.platformAdmin && actor.role !== 'LEAD' && actor.role !== 'ADMIN') {
      throw new KnowledgeAccessError();
    }
    if (item.version !== parsed.expectedVersion || item.status === 'SUPERSEDED') {
      throw new KnowledgeVersionConflictError();
    }
    const version = parsed.expectedVersion + 1;
    const digest = createHash('sha256')
      .update(parsed.title)
      .update('\0')
      .update(parsed.content)
      .digest('hex');
    const updated = await tx.knowledgeItem.updateMany({
      data: {
        approvedAt: null,
        approvedById: null,
        approvedVersion: null,
        content: parsed.content,
        contentDigest: digest,
        embeddingDigest: null,
        status: 'UNREVIEWED',
        title: parsed.title,
        version,
        visibility: 'REPOSITORY',
      },
      where: {
        id: itemId,
        ownerTeamId: item.ownerTeamId,
        status: item.status,
        version: parsed.expectedVersion,
      },
    });
    if (updated.count !== 1) {
      throw new KnowledgeVersionConflictError();
    }
    await tx.knowledgeItemTeamGrant.deleteMany({
      where: { knowledgeItem: { ownerTeamId: item.ownerTeamId }, knowledgeItemId: itemId },
    });
    await tx.knowledgeItemEvent.create({
      data: { action: 'REVISE', actorId: userId, knowledgeItemId: itemId, version },
    });
    return { id: itemId, status: 'UNREVIEWED', version };
  });
}
