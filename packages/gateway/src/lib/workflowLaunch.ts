import type { Prisma, Role } from '@auto-swe/shared';
import type { AccessActor } from '@auto-swe/shared/lib/accessActor';
import { sameRepositoryIds } from '@auto-swe/shared/lib/sameRepositoryIds';
import {
  chooseWorkflowId,
  type WorkflowIdAllocation,
  type WorkflowIdOwner,
  workflowIdFamilyBases,
} from '@auto-swe/shared/lib/workflowId';
import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../plugins/auth.js';
import { auditContextData } from './auditContext.js';
import { isUniqueConstraintError } from './prismaErrors.js';

/**
 * Launch a tracked run: write its ledger rows, then start the Temporal
 * workflow, compensating if the start fails.
 *
 * ## Why the ledger comes first
 *
 * These handlers used to start Temporal and only then write `RunInput` /
 * `ActiveWorkflow`, on the reasoning that Temporal's
 * `WorkflowExecutionAlreadyStartedError` was the idempotency gate and that
 * orphaned DB rows would block future retries. Both halves worked out badly:
 *
 * - **The failure modes are not symmetric.** If the DB write failed, a workflow
 *   was already running — burning budget, pushing branches, opening PRs — with
 *   no row to attribute it to. `recordLlmUsage` and `finalizeWorkflowRun` then
 *   operated on rows that did not exist. The reverse orphan (rows, no workflow)
 *   is inert, visible in the dashboard, and operator-recoverable.
 * - **It wedged the ticket anyway.** `allocateWorkflowId` derives its `-rN`
 *   suffix from the `ActiveWorkflow` rows for a ticket. With no row written, a
 *   resubmission re-allocated the *base* ID, which Temporal then rejected as
 *   already-started — so the ticket stayed unsubmittable until the orphaned
 *   execution aged out, with nothing in the DB to explain why.
 *
 * Writing the rows first also makes dedup **atomic**: the unique index on
 * `ActiveWorkflow.temporalWorkflowId` decides the winner of two concurrent
 * submissions, where the previous read-then-start sequence had a TOCTOU gap.
 * It is durable too — a DB row outlives Temporal's execution-retention window,
 * so a deterministic ID (`jira-<ticket>`) keeps deduping after Temporal has
 * forgotten the closed execution.
 *
 * ## Compensation
 *
 * If the start fails we delete the rows we just wrote, so a transient Temporal
 * outage doesn't permanently block the ticket. Compensation is best-effort: if
 * it also fails, the rows remain as a visible non-terminal run — the inert,
 * recoverable failure mode rather than the invisible one.
 */

/**
 * Rows to write before the workflow starts. `runInput` is omitted on re-runs;
 * `activeWorkflow` is omitted by launches that do not keep a spend ledger.
 *
 * **Omitting `activeWorkflow` gives up atomic dedup**, because the unique index
 * on `ActiveWorkflow.temporalWorkflowId` is what decides the winner of two
 * concurrent submissions. Such a launch still gets ledger-before-start ordering
 * and compensation; its only duplicate protection is Temporal's own
 * `WorkflowExecutionAlreadyStartedError`, which is a TOCTOU-prone gate and does
 * nothing at all when the workflow ID is random. Prefer passing the row.
 */
export type WorkflowLedgerRows = {
  /** `RunInput` row, when this launch creates one (skipped when re-running). */
  runInput?: Record<string, unknown>;
  /** Exact, database-resolved repo-less tenant identity; absent means UNKNOWN. */
  knowledgeSourceTeam?: { teamId: string; orgId: string };
  /** Exact database-resolved repository identity authorized by the route. */
  knowledgeSourceRepo?: LaunchRepositorySource;
  /** Exact, authorized target identities for a multi-repository launch. */
  knowledgeSourceRepos?: LaunchRepositorySource[];
} & (
  | {
      /** `ActiveWorkflow` row. Must carry `temporalWorkflowId`. */
      activeWorkflow: Record<string, unknown> & { temporalWorkflowId: string };
      temporalWorkflowId?: never;
    }
  | {
      /**
       * No `ActiveWorkflow` row — PRD runs track their spend through
       * `AgentTrace` instead (`finalizeWorkflowRun` sums the traces when the
       * ledger join is empty). The ID is still needed for compensation logging.
       */
      activeWorkflow?: undefined;
      temporalWorkflowId: string;
    }
);

export interface LaunchRepositorySource {
  repoId: string;
  teamId: string;
  orgId: string;
}

export interface LaunchSourceAuthorization {
  actor?: AccessActor;
  /** Schedule team chosen at the route boundary; recheck its lead claim in the transaction. */
  requiredTeamId?: string;
}

export type LaunchWorkflowResult =
  | {
      ok: true;
      /** `null` when the launch wrote no `ActiveWorkflow` row. */
      activeWorkflowId: string | null;
    }
  /**
   * Another run already owns this workflow ID — either the ledger insert lost
   * the unique-index race or Temporal reported the execution already started.
   * Callers map this to their own conflict response (409 / `duplicate: true`).
   */
  | {
      ok: false;
      reason: 'DUPLICATE';
      /**
       * Where the duplicate was detected. `ledger`: the row insert hit a unique index, so
       * the owner is in the database. `temporal`: the ledger write succeeded (and was
       * compensated) but Temporal already had an execution under this id, one no row
       * accounts for. Callers that do not care ignore it.
       */
      source: 'ledger' | 'temporal';
    }
  /**
   * The caller's `guard` refused the launch. Nothing was written. Only a launch that passes a
   * `guard` can see this.
   */
  | { ok: false; reason: 'GUARD_REFUSED'; refusal: string };

/**
 * A check that must hold at the moment the ledger rows are written, run inside the same database
 * transaction that writes them. Returns a refusal reason, or null to let the launch proceed. It
 * runs before any ledger write, so a check-then-insert that has to be atomic (a per-user cap,
 * under a lock the guard takes itself) is atomic.
 */
export type LaunchGuard = (tx: Prisma.TransactionClient) => Promise<string | null>;

/**
 * Resolve a repository source only if the exact identity authorized by the route is still current.
 * The connection row lock serializes this check with repository moves. Provider-backed permission
 * checks happen before this transaction; this boundary rechecks only database-owned authority.
 */
export async function snapshotAuthorizedRepositorySource(
  tx: Prisma.TransactionClient,
  expected: LaunchRepositorySource,
  authorization: LaunchSourceAuthorization = {}
): Promise<LaunchRepositorySource | null> {
  const requestActor = authorization.actor;
  let actor: AccessActor | undefined;
  if (requestActor) {
    // Lock order: current actor User → Connection → sorted Teams → sorted Organizations.
    // CLAUDE.md §7 exception: serialize this role/active check with user updates.
    const lockedUser = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${requestActor.sub}::uuid FOR UPDATE
    `;
    const currentUser = lockedUser.length
      ? await tx.user.findUnique({
          select: { id: true, isActive: true, role: true },
          where: { id: requestActor.sub },
        })
      : null;
    if (!currentUser?.isActive) {
      return null;
    }
    actor = { role: currentUser.role as Role, sub: currentUser.id };
  }
  // CLAUDE.md §7 exception: repository moves lock this row; Prisma cannot express SELECT FOR UPDATE.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM connections WHERE id = ${expected.repoId}::uuid FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  // The connection lock makes the current owner and share list stable; lock every team whose
  // membership can authorize access, in deterministic order, before checking memberships. Team
  // membership writers take these same team-row locks; share writers take the connection lock.
  const current = await tx.connection.findUnique({
    select: { shares: { select: { teamId: true } }, teamId: true },
    where: { id: expected.repoId },
  });
  if (!current) {
    return null;
  }
  const teamIds = [
    ...new Set(
      [
        current.teamId,
        ...current.shares.map((share) => share.teamId),
        expected.teamId,
        authorization.requiredTeamId,
      ].filter((id): id is string => !!id)
    ),
  ].sort();
  for (const teamId of teamIds) {
    // CLAUDE.md §7 exception: source authorization must serialize with team membership changes.
    const lockedTeam = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE
    `;
    if (lockedTeam.length === 0) {
      return null;
    }
  }
  // CLAUDE.md §7 exception: organization activation and membership changes use this row lock.
  const lockedOrg = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM organizations WHERE id = ${expected.orgId}::uuid FOR UPDATE
  `;
  if (lockedOrg.length === 0) {
    return null;
  }

  const membershipWhere = actor ? { userId: actor.sub } : undefined;
  const repo = await tx.connection.findUnique({
    select: {
      id: true,
      isActive: true,
      shares: {
        select: {
          team: {
            select: {
              isActive: true,
              memberships: {
                select: { userId: true },
                ...(membershipWhere ? { where: membershipWhere } : {}),
              },
            },
          },
          teamId: true,
        },
      },
      team: {
        select: {
          id: true,
          isActive: true,
          memberships: {
            select: { userId: true },
            ...(membershipWhere ? { where: membershipWhere } : {}),
          },
          organization: { select: { isActive: true } },
          orgId: true,
        },
      },
      teamId: true,
      type: true,
    },
    where: { id: expected.repoId },
  });
  if (
    !repo?.isActive ||
    repo.type !== 'git_repo' ||
    !repo.team?.isActive ||
    !repo.team.organization.isActive ||
    repo.id !== expected.repoId ||
    repo.teamId !== expected.teamId ||
    repo.team.orgId !== expected.orgId
  ) {
    return null;
  }

  if (actor && actor.role !== 'ADMIN') {
    const repoMember =
      repo.team.memberships.some((membership) => membership.userId === actor.sub) ||
      repo.shares.some(
        (share) =>
          share.team.isActive &&
          share.team.memberships.some((membership) => membership.userId === actor.sub)
      );
    if (!repoMember) {
      return null;
    }
    const orgMembership = await tx.organizationMembership.findUnique({
      select: { userId: true },
      where: { userId_orgId: { orgId: repo.team.orgId, userId: actor.sub } },
    });
    if (!orgMembership) {
      return null;
    }
  }

  if (authorization.requiredTeamId) {
    const selectedTeamIsVisible =
      repo.teamId === authorization.requiredTeamId ||
      repo.shares.some(
        (share) => share.teamId === authorization.requiredTeamId && share.team.isActive
      );
    if (!selectedTeamIsVisible) {
      return null;
    }
    if (actor?.role !== 'ADMIN') {
      const membership = actor
        ? await tx.teamMembership.findUnique({
            select: { role: true },
            where: {
              userId_teamId: { teamId: authorization.requiredTeamId, userId: actor.sub },
            },
          })
        : null;
      if (membership?.role !== 'LEAD' && membership?.role !== 'ADMIN') {
        return null;
      }
    }
  }

  return { orgId: repo.team.orgId, repoId: repo.id, teamId: repo.teamId };
}

async function snapshotAuthorizedTeamSource(
  tx: Prisma.TransactionClient,
  expected: { teamId: string; orgId: string },
  requestActor?: AccessActor
): Promise<{ teamId: string; orgId: string } | null> {
  let actor: AccessActor | undefined;
  if (requestActor) {
    // Lock order: current actor User → Team → Organization.
    // CLAUDE.md §7 exception: serialize this role/active check with user updates.
    const lockedUser = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${requestActor.sub}::uuid FOR UPDATE
    `;
    const currentUser = lockedUser.length
      ? await tx.user.findUnique({
          select: { id: true, isActive: true, role: true },
          where: { id: requestActor.sub },
        })
      : null;
    if (!currentUser?.isActive) {
      return null;
    }
    actor = { role: currentUser.role as Role, sub: currentUser.id };
  }
  // CLAUDE.md §7 exception: lock the tenant row while checking its launch snapshot.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM teams WHERE id = ${expected.teamId}::uuid FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  // CLAUDE.md §7 exception: tenant activation must remain stable through the source write.
  const lockedOrg = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM organizations WHERE id = ${expected.orgId}::uuid FOR UPDATE
  `;
  if (lockedOrg.length === 0) {
    return null;
  }
  const team = await tx.team.findUnique({
    select: {
      id: true,
      isActive: true,
      organization: { select: { isActive: true } },
      orgId: true,
      ...(actor ? { memberships: { select: { userId: true }, where: { userId: actor.sub } } } : {}),
    },
    where: { id: expected.teamId },
  });
  if (
    !team?.isActive ||
    !team.organization.isActive ||
    team.id !== expected.teamId ||
    team.orgId !== expected.orgId ||
    (actor &&
      actor.role !== 'ADMIN' &&
      !team.memberships.some((membership) => membership.userId === actor.sub))
  ) {
    return null;
  }
  if (actor && actor.role !== 'ADMIN') {
    const membership = await tx.organizationMembership.findUnique({
      select: { userId: true },
      where: { userId_orgId: { orgId: team.orgId, userId: actor.sub } },
    });
    if (!membership) {
      return null;
    }
  }
  return { orgId: team.orgId, teamId: team.id };
}

export async function launchTrackedWorkflow(
  prisma: FastifyInstance['prisma'],
  rows: WorkflowLedgerRows,
  start: () => Promise<unknown>,
  opts?: {
    log?: { error: (obj: unknown, msg?: string) => void };
    guard?: LaunchGuard;
    sourceAuthorization?: LaunchSourceAuthorization;
    /**
     * Who launched the run and through which door (`work-request`, `webhook`, ...), for the
     * audit row written once the workflow has started. Omit `actor` for a system launch.
     */
    audit?: { actor?: { sub: string } | null; source: string; templateId?: string };
  }
): Promise<LaunchWorkflowResult> {
  const { runInput } = rows;
  // Read `rows.activeWorkflow` rather than a destructured local: destructuring
  // discards the union narrowing that proves one of the two carries the ID.
  const activeWorkflow = rows.activeWorkflow;
  const temporalWorkflowId: string = rows.activeWorkflow
    ? rows.activeWorkflow.temporalWorkflowId
    : rows.temporalWorkflowId;

  // 1. Ledger first, atomically. A P2002 here is the dedup gate firing.
  let activeWorkflowId: string | null;
  try {
    const outcome = await prisma.$transaction(
      async (tx): Promise<{ refusal: string } | { activeWorkflowId: string | null }> => {
        if (opts?.guard) {
          const refusal = await opts.guard(tx);
          if (refusal !== null) {
            return { refusal };
          }
        }

        const unknownSource = {
          knowledgeSourceKind: 'UNKNOWN' as const,
          knowledgeSourceOrgId: null,
          knowledgeSourceRepoId: null,
          knowledgeSourceTeamId: null,
        };
        let source:
          | typeof unknownSource
          | {
              knowledgeSourceKind: 'REPOSITORY' | 'TEAM';
              knowledgeSourceOrgId: string;
              knowledgeSourceRepoId: string | null;
              knowledgeSourceTeamId: string;
            } = unknownSource;
        const crossRepo = runInput?.isCrossRepo === true;
        const activeRepoId = runInput
          ? ((activeWorkflow?.repoId as string | null | undefined) ?? null)
          : null;
        const requestRepoId = runInput
          ? ((runInput.connectionId as string | null | undefined) ?? null)
          : null;
        const repoId = crossRepo ? null : (activeRepoId ?? requestRepoId);
        const expectedRepo = rows.knowledgeSourceRepo;
        if (
          expectedRepo &&
          repoId === expectedRepo.repoId &&
          (!activeRepoId || activeRepoId === expectedRepo.repoId) &&
          (!requestRepoId || requestRepoId === expectedRepo.repoId)
        ) {
          const snapshot = await snapshotAuthorizedRepositorySource(
            tx,
            expectedRepo,
            opts?.sourceAuthorization
          );
          if (snapshot) {
            source = {
              knowledgeSourceKind: 'REPOSITORY',
              knowledgeSourceOrgId: snapshot.orgId,
              knowledgeSourceRepoId: snapshot.repoId,
              knowledgeSourceTeamId: snapshot.teamId,
            };
          }
        } else if (!repoId && rows.knowledgeSourceTeam) {
          const snapshot = await snapshotAuthorizedTeamSource(
            tx,
            rows.knowledgeSourceTeam,
            opts?.sourceAuthorization?.actor
          );
          if (snapshot) {
            source = {
              knowledgeSourceKind: 'TEAM',
              knowledgeSourceOrgId: snapshot.orgId,
              knowledgeSourceRepoId: null,
              knowledgeSourceTeamId: snapshot.teamId,
            };
          }
        }

        let knowledgeRepoSources: LaunchRepositorySource[] = [];
        if (rows.knowledgeSourceRepos) {
          const expectedSources = [...rows.knowledgeSourceRepos].sort((a, b) =>
            a.repoId.localeCompare(b.repoId)
          );
          const resolved: LaunchRepositorySource[] = [];
          for (const expected of expectedSources) {
            const snapshot = await snapshotAuthorizedRepositorySource(
              tx,
              expected,
              opts?.sourceAuthorization
            );
            if (!snapshot) {
              resolved.length = 0;
              break;
            }
            resolved.push(snapshot);
          }
          if (resolved.length === expectedSources.length) {
            knowledgeRepoSources = resolved;
          }
        }

        if (runInput) {
          await tx.runInput.create({
            data: {
              ...runInput,
              ...source,
              ...(rows.knowledgeSourceRepos ? { knowledgeRepoSources } : {}),
            } as never,
          });
        }
        const created = activeWorkflow
          ? await tx.activeWorkflow.create({ data: activeWorkflow as never })
          : null;
        return { activeWorkflowId: created ? (created as { id: string }).id : null };
      }
    );
    if ('refusal' in outcome) {
      return { ok: false, reason: 'GUARD_REFUSED', refusal: outcome.refusal };
    }
    activeWorkflowId = outcome.activeWorkflowId;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { ok: false, reason: 'DUPLICATE', source: 'ledger' };
    }
    throw err;
  }

  // 2. Start the workflow; undo the ledger write if it never got going.
  try {
    await start();
  } catch (err) {
    await compensate(
      prisma,
      { activeWorkflowId, runInputId: runInput?.id as string | undefined },
      {
        log: opts?.log,
        temporalWorkflowId,
      }
    );
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return { ok: false, reason: 'DUPLICATE', source: 'temporal' };
    }
    throw err;
  }

  await recordLaunchAudit(prisma, rows, activeWorkflowId, opts);
  return { activeWorkflowId, ok: true };
}

/**
 * One audit row for a launch whose workflow has started. Written outside the ledger transaction
 * and after the start, so a refused, duplicate or compensated launch leaves none. The run row is
 * created later by the worker, so the entity is the work request (or, for a launch without one,
 * the spend-ledger row). Never throws: a failed audit write must not fail a launched run.
 */
async function recordLaunchAudit(
  prisma: FastifyInstance['prisma'],
  rows: WorkflowLedgerRows,
  activeWorkflowId: string | null,
  opts?: {
    log?: { error: (obj: unknown, msg?: string) => void };
    audit?: { actor?: { sub: string } | null; source: string; templateId?: string };
  }
): Promise<void> {
  const workRequestId = (rows.runInput?.id ?? rows.activeWorkflow?.workRequestId) as
    | string
    | null
    | undefined;
  const entityId = workRequestId ?? activeWorkflowId;
  if (!entityId) {
    return;
  }
  try {
    await prisma.configAuditLog.create({
      data: {
        ...auditContextData(),
        action: 'CREATE',
        actorId: opts?.audit?.actor?.sub ?? null,
        afterJson: {
          source: opts?.audit?.source ?? 'unspecified',
          templateId:
            (rows.runInput?.templateId as string | undefined) ?? opts?.audit?.templateId ?? null,
          temporalWorkflowId: rows.activeWorkflow?.temporalWorkflowId ?? rows.temporalWorkflowId,
          workRequestId: workRequestId ?? null,
        } as never,
        beforeJson: null as never,
        entityId,
        entityType: workRequestId ? 'WorkRequest' : 'ActiveWorkflow',
      },
    });
  } catch (err) {
    opts?.log?.error({ entityId, err }, 'launch audit write failed — the run was launched');
  }
}

/**
 * Best-effort removal of the rows written for a workflow that never started.
 * Never throws: leaving the rows behind is the recoverable failure mode, and
 * the caller still needs to surface the original start error.
 */
async function compensate(
  prisma: FastifyInstance['prisma'],
  ids: { activeWorkflowId: string | null; runInputId?: string },
  ctx: { temporalWorkflowId: string; log?: { error: (obj: unknown, msg?: string) => void } }
): Promise<void> {
  // Each delete is independent: a failure cleaning up one row must not strand
  // the other. (Deleting the ActiveWorkflow first also keeps the FK happy.)
  const deletes: Array<[string, () => Promise<unknown>]> = [
    ...(ids.activeWorkflowId
      ? ([
          [
            'activeWorkflow',
            () => prisma.activeWorkflow.delete({ where: { id: ids.activeWorkflowId as string } }),
          ],
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
    ...(ids.runInputId
      ? ([
          ['runInput', () => prisma.runInput.delete({ where: { id: ids.runInputId as string } })],
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
  ];

  for (const [row, run] of deletes) {
    try {
      await run();
    } catch (cleanupErr) {
      ctx.log?.error(
        { err: cleanupErr, row, temporalWorkflowId: ctx.temporalWorkflowId },
        'workflow start failed and ledger cleanup also failed — row left for manual recovery'
      );
    }
  }
}

/**
 * Allocate the Temporal workflow ID for a ticket+repo. First submission uses
 * the deterministic base ID; re-running a finished ticket gets an `-rN`
 * suffix so Temporal, WorkflowRun (unique on workflowId), and ActiveWorkflow
 * (unique on temporalWorkflowId) all see a fresh execution instead of
 * colliding with the previous one. Returns a conflict when an execution for
 * this ticket+repo is still in flight.
 *
 * Pass `owner` whenever the repository is known. The base ID is not unique
 * across repositories (`generateWorkflowId` joins hyphenated names with
 * hyphens), so without it another tenant's running workflow that merely shares
 * the string reads as "already running" here; with it, that row is recognised
 * as foreign and this ticket gets a disambiguated ID (`chooseWorkflowId`). A row
 * of another repository id with the same identity (same host, owner and name
 * compared case-insensitively) is the same repository, not a foreign one, and
 * conflicts exactly as a row of this id does.
 *
 * `legacyBaseIds` are the ids the same ticket had in earlier formats (stored
 * casing, no host segment: `legacyWorkflowIdBases`). An execution of
 * THIS repository still in flight under one of them blocks a second one exactly as an
 * in-flight execution under `baseId` does — otherwise the upgrade, or giving a
 * repository a host override, would let two runs push the same branch. Another
 * repository's row that merely shares the legacy string does not block.
 * Repointing from one override host to another while a run is in flight is not
 * covered.
 */
export async function allocateWorkflowId(
  prisma: FastifyInstance['prisma'],
  baseId: string,
  owner?: WorkflowIdOwner,
  legacyBaseIds?: readonly string[]
): Promise<WorkflowIdAllocation> {
  // Rows of the same repository stored under another id still count as ours.
  const withIdentity = owner && {
    ...owner,
    sameRepoIds: owner.sameRepoIds ?? (await sameRepositoryIds(prisma, owner.repoId)),
  };
  const bases = workflowIdFamilyBases(
    baseId,
    withIdentity && [withIdentity.repoId, ...withIdentity.sameRepoIds],
    legacyBaseIds
  );
  const rows = await prisma.activeWorkflow.findMany({
    select: {
      currentStatus: true,
      repoId: true,
      temporalWorkflowId: true,
      workRequest: { select: { externalTicketId: true } },
    },
    where: {
      OR: bases.flatMap((b) => [
        { temporalWorkflowId: b },
        { temporalWorkflowId: { startsWith: `${b}-r` } },
      ]),
    },
  });
  return chooseWorkflowId(
    baseId,
    rows.map((r) => ({
      currentStatus: r.currentStatus,
      externalTicketId: r.workRequest?.externalTicketId ?? null,
      repoId: r.repoId,
      temporalWorkflowId: r.temporalWorkflowId,
    })),
    withIdentity,
    legacyBaseIds
  );
}
