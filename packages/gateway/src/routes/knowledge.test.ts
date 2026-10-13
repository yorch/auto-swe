import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  approveKnowledgeItem: vi.fn(async (_db, actor, id, input) => ({ actor, id, input })),
  createCuratedKnowledgeItem: vi.fn(async (_db, actor, input) => ({ actor, id: 'new-id', input })),
  createUserKnowledgeRepositoryCapability: vi.fn(
    async (
      _db: unknown,
      _userId: string,
      _authorizeRepository: (
        repoId: string,
        actor: { kind: 'user'; userId: string; isPlatformAdmin: boolean }
      ) => Promise<boolean>
    ) => ({ opaque: true })
  ),
  getManagedKnowledgeItem: vi.fn(async () => null),
  getReadableKnowledgeItem: vi.fn(async () => null),
  listManagedKnowledge: vi.fn(async () => []),
  listReadableKnowledge: vi.fn(async () => []),
  publishApprovedKnowledgeItem: vi.fn(async (_db, actor, id, input) => ({ actor, id, input })),
  rejectKnowledgeItem: vi.fn(async (_db, actor, id, version) => ({ actor, id, version })),
  reviseKnowledgeItem: vi.fn(async (_db, actor, id, input) => ({ actor, id, input })),
  supersedeKnowledgeItem: vi.fn(async (_db, actor, id, version) => ({ actor, id, version })),
}));
vi.mock('@auto-swe/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared')>()),
  ...mocked,
}));
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => ({ mode: 'off', staleAfterHours: 72 })),
}));

import { KnowledgeAccessError, KnowledgeVersionConflictError } from '@auto-swe/shared';
import { knowledgeRoutes } from './knowledge.js';

const ACTOR = 'actor-user';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const TEAM = 'cccccccc-1111-4111-8111-cccccccccccc';
const input = {
  content: 'A sufficiently substantive governed knowledge item.',
  teamId: TEAM,
  title: 'A useful item',
  type: 'REFERENCE',
};

describe('knowledge routes', () => {
  let app: FastifyInstance;
  let repoAllowed: boolean;
  let actorRole: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoAllowed = true;
    actorRole = 'LEAD';
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: async () => ({ exp: 9999999999, iat: 0, role: actorRole, sub: ACTOR }),
    } as never);
    app.decorate('prisma', {
      connection: { findFirst: async () => (repoAllowed ? { id: REPO } : null) },
      organizationMembership: { findFirst: async () => null },
      teamMembership: { findFirst: async () => ({ role: 'LEAD' }) },
      user: { findUniqueOrThrow: async () => ({ role: actorRole }) },
    } as never);
    app.register(knowledgeRoutes, { prefix: '/api/v1/knowledge' });
    await app.ready();
  });
  afterEach(async () => app.close());
  const send = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer test' },
      method,
      url,
      ...(payload ? { payload } : {}),
    });

  it('creates source-gated curated repo knowledge with authenticated actor and server capability', async () => {
    const response = await send('POST', '/api/v1/knowledge', { ...input, repoId: REPO });
    expect(response.statusCode).toBe(201);
    expect(mocked.createUserKnowledgeRepositoryCapability).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR,
      expect.any(Function)
    );
    expect(mocked.createCuratedKnowledgeItem).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR,
      { ...input, repoId: REPO },
      { opaque: true }
    );
  });

  it('rejects invalid bodies at the route boundary and does not call service', async () => {
    const response = await send('POST', '/api/v1/knowledge', {
      ...input,
      teamId: 'attacker-tenant',
    });
    expect(response.statusCode).toBe(400);
    expect(mocked.createCuratedKnowledgeItem).not.toHaveBeenCalled();
  });

  it('passes actor-bound capability and expected version to every lifecycle mutation', async () => {
    for (const [action, body, spy] of [
      [
        'approve',
        { expectedVersion: 1, selectedTeamIds: [], visibility: 'TEAM' },
        mocked.approveKnowledgeItem,
      ],
      [
        'publish',
        { expectedVersion: 2, selectedTeamIds: [], visibility: 'ORGANIZATION' },
        mocked.publishApprovedKnowledgeItem,
      ],
      ['reject', { expectedVersion: 1 }, mocked.rejectKnowledgeItem],
      ['supersede', { expectedVersion: 2 }, mocked.supersedeKnowledgeItem],
    ] as const) {
      const response = await send('POST', `/api/v1/knowledge/${ITEM}/${action}`, body);
      expect(response.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(expect.anything(), ACTOR, ITEM, expect.anything(), {
        opaque: true,
      });
    }
    const revised = await send('PUT', `/api/v1/knowledge/${ITEM}`, {
      content: 'A sufficiently substantive revised knowledge item.',
      expectedVersion: 3,
      title: 'Revised item',
    });
    expect(revised.statusCode).toBe(200);
    expect(mocked.reviseKnowledgeItem).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR,
      ITEM,
      expect.objectContaining({ expectedVersion: 3 }),
      { opaque: true }
    );
  });

  it('maps forbidden guessed IDs and stale versions to non-leaking 403/409 responses', async () => {
    mocked.getManagedKnowledgeItem.mockRejectedValueOnce(new KnowledgeAccessError());
    const hidden = await send('GET', `/api/v1/knowledge/${ITEM}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('NOT_FOUND');

    mocked.approveKnowledgeItem.mockRejectedValueOnce(new KnowledgeAccessError());
    const roleDenied = await send('POST', `/api/v1/knowledge/${ITEM}/approve`, {
      expectedVersion: 1,
      selectedTeamIds: [],
      visibility: 'TEAM',
    });
    expect(roleDenied.statusCode).toBe(403);
    expect(roleDenied.json().error.message).toBe('Knowledge access denied');

    mocked.approveKnowledgeItem.mockRejectedValueOnce(new KnowledgeVersionConflictError());
    const stale = await send('POST', `/api/v1/knowledge/${ITEM}/approve`, {
      expectedVersion: 1,
      selectedTeamIds: [],
      visibility: 'TEAM',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('serves ordinary users only the safe approved/local projection', async () => {
    mocked.listReadableKnowledge.mockResolvedValueOnce([
      {
        content: 'approved safe text',
        createdAt: new Date(),
        id: ITEM,
        status: 'APPROVED',
        title: 'Visible summary',
        trustLabel: 'APPROVED_REVIEWED_VERSION',
        type: 'REFERENCE',
        version: 2,
        visibility: 'ORGANIZATION',
      },
    ] as never);
    const response = await send('GET', '/api/v1/knowledge');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].provenance).toBeUndefined();
    expect(mocked.listReadableKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR,
      { opaque: true },
      100
    );
  });

  it('allows ordinary approved detail reads without manager provenance', async () => {
    mocked.getManagedKnowledgeItem.mockRejectedValueOnce(new KnowledgeAccessError());
    mocked.getReadableKnowledgeItem.mockResolvedValueOnce({
      content: 'approved text',
      createdAt: new Date(),
      id: ITEM,
      status: 'APPROVED',
      title: 'Approved',
      trustLabel: 'APPROVED_REVIEWED_VERSION',
      type: 'REFERENCE',
      version: 1,
      visibility: 'ORGANIZATION',
    } as never);
    const response = await send('GET', `/api/v1/knowledge/${ITEM}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.provenance).toBeNull();
  });

  it('returns role-aware permission DTOs without treating team leadership as org publication authority', async () => {
    const response = await send(
      'GET',
      `/api/v1/knowledge/permissions?teamId=${TEAM}&orgId=${TEAM}`
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      canCreateCurated: true,
      canManageTeam: true,
      canPublishOrganization: false,
      canPublishSelectedTeams: true,
      repoOriginActionsRequireSourceAccess: true,
    });
  });

  it('passes the existing gated repository visibility predicate to capability minting', async () => {
    repoAllowed = false;
    const response = await send('POST', '/api/v1/knowledge', { ...input, repoId: REPO });
    expect(response.statusCode).toBe(201);
    const gate = mocked.createUserKnowledgeRepositoryCapability.mock.calls[0]?.[2];
    expect(gate).toBeTypeOf('function');
    await expect(
      gate?.(REPO, { isPlatformAdmin: false, kind: 'user', userId: ACTOR })
    ).resolves.toBe(false);
  });

  it('does not use a cached request ADMIN role to bypass the gate after database demotion', async () => {
    actorRole = 'ADMIN';
    repoAllowed = false;
    const response = await send('GET', '/api/v1/knowledge/search?q=record');
    expect(response.statusCode).toBe(200);
    const gate = mocked.createUserKnowledgeRepositoryCapability.mock.calls[0]?.[2];
    expect(gate).toBeTypeOf('function');
    await expect(
      gate?.(REPO, { isPlatformAdmin: false, kind: 'user', userId: ACTOR })
    ).resolves.toBe(false);
    expect(mocked.listReadableKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR,
      { opaque: true },
      100
    );
  });

  it('keeps the explicit repository-gate bypass when the current database role is ADMIN', async () => {
    actorRole = 'ENGINEER';
    repoAllowed = false;
    const response = await send('POST', '/api/v1/knowledge', { ...input, repoId: REPO });
    expect(response.statusCode).toBe(201);
    const gate = mocked.createUserKnowledgeRepositoryCapability.mock.calls[0]?.[2];
    expect(gate).toBeTypeOf('function');
    await expect(
      gate?.(REPO, { isPlatformAdmin: true, kind: 'user', userId: ACTOR })
    ).resolves.toBe(true);
  });

  it('separates all-readable summaries from the manager review queue', async () => {
    const readable = [
      {
        content: 'own review item',
        createdAt: new Date(),
        id: ITEM,
        status: 'UNREVIEWED',
        title: 'Review',
        trustLabel: 'UNREVIEWED_LOCAL',
        type: 'REFERENCE',
        version: 1,
        visibility: 'TEAM',
      },
      {
        content: 'other team published',
        createdAt: new Date(),
        id: 'dddddddd-1111-4111-8111-dddddddddddd',
        status: 'APPROVED',
        title: 'Shared summary',
        trustLabel: 'APPROVED_REVIEWED_VERSION',
        type: 'DECISION',
        version: 2,
        visibility: 'ORGANIZATION',
      },
    ];
    mocked.listReadableKnowledge.mockResolvedValueOnce(readable as never);
    const read = await send('GET', '/api/v1/knowledge?view=read');
    expect(read.statusCode).toBe(200);
    expect(read.json().data.map((item: { id: string }) => item.id)).toEqual([ITEM, readable[1].id]);
    expect(mocked.listManagedKnowledge).not.toHaveBeenCalled();

    mocked.listManagedKnowledge.mockResolvedValueOnce([readable[0]] as never);
    const review = await send('GET', '/api/v1/knowledge?view=review');
    expect(review.statusCode).toBe(200);
    expect(review.json().data).toHaveLength(1);
    expect(mocked.listManagedKnowledge).toHaveBeenCalled();
  });

  it('returns safe bounded text search rather than claiming semantic ranking', async () => {
    mocked.listReadableKnowledge.mockResolvedValueOnce([
      {
        content: 'text body',
        createdAt: new Date(),
        id: ITEM,
        status: 'APPROVED',
        title: 'Find me',
        trustLabel: 'APPROVED_REVIEWED_VERSION',
        type: 'REFERENCE',
        version: 1,
        visibility: 'TEAM',
      },
    ] as never);
    const response = await send('GET', '/api/v1/knowledge/search?q=find&limit=1');
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.searchMode).toBe('text');
    expect(response.json().data).toHaveLength(1);
  });
});
