import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  approveKnowledgeItem,
  createCuratedKnowledgeItem,
  createUserKnowledgeRepositoryCapability,
  createWorkflowKnowledgeRepositoryCapability,
  getKnowledgeWorkflowEligibilityWhere,
  getReadableKnowledgeItem,
  KnowledgeAccessError,
  KnowledgeVersionConflictError,
  listKnowledgeForWorkflow,
  listManagedKnowledge,
  listReadableKnowledge,
  publishApprovedKnowledgeItem,
  rejectKnowledgeItem,
  resolveKnowledgeWorkflowPrincipal,
  reviseKnowledgeItem,
  submitKnowledgeLearning,
  supersedeKnowledgeItem,
} from './knowledgeService.js';
import { tenantGuardExtension } from './tenantGuard.js';

const repoId = '00000000-0000-4000-8000-000000000003';
const recipientId = '00000000-0000-4000-8000-000000000002';
const teamId = '00000000-0000-4000-8000-000000000001';
const selectedApproval = {
  expectedVersion: 3,
  selectedTeamIds: [recipientId],
  visibility: 'SELECTED_TEAMS',
};

function activeTeam() {
  return { isActive: true, organization: { isActive: true }, orgId: 'org-1' };
}

function database(overrides: Record<string, unknown> = {}) {
  const tx = {
    connection: { findFirst: vi.fn().mockResolvedValue({ id: repoId }) },
    knowledgeItem: {
      findUnique: vi.fn().mockResolvedValue({
        orgId: 'org-1',
        ownerTeamId: teamId,
        repoId: null,
        status: 'UNREVIEWED',
        version: 3,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    knowledgeItemEvent: { create: vi.fn().mockResolvedValue({}) },
    knowledgeItemTeamGrant: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    organizationMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'ORG_MEMBER' }) },
    team: {
      findMany: vi.fn().mockResolvedValue([{ id: recipientId }]),
      findUnique: vi.fn().mockResolvedValue(activeTeam()),
    },
    teamMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'LEAD' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    ...overrides,
  };
  const db = { $transaction: vi.fn((fn: (client: unknown) => unknown) => fn(tx)), ...tx };
  return { db: db as unknown as PrismaClient, tx };
}

function readScopeDb(overrides: Record<string, unknown> = {}) {
  const findMany = vi.fn().mockResolvedValue([]);
  const connectionFindMany = vi.fn().mockResolvedValue([{ id: repoId }]);
  const db = {
    connection: { findMany: connectionFindMany },
    knowledgeItem: { findFirst: vi.fn().mockResolvedValue(null), findMany },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
    organizationMembership: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]) },
    team: { findMany: vi.fn().mockResolvedValue([]) },
    teamMembership: { findMany: vi.fn().mockResolvedValue([{ teamId }]) },
    user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    ...overrides,
  };
  return { connectionFindMany, db: db as unknown as PrismaClient, findMany };
}

function workflowDb() {
  const run = {
    channel: null,
    connection: { id: repoId, teamId },
    id: 'db-run-uuid',
    knowledgeSourceKind: 'REPOSITORY',
    knowledgeSourceOrgId: 'org-1',
    knowledgeSourceRepoId: repoId,
    knowledgeSourceTeamId: teamId,
    launchedById: 'user-1',
    workflowId: 'eng-slug',
    workRequest: { connection: null },
  };
  const db = {
    activeWorkflow: { findFirst: vi.fn().mockResolvedValue({ repository: null }) },
    connection: {
      findFirst: vi.fn().mockResolvedValue({
        id: repoId,
        team: { isActive: true, organization: { isActive: true }, orgId: 'org-1' },
        teamId,
      }),
    },
    knowledgeItem: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    organizationMembership: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
    team: {
      findFirst: vi.fn().mockResolvedValue({
        id: teamId,
        isActive: true,
        organization: { isActive: true },
        orgId: 'org-1',
      }),
    },
    teamMembership: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    workflowRun: { findFirst: vi.fn().mockResolvedValue(run) },
  };
  return { db: db as unknown as PrismaClient, raw: db, run };
}

describe('knowledge lifecycle service', () => {
  it('atomically approves an exact version, advances its lifecycle version, and grants same-org teams', async () => {
    const { db, tx } = database();
    await expect(approveKnowledgeItem(db, 'user-1', 'item-1', selectedApproval)).resolves.toEqual({
      id: 'item-1',
      status: 'APPROVED',
      version: 4,
    });
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedVersion: 4, status: 'APPROVED', version: 4 }),
        where: { id: 'item-1', ownerTeamId: teamId, status: 'UNREVIEWED', version: 3 },
      })
    );
    expect(tx.knowledgeItemTeamGrant.createMany).toHaveBeenCalledWith({
      data: [{ knowledgeItemId: 'item-1', teamId: recipientId }],
    });
  });

  it('requires source capability for repo-origin curated creation', async () => {
    const { db: scopeDb } = readScopeDb();
    const capability = await createUserKnowledgeRepositoryCapability(
      scopeDb,
      'user-1',
      vi.fn().mockResolvedValue(false)
    );
    const create = vi.fn();
    const db = {
      connection: { findFirst: vi.fn().mockResolvedValue({ id: repoId }) },
      knowledgeItem: { create },
      organizationMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'ORG_MEMBER' }) },
      team: { findUnique: vi.fn().mockResolvedValue(activeTeam()) },
      teamMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'LEAD' }) },
      user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    } as unknown as PrismaClient;
    await expect(
      createCuratedKnowledgeItem(
        db,
        'user-1',
        {
          content: 'A source-scoped human reference with enough detail for review.',
          repoId,
          teamId,
          title: 'Repository reference',
          type: 'REFERENCE',
        },
        capability
      )
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    expect(create).not.toHaveBeenCalled();
  });

  it('requires actor-bound source capability for every repo-origin lifecycle mutation', async () => {
    const capabilityDb = readScopeDb();
    const deniedCapability = await createUserKnowledgeRepositoryCapability(
      capabilityDb.db,
      'user-1',
      vi.fn().mockResolvedValue(false)
    );
    const mutations = [
      {
        run: (db: PrismaClient, cap?: never) =>
          approveKnowledgeItem(db, 'user-1', 'item-1', selectedApproval, cap),
        status: 'UNREVIEWED',
      },
      {
        run: (db: PrismaClient, cap?: never) =>
          publishApprovedKnowledgeItem(db, 'user-1', 'item-1', selectedApproval, cap),
        status: 'APPROVED',
      },
      {
        run: (db: PrismaClient, cap?: never) =>
          reviseKnowledgeItem(
            db,
            'user-1',
            'item-1',
            {
              content: 'Revised with enough detail for review.',
              expectedVersion: 3,
              title: 'Revised title',
            },
            cap
          ),
        status: 'APPROVED',
      },
      {
        run: (db: PrismaClient, cap?: never) => rejectKnowledgeItem(db, 'user-1', 'item-1', 3, cap),
        status: 'UNREVIEWED',
      },
      {
        run: (db: PrismaClient, cap?: never) =>
          supersedeKnowledgeItem(db, 'user-1', 'item-1', 3, cap),
        status: 'APPROVED',
      },
    ];
    for (const mutation of mutations) {
      const { db, tx } = database({
        knowledgeItem: {
          findUnique: vi.fn().mockResolvedValue({
            orgId: 'org-1',
            ownerTeamId: teamId,
            repoId,
            status: mutation.status,
            version: 3,
          }),
          updateMany: vi.fn(),
        },
      });
      await expect(mutation.run(db, undefined)).rejects.toBeInstanceOf(KnowledgeAccessError);
      await expect(mutation.run(db, deniedCapability as never)).rejects.toBeInstanceOf(
        KnowledgeAccessError
      );
      expect(tx.knowledgeItem.updateMany).not.toHaveBeenCalled();
    }
    const allowedCapability = await createUserKnowledgeRepositoryCapability(
      capabilityDb.db,
      'user-1',
      vi.fn().mockResolvedValue(true)
    );
    const allowed = database({
      knowledgeItem: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          ownerTeamId: teamId,
          repoId,
          status: 'UNREVIEWED',
          version: 3,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    await expect(
      approveKnowledgeItem(allowed.db, 'user-1', 'item-1', selectedApproval, allowedCapability)
    ).resolves.toMatchObject({ status: 'APPROVED', version: 4 });
    const mismatchedDb = database({
      knowledgeItem: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          ownerTeamId: teamId,
          repoId,
          status: 'UNREVIEWED',
          version: 3,
        }),
        updateMany: vi.fn(),
      },
    });
    await expect(
      approveKnowledgeItem(
        mismatchedDb.db,
        'different-user',
        'item-1',
        selectedApproval,
        allowedCapability
      )
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
  });

  it('uses the current database role when gating a still-member repository after demotion', async () => {
    const authorizeRepository = vi.fn().mockResolvedValue(false);
    const findFirst = vi.fn().mockResolvedValue(null);
    const { db } = readScopeDb({
      knowledgeItem: { findFirst },
      user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    });
    const capability = await createUserKnowledgeRepositoryCapability(
      db,
      'user-1',
      authorizeRepository
    );
    expect(authorizeRepository).toHaveBeenCalledWith(repoId, {
      isPlatformAdmin: false,
      kind: 'user',
      userId: 'user-1',
    });
    await expect(getReadableKnowledgeItem(db, 'user-1', 'repo-item', capability)).resolves.toBe(
      null
    );
    expect(JSON.stringify(findFirst.mock.calls[0]?.[0])).not.toContain(repoId);
  });

  it('runs the platform-admin readable list through the actual KnowledgeItem tenant guard scope', async () => {
    const guard = tenantGuardExtension({ mode: 'throw' });
    const guardedFindMany = vi.fn(async (args: unknown) => {
      const result = await guard.query.$allModels.$allOperations({
        args,
        model: 'KnowledgeItem',
        operation: 'findMany',
        query: async () => [],
      });
      return result as never;
    });
    const { db } = readScopeDb({
      knowledgeItem: { findMany: guardedFindMany },
      user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ADMIN' }) },
    });
    const capability = await createUserKnowledgeRepositoryCapability(
      db,
      'admin-1',
      vi.fn().mockResolvedValue(false)
    );
    await expect(listReadableKnowledge(db, 'admin-1', capability)).resolves.toEqual([]);
    expect(guardedFindMany).toHaveBeenCalledOnce();
  });

  it('retains a current recipient team grant after its member is elevated to platform ADMIN', async () => {
    const observedGrants: unknown[] = [];
    for (const role of ['ENGINEER', 'ADMIN'] as const) {
      const knowledgeItem = {
        findFirst: vi.fn(async (args: { where: { AND: unknown[] } }) => {
          const readable = args.where.AND[0] as { OR: Array<Record<string, unknown>> };
          observedGrants.push(readable.OR.find((branch) => branch.visibility === 'SELECTED_TEAMS'));
          return null;
        }),
        findMany: vi.fn().mockResolvedValue([]),
      };
      const { db } = readScopeDb({
        knowledgeItem,
        teamMembership: { findMany: vi.fn().mockResolvedValue([{ teamId: recipientId }]) },
        user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role }) },
      });
      const capability = await createUserKnowledgeRepositoryCapability(db, 'user-1', vi.fn());
      await expect(
        getReadableKnowledgeItem(db, 'user-1', 'selected-item', capability)
      ).resolves.toBe(null);
    }
    const expectedGrant = {
      grants: { some: { teamId: { in: [recipientId] } } },
      status: 'APPROVED',
      visibility: 'SELECTED_TEAMS',
    };
    expect(observedGrants).toEqual([expectedGrant, expectedGrant]);
  });

  it('does not disclose current versus stale state for any repository lifecycle action without source capability', async () => {
    const attempts = [
      (db: PrismaClient, version: number) =>
        approveKnowledgeItem(db, 'user-1', 'item-1', {
          expectedVersion: version,
          selectedTeamIds: [],
          visibility: 'TEAM',
        }),
      (db: PrismaClient, version: number) =>
        publishApprovedKnowledgeItem(db, 'user-1', 'item-1', {
          expectedVersion: version,
          selectedTeamIds: [],
          visibility: 'TEAM',
        }),
      (db: PrismaClient, version: number) =>
        reviseKnowledgeItem(db, 'user-1', 'item-1', {
          content: 'Revised content is long enough for a valid knowledge item.',
          expectedVersion: version,
          title: 'Revised title',
        }),
      (db: PrismaClient, version: number) => rejectKnowledgeItem(db, 'user-1', 'item-1', version),
      (db: PrismaClient, version: number) =>
        supersedeKnowledgeItem(db, 'user-1', 'item-1', version),
    ];
    for (const action of attempts) {
      const outcomes = [];
      for (const version of [3, 4]) {
        const { db } = database({
          knowledgeItem: {
            findUnique: vi.fn().mockResolvedValue({
              orgId: 'org-1',
              ownerTeamId: teamId,
              repoId,
              status: 'APPROVED',
              version: 4,
            }),
          },
        });
        try {
          await action(db, version);
          outcomes.push('success');
        } catch (error) {
          outcomes.push(error instanceof Error ? error.constructor : error);
        }
      }
      expect(outcomes[0]).toBe(KnowledgeAccessError);
      expect(outcomes[1]).toBe(KnowledgeAccessError);
      const missing = database({
        knowledgeItem: { findUnique: vi.fn().mockResolvedValue(null) },
      }).db;
      await expect(action(missing, 4)).rejects.toBeInstanceOf(KnowledgeAccessError);
    }
  });

  it('rejects stale approval versions without writing', async () => {
    const { db, tx } = database({
      knowledgeItem: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          ownerTeamId: teamId,
          repoId: null,
          status: 'UNREVIEWED',
          version: 4,
        }),
        updateMany: vi.fn(),
      },
    });
    await expect(
      approveKnowledgeItem(db, 'user-1', 'item-1', selectedApproval)
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    expect(tx.knowledgeItem.updateMany).not.toHaveBeenCalled();
  });

  it('rejects cross-organization selected teams even for platform admins', async () => {
    const { db, tx } = database({
      team: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(activeTeam()),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ADMIN' }) },
    });
    await expect(
      approveKnowledgeItem(db, 'admin-1', 'item-1', selectedApproval)
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    expect(tx.knowledgeItem.updateMany).not.toHaveBeenCalled();
  });

  it('CAS-protects a concurrent publication and increments the approval token', async () => {
    const { db, tx } = database({
      knowledgeItem: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          ownerTeamId: teamId,
          repoId: null,
          status: 'APPROVED',
          version: 4,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    await expect(
      publishApprovedKnowledgeItem(db, 'user-1', 'item-1', {
        expectedVersion: 4,
        selectedTeamIds: [recipientId],
        visibility: 'SELECTED_TEAMS',
      })
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-1', ownerTeamId: teamId, status: 'APPROVED', version: 4 },
      })
    );
  });

  it('invalidates approval and embedding freshness when text is revised', async () => {
    const { db, tx } = database({
      knowledgeItem: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          ownerTeamId: teamId,
          repoId: null,
          status: 'APPROVED',
          version: 3,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    await expect(
      reviseKnowledgeItem(db, 'user-1', 'item-1', {
        content: 'A revised statement with enough meaningful detail for review.',
        expectedVersion: 3,
        title: 'A revised title',
      })
    ).resolves.toEqual({ id: 'item-1', status: 'UNREVIEWED', version: 4 });
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvedVersion: null,
          embeddingDigest: null,
          status: 'UNREVIEWED',
          version: 4,
        }),
      })
    );
  });

  it('allows curated POLICY creation only by a human team lead and keeps it unreviewed/local', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'item-policy', version: 1 });
    const db = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
      knowledgeItem: { create },
      organizationMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'ORG_MEMBER' }) },
      team: { findUnique: vi.fn().mockResolvedValue(activeTeam()) },
      teamMembership: { findUnique: vi.fn().mockResolvedValue({ role: 'LEAD' }) },
      user: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER' }) },
    } as unknown as PrismaClient;
    await createCuratedKnowledgeItem(db, 'user-1', {
      content: 'This policy is authored by a team lead and requires review before use.',
      teamId,
      title: 'A human-authored policy',
      type: 'POLICY',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UNREVIEWED',
          type: 'POLICY',
          visibility: 'REPOSITORY',
        }),
      })
    );
  });

  it('requires an actor- and gate-bound repository capability for reads', async () => {
    const { db } = readScopeDb();
    const authorize = vi.fn().mockResolvedValue(false);
    const capability = await createUserKnowledgeRepositoryCapability(db, 'user-1', authorize);
    await expect(listReadableKnowledge(db, 'different-user', capability)).rejects.toBeInstanceOf(
      KnowledgeAccessError
    );
    await expect(listReadableKnowledge(db, 'user-1', undefined as never)).rejects.toBeInstanceOf(
      KnowledgeAccessError
    );
    await listReadableKnowledge(db, 'user-1', capability);
    const readWhere = JSON.stringify(
      (
        db as unknown as { knowledgeItem: { findMany: ReturnType<typeof vi.fn> } }
      ).knowledgeItem.findMany.mock.calls.at(-1)?.[0].where
    );
    expect(readWhere).not.toContain(`"in":["${repoId}"]`);
    expect(authorize).toHaveBeenCalledWith(repoId, {
      isPlatformAdmin: false,
      kind: 'user',
      userId: 'user-1',
    });
  });

  it('redacts repository provenance in manager DTOs unless the source gate capability allows it', async () => {
    const row = {
      content: 'Reviewed local summary',
      contentDigest: 'digest',
      createdAt: new Date(0),
      evidence: [{ kind: 'artifact', reference: 'private-source-ref' }],
      id: 'item-1',
      modelSpec: 'provider/model',
      originTeamId: teamId,
      ownerTeamId: teamId,
      producerAgentKey: 'implementer',
      producerNodeId: 'node-1',
      producerRunId: 'run-private',
      repoId,
      status: 'UNREVIEWED',
      title: 'Summary',
      type: 'LEARNING',
      version: 1,
      visibility: 'REPOSITORY',
    };
    const { db } = readScopeDb({
      knowledgeItem: { findMany: vi.fn().mockResolvedValue([row]) },
      organization: { findMany: vi.fn().mockResolvedValue([]) },
      team: { findMany: vi.fn().mockResolvedValue([{ id: teamId }]) },
    });
    const capability = await createUserKnowledgeRepositoryCapability(
      db,
      'user-1',
      vi.fn().mockResolvedValue(false)
    );
    const items = await listManagedKnowledge(db, 'user-1', capability);
    expect(items[0].provenance).toBeNull();
    expect(items[0].trustLabel).toBe('UNREVIEWED_LOCAL_LEARNING');
    expect(items[0]).not.toHaveProperty('repoId');
  });

  it('queries authorized readable detail with the same intersected capability and eligibility predicate', async () => {
    const row = {
      content: 'Approved content',
      createdAt: new Date(0),
      id: 'item-1',
      status: 'APPROVED',
      title: 'Title',
      type: 'REFERENCE',
      version: 2,
      visibility: 'TEAM',
    };
    const { db } = readScopeDb({
      knowledgeItem: { findFirst: vi.fn().mockResolvedValue(row) },
    });
    const capability = await createUserKnowledgeRepositoryCapability(
      db,
      'user-1',
      vi.fn().mockResolvedValue(false)
    );
    await expect(
      getReadableKnowledgeItem(db, 'user-1', 'item-1', capability)
    ).resolves.toMatchObject({ id: 'item-1' });
    expect(
      (db as unknown as { knowledgeItem: { findFirst: ReturnType<typeof vi.fn> } }).knowledgeItem
        .findFirst.mock.calls[0][0].where
    ).toHaveProperty('AND');
  });

  it('allows an active platform ADMIN through the real bounded workflow capability factory only when the gate approves', async () => {
    const { db, raw } = workflowDb();
    raw.user.findUnique.mockResolvedValue({ isActive: true, role: 'ADMIN' });
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const allowed = await createWorkflowKnowledgeRepositoryCapability(
      db,
      principal,
      vi.fn().mockResolvedValue(true)
    );
    const where = await getKnowledgeWorkflowEligibilityWhere(principal, allowed);
    expect(JSON.stringify(where)).toContain(repoId);

    const denied = await createWorkflowKnowledgeRepositoryCapability(
      db,
      principal,
      vi.fn().mockResolvedValue(false)
    );
    const deniedWhere = await getKnowledgeWorkflowEligibilityWhere(principal, denied);
    expect(JSON.stringify(deniedWhere)).toBe(JSON.stringify({ id: { in: [] } }));
    await expect(
      getKnowledgeWorkflowEligibilityWhere(principal, undefined as never)
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
  });

  it('removes team visibility after the launcher is removed from the saved source team', async () => {
    const { db, raw } = workflowDb();
    raw.teamMembership.findUnique.mockResolvedValue(null);
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    expect(principal.launcherHasTeamMembership).toBe(false);
    const capability = await createWorkflowKnowledgeRepositoryCapability(
      db,
      principal,
      vi.fn().mockResolvedValue(true)
    );
    await expect(getKnowledgeWorkflowEligibilityWhere(principal, capability)).resolves.toEqual({
      id: { in: [] },
    });
  });

  it('removes organization visibility after the launcher leaves the saved source organization', async () => {
    const { db, raw } = workflowDb();
    raw.organizationMembership.findUnique.mockResolvedValue(null);
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    expect(principal.launcherHasOrgMembership).toBe(false);
    const capability = await createWorkflowKnowledgeRepositoryCapability(
      db,
      principal,
      vi.fn().mockResolvedValue(true)
    );
    await expect(getKnowledgeWorkflowEligibilityWhere(principal, capability)).resolves.toEqual({
      id: { in: [] },
    });
  });

  it('issues no repository capability for a saved repository source whose run has no launcher', async () => {
    const { db, raw, run } = workflowDb();
    // A child run persisted its REPOSITORY source but carries no launcher (an
    // older row, or an execution that recorded none). The saved source alone
    // must not be usable as knowledge authority.
    raw.workflowRun.findFirst.mockResolvedValueOnce({ ...run, launchedById: null });
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    expect(principal.repoId).toBe(repoId);
    const gate = vi.fn().mockResolvedValue(true);
    const capability = await createWorkflowKnowledgeRepositoryCapability(db, principal, gate);
    expect(gate).not.toHaveBeenCalled();
    await expect(getKnowledgeWorkflowEligibilityWhere(principal, capability)).resolves.toEqual({
      id: { in: [] },
    });
  });

  it('provides a trusted eligibility predicate not limited to recent rows', async () => {
    const { db } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const capability = await createWorkflowKnowledgeRepositoryCapability(
      db,
      principal,
      vi.fn().mockResolvedValue(true)
    );
    const predicate = await getKnowledgeWorkflowEligibilityWhere(principal, capability);
    expect(JSON.stringify(predicate)).toContain('APPROVED');
    expect(JSON.stringify(predicate)).toContain(repoId);
    expect(JSON.stringify(predicate)).toContain(teamId);
  });

  it('rejects deleted, reassigned, or inactive repository sources instead of downgrading them', async () => {
    const { db, raw } = workflowDb();
    raw.connection.findFirst.mockResolvedValueOnce(null);
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 'temporal-1', workflowId: 'run-1' })
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    raw.connection.findFirst.mockResolvedValueOnce({
      id: repoId,
      team: { isActive: true, organization: { isActive: true }, orgId: 'org-1' },
      teamId: 'other-team',
    });
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 'temporal-1', workflowId: 'run-1' })
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    raw.connection.findFirst.mockResolvedValueOnce({
      id: repoId,
      team: { isActive: true, organization: { isActive: true }, orgId: 'other-org' },
      teamId,
    });
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 'temporal-1', workflowId: 'run-1' })
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
    raw.connection.findFirst.mockResolvedValueOnce({
      id: repoId,
      team: { isActive: false, organization: { isActive: true }, orgId: 'org-1' },
      teamId,
    });
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 'temporal-1', workflowId: 'run-1' })
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
  });

  it('accepts a verified repo-less team source and rejects legacy unknown identity', async () => {
    const { db, raw, run } = workflowDb();
    const teamRun = {
      ...run,
      channel: null,
      connection: null,
      knowledgeSourceKind: 'TEAM',
      knowledgeSourceOrgId: 'org-1',
      knowledgeSourceRepoId: null,
      knowledgeSourceTeamId: teamId,
      workRequest: { connection: null },
    };
    raw.workflowRun.findFirst.mockResolvedValueOnce(teamRun);
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'team-run',
    });
    expect(principal).toMatchObject({ orgId: 'org-1', repoId: null, teamId });

    raw.workflowRun.findFirst.mockResolvedValueOnce({
      ...teamRun,
      knowledgeSourceKind: null,
      knowledgeSourceOrgId: null,
      knowledgeSourceRepoId: null,
      knowledgeSourceTeamId: null,
    });
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 'temporal-1', workflowId: 'legacy' })
    ).rejects.toThrow('missing or unknown');
  });

  it('removes repo-less TEAM visibility after the launcher leaves the saved source team', async () => {
    const { db, raw, run } = workflowDb();
    raw.workflowRun.findFirst.mockResolvedValueOnce({
      ...run,
      channel: null,
      connection: null,
      knowledgeSourceKind: 'TEAM',
      knowledgeSourceOrgId: 'org-1',
      knowledgeSourceRepoId: null,
      knowledgeSourceTeamId: teamId,
      workRequest: { connection: null },
    });
    raw.teamMembership.findUnique.mockResolvedValue(null);
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'team-run-revoked',
    });
    const capability = await createWorkflowKnowledgeRepositoryCapability(db, principal, vi.fn());
    const where = await getKnowledgeWorkflowEligibilityWhere(principal, capability);
    expect(JSON.stringify(where)).not.toContain(teamId);
    expect(JSON.stringify(where)).toContain('org-1');
  });

  it('rejects private-channel workflows instead of widening channel privacy', async () => {
    const { db, raw } = workflowDb();
    raw.workflowRun.findFirst.mockResolvedValueOnce({
      channel: { isPrivate: true, orgId: 'org-1', teamId },
      connection: null,
      launchedById: null,
      template: null,
      workRequest: null,
    });
    await expect(
      resolveKnowledgeWorkflowPrincipal(db, { temporalRunId: 't', workflowId: 'r' })
    ).rejects.toBeInstanceOf(KnowledgeAccessError);
  });

  it('uses shared-repository membership in the gated capability candidate query', async () => {
    const { db, connectionFindMany } = readScopeDb();
    const authorize = vi.fn().mockResolvedValue(true);
    await createUserKnowledgeRepositoryCapability(db, 'user-1', authorize);
    const repoWhere = connectionFindMany.mock.calls[0][0].where;
    expect(repoWhere.OR[1]).toHaveProperty('shares.some.team.memberships.some');
  });

  it('binds workflow repository access to the exact running Temporal execution and launcher', async () => {
    const { db, raw } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const gate = vi.fn().mockResolvedValue(true);
    const capability = await createWorkflowKnowledgeRepositoryCapability(db, principal, gate);
    await listKnowledgeForWorkflow(db, principal, capability);
    expect(raw.workflowRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'RUNNING', temporalRunId: 'temporal-1', workflowId: 'eng-slug' },
      })
    );
    expect(gate).toHaveBeenCalledWith(repoId, {
      kind: 'workflow',
      launchedById: 'user-1',
      runId: 'db-run-uuid',
      temporalRunId: 'temporal-1',
    });
  });

  it('revalidates the same evidence on idempotent retry and rejects deleted or changed provenance', async () => {
    const { db } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const payload = {
      content: 'This learning has enough concrete detail to be safely reused.',
      evidence: [{ kind: 'test', reference: 'artifact-1' }],
      idempotencyKey: 'retry-key-123',
      nodeId: 'node-1',
      title: 'A useful learning',
    };
    const existing = {
      contentDigest: createHash('sha256')
        .update(payload.title)
        .update('\\0')
        .update(payload.content)
        .digest('hex'),
      evidence: payload.evidence,
      id: 'winner',
      modelSpec: null,
      producerAgentKey: null,
      producerNodeId: 'node-1',
      version: 1,
    };
    const resolver = vi.fn().mockRejectedValue(new KnowledgeAccessError('deleted artifact'));
    const existingDb = {
      ...db,
      knowledgeItem: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(existing) },
    } as unknown as PrismaClient;
    await expect(
      submitKnowledgeLearning(existingDb, principal, payload, resolver, {
        recordingId: 'node-1',
        specNodeId: 'node-1',
        stepAttempt: 1,
      })
    ).rejects.toThrow('deleted artifact');
    expect(existingDb.knowledgeItem.create).not.toHaveBeenCalled();

    resolver.mockResolvedValue({
      evidence: [{ kind: 'test', reference: 'different-artifact' }],
      modelSpec: null,
      nodeId: 'node-1',
      producerAgentKey: null,
    });
    await expect(
      submitKnowledgeLearning(existingDb, principal, payload, resolver, {
        recordingId: 'node-1',
        specNodeId: 'node-1',
        stepAttempt: 1,
      })
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
  });

  it('persists the trusted current producer node rather than a gate evidence node', async () => {
    const { db } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const create = vi.fn().mockResolvedValue({ id: 'created', version: 1 });
    const tx = {
      ...db,
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'db-run-uuid' }]),
      knowledgeItem: { create },
    };
    const writeDb = {
      ...db,
      $transaction: vi.fn((fn: (client: unknown) => unknown) => fn(tx)),
      knowledgeItem: { create, findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const resolver = vi.fn().mockResolvedValue({
      evidence: [{ kind: 'test', reference: 'artifact-tests' }],
      modelSpec: null,
      nodeId: 'capture',
      producerAgentKey: null,
    });
    await expect(
      submitKnowledgeLearning(
        writeDb,
        principal,
        {
          content: 'This learning has enough concrete detail to be safely reused.',
          evidence: [{ kind: 'test', reference: 'artifact-tests' }],
          idempotencyKey: 'capture-key-123',
          nodeId: 'capture',
          title: 'A useful learning',
        },
        resolver,
        { recordingId: 'fan[1]/capture', specNodeId: 'capture', stepAttempt: 2 }
      )
    ).resolves.toMatchObject({ created: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ producerAgentKey: null, producerNodeId: 'capture' }),
      })
    );
  });

  it('locks and rechecks the exact running workflow execution inside the insertion transaction', async () => {
    const { db } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const create = vi.fn();
    const tx = {
      ...db,
      $queryRaw: vi.fn().mockResolvedValue([]),
      knowledgeItem: { create },
    };
    const racedDb = {
      ...db,
      $transaction: vi.fn((fn: (client: unknown) => unknown) => fn(tx)),
      knowledgeItem: { create, findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const resolver = vi.fn().mockResolvedValue({
      evidence: [{ kind: 'test', reference: 'artifact-1' }],
      modelSpec: null,
      nodeId: 'node-1',
      producerAgentKey: null,
    });
    await expect(
      submitKnowledgeLearning(
        racedDb,
        principal,
        {
          content: 'This learning has enough concrete detail to be safely reused.',
          evidence: [{ kind: 'test', reference: 'artifact-1' }],
          idempotencyKey: 'new-key-123',
          nodeId: 'node-1',
          title: 'A useful learning',
        },
        resolver,
        { recordingId: 'node-1', specNodeId: 'node-1', stepAttempt: 1 }
      )
    ).rejects.toThrow('no longer running');
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.arrayContaining(['db-run-uuid', 'temporal-1']),
      })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('recovers a concurrent idempotency-key conflict only for the identical content digest', async () => {
    const { db } = workflowDb();
    const principal = await resolveKnowledgeWorkflowPrincipal(db, {
      temporalRunId: 'temporal-1',
      workflowId: 'eng-slug',
    });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const payload = {
      content: 'This learning has enough concrete detail to be safely reused.',
      evidence: [{ kind: 'test', reference: 'run:run-1/node:node-1' }],
      idempotencyKey: 'retry-key-123',
      nodeId: 'node-1',
      title: 'A useful learning',
    };
    const digest = createHash('sha256')
      .update(payload.title)
      .update('\0')
      .update(payload.content)
      .digest('hex');
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      contentDigest: digest,
      evidence: payload.evidence,
      id: 'winner',
      modelSpec: 'provider/model',
      producerAgentKey: 'implementer',
      producerNodeId: 'node-1',
      version: 1,
    });
    const resolver = vi.fn().mockResolvedValue({
      evidence: [{ kind: 'test', reference: 'run:run-1/node:node-1' }],
      modelSpec: 'provider/model',
      nodeId: 'node-1',
      producerAgentKey: 'implementer',
    });
    const sourceLock = vi.fn().mockResolvedValue([{ id: 'db-run-uuid' }]);
    const collisionDb = {
      ...db,
      $transaction: vi.fn((fn: (tx: unknown) => unknown) =>
        fn({ ...db, $queryRaw: sourceLock, knowledgeItem: { create, findFirst } })
      ),
      knowledgeItem: { create, findFirst },
    } as unknown as PrismaClient;
    await expect(
      submitKnowledgeLearning(collisionDb, principal, payload, resolver, {
        recordingId: 'node-1',
        specNodeId: 'node-1',
        stepAttempt: 1,
      })
    ).resolves.toEqual({ created: false, id: 'winner', version: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sourceLock).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledWith(payload.evidence, {
      requestedNodeId: 'node-1',
      runId: 'db-run-uuid',
    });
  });
});
