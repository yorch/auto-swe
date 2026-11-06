import { isUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared', () => ({
  Role: { ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' },
}));
vi.mock('./repositories.js', () => ({ canManageTeamRepos: vi.fn() }));

import { knowledgeBaseRoutes } from './knowledgeBases.js';
import { canManageTeamRepos } from './repositories.js';

const KB = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const TEMPLATE = '55555555-5555-4555-8555-555555555555';
const AUTH = { authorization: 'Bearer fake' };
const row = {
  connection: { teamId: TEAM },
  connectionId: REPO,
  id: KB,
  mountName: 'docs',
  name: 'Docs',
  orgId: ORG,
  shares: [],
  snapshots: [],
  status: 'OK',
  visibility: 'TEAM',
};
const delegate = () => ({
  create: vi.fn(),
  createMany: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn().mockResolvedValue([]),
  findUnique: vi.fn(),
  update: vi.fn(),
});
const prisma = {
  $transaction: vi.fn(),
  configAuditLog: delegate(),
  connection: delegate(),
  knowledgeBase: delegate(),
  knowledgeBaseLink: delegate(),
  knowledgeBaseTeamShare: delegate(),
  team: delegate(),
  workflowTemplate: delegate(),
};
const temporal = { startKnowledgeBaseIndex: vi.fn() };
let app: ReturnType<typeof Fastify>;
let role = 'LEAD';

beforeEach(async () => {
  role = 'LEAD';
  vi.resetAllMocks();
  for (const value of Object.values(prisma)) {
    if (typeof value === 'object') {
      value.findMany.mockResolvedValue([]);
    }
  }
  vi.mocked(canManageTeamRepos).mockResolvedValue(true);
  prisma.knowledgeBase.findFirst.mockResolvedValue(row);
  prisma.knowledgeBase.create.mockResolvedValue(row);
  prisma.knowledgeBase.update.mockResolvedValue(row);
  prisma.connection.findUnique.mockResolvedValue({
    id: REPO,
    team: { orgId: ORG },
    teamId: TEAM,
    type: 'git_repo',
  });
  prisma.team.findUnique.mockResolvedValue({ id: TEAM, orgId: ORG });
  prisma.workflowTemplate.findUnique.mockResolvedValue({ id: TEMPLATE, teamId: TEAM });
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  app.decorate('temporal', temporal as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user' }),
  } as never);
  await app.register(knowledgeBaseRoutes, { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const create = { connectionId: REPO, mountName: 'docs', name: 'Docs' };
describe('knowledge base routes', () => {
  it('marks only the platform admin listing as intentionally cross-tenant', async () => {
    role = 'ADMIN';
    prisma.knowledgeBase.findMany.mockImplementation(async () => {
      expect(isUnscoped('KnowledgeBase')).toBe(true);
      expect(isUnscoped('Connection')).toBe(false);
      return [];
    });
    expect(
      (await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/knowledge-bases' }))
        .statusCode
    ).toBe(200);
    expect(isUnscoped('KnowledgeBase')).toBe(false);
  });
  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/knowledge-bases' })).statusCode).toBe(
      401
    );
  });
  it('lists visible bases with an explicit organization predicate', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/knowledge-bases',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
    expect(prisma.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization: { memberships: { some: { userId: 'user' } } },
        }),
      })
    );
  });
  it('creates a git-backed base under its connection organization and audits it', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: create,
      url: '/api/v1/knowledge-bases',
    });
    expect(response.statusCode).toBe(201);
    expect(prisma.knowledgeBase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdById: 'user',
        orgId: ORG,
        path: '',
        visibility: 'TEAM',
      }),
    });
    expect(prisma.configAuditLog.create).toHaveBeenCalled();
  });
  it('refuses creation by non-leads', async () => {
    vi.mocked(canManageTeamRepos).mockResolvedValue(false);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: create,
          url: '/api/v1/knowledge-bases',
        })
      ).statusCode
    ).toBe(403);
    expect(prisma.knowledgeBase.create).not.toHaveBeenCalled();
  });
  it('refuses non-git connections', async () => {
    prisma.connection.findUnique.mockResolvedValue({ type: 'mcp' });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: create,
          url: '/api/v1/knowledge-bases',
        })
      ).statusCode
    ).toBe(400);
  });
  it.each([{ path: '../secret' }, { mountName: '..' }, { defaultRef: '--upload-pack=evil' }])(
    'validates path, mounts and refs: %j',
    async (invalid) => {
      expect(
        (
          await app.inject({
            headers: AUTH,
            method: 'POST',
            payload: { ...create, ...invalid },
            url: '/api/v1/knowledge-bases',
          })
        ).statusCode
      ).toBe(400);
    }
  );
  it('reads snapshot status without exposing connection credentials', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/knowledge-bases/${KB}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.snapshots).toEqual([]);
    expect(prisma.knowledgeBase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          connection: { select: { teamId: true } },
          snapshots: expect.objectContaining({ take: 10 }),
        }),
      })
    );
  });
  it('hides unavailable bases', async () => {
    prisma.knowledgeBase.findFirst.mockResolvedValue(null);
    expect(
      (await app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/knowledge-bases/${KB}` }))
        .statusCode
    ).toBe(404);
  });
  it.each(['PATCH', 'DELETE', 'PUT', 'POST'] as const)(
    'gates owner mutations: %s',
    async (method) => {
      vi.mocked(canManageTeamRepos).mockResolvedValue(false);
      const suffix = method === 'PUT' ? '/shares' : method === 'POST' ? '/reindex' : '';
      const payload =
        method === 'PUT' ? { teamIds: [] } : method === 'PATCH' ? { name: 'New' } : undefined;
      expect(
        (
          await app.inject({
            headers: AUTH,
            method,
            payload,
            url: `/api/v1/knowledge-bases/${KB}${suffix}`,
          })
        ).statusCode
      ).toBe(403);
    }
  );
  it('updates and deletes bases with audit records', async () => {
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'PATCH',
          payload: { name: 'New' },
          url: `/api/v1/knowledge-bases/${KB}`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ headers: AUTH, method: 'DELETE', url: `/api/v1/knowledge-bases/${KB}` }))
        .statusCode
    ).toBe(204);
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.knowledgeBase.update).toHaveBeenCalledWith({
      data: { name: 'New' },
      where: { id: KB },
    });
  });
  it('rejects cross-org shares and atomically clears empty shares', async () => {
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'PUT',
          payload: { teamIds: [TEAM] },
          url: `/api/v1/knowledge-bases/${KB}/shares`,
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'PUT',
          payload: { teamIds: [] },
          url: `/api/v1/knowledge-bases/${KB}/shares`,
        })
      ).statusCode
    ).toBe(200);
    expect(prisma.knowledgeBaseTeamShare.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeBase: { orgId: ORG }, knowledgeBaseId: KB },
    });
  });
  it('starts the index workflow seam and returns accepted', async () => {
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          url: `/api/v1/knowledge-bases/${KB}/reindex`,
        })
      ).statusCode
    ).toBe(202);
    expect(temporal.startKnowledgeBaseIndex).toHaveBeenCalledWith(KB);
  });
  it('does not report accepted if Temporal fails', async () => {
    temporal.startKnowledgeBaseIndex.mockRejectedValue(new Error('offline'));
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          url: `/api/v1/knowledge-bases/${KB}/reindex`,
        })
      ).statusCode
    ).toBe(500);
  });
});

describe('knowledge base links and effective preview', () => {
  const body = { knowledgeBaseId: KB, mandatory: true, scope: 'TEAM', teamId: TEAM };
  it('creates team defaults and records their owner', async () => {
    prisma.knowledgeBaseLink.create.mockResolvedValue({ ...body, id: KB });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: body,
          url: '/api/v1/knowledge-base-links',
        })
      ).statusCode
    ).toBe(201);
    expect(prisma.knowledgeBaseLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mandatory: true, teamId: TEAM }),
    });
  });
  it.each([
    { ...body, exclude: true },
    { ...body, repoId: REPO, scope: 'REPO', teamId: undefined },
    { ...body, repoId: REPO },
  ])('rejects inconsistent scope and flags: %j', async (payload) => {
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload,
          url: '/api/v1/knowledge-base-links',
        })
      ).statusCode
    ).toBe(400);
  });
  it('refuses attachment of an invisible or revoked KB', async () => {
    prisma.knowledgeBase.findFirst.mockResolvedValue(null);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: body,
          url: '/api/v1/knowledge-base-links',
        })
      ).statusCode
    ).toBe(400);
    expect(prisma.knowledgeBaseLink.create).not.toHaveBeenCalled();
  });
  it('requires target lead for listing and writing', async () => {
    vi.mocked(canManageTeamRepos).mockResolvedValue(false);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/knowledge-base-links?scope=TEAM&teamId=${TEAM}`,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: body,
          url: '/api/v1/knowledge-base-links',
        })
      ).statusCode
    ).toBe(403);
  });
  it('returns an empty target list', async () => {
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/knowledge-base-links?scope=TEAM&teamId=${TEAM}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });
  it('updates and deletes authorized links', async () => {
    prisma.knowledgeBaseLink.findUnique.mockResolvedValue({
      ...body,
      id: KB,
      repoId: null,
      templateId: null,
    });
    prisma.knowledgeBaseLink.update.mockResolvedValue(body);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'PATCH',
          payload: { ref: 'release' },
          url: `/api/v1/knowledge-base-links/${KB}`,
        })
      ).statusCode
    ).toBe(200);
    expect(prisma.knowledgeBaseLink.update).toHaveBeenCalledWith({
      data: { ref: 'release' },
      where: { id: KB },
    });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'DELETE',
          url: `/api/v1/knowledge-base-links/${KB}`,
        })
      ).statusCode
    ).toBe(204);
  });
  it('does not let team leads manage global template links', async () => {
    prisma.workflowTemplate.findUnique.mockResolvedValue({ teamId: null });
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'POST',
          payload: { knowledgeBaseId: KB, scope: 'TEMPLATE', templateId: TEMPLATE },
          url: '/api/v1/knowledge-base-links',
        })
      ).statusCode
    ).toBe(403);
  });
  it('returns missing links as 404', async () => {
    prisma.knowledgeBaseLink.findUnique.mockResolvedValue(null);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'DELETE',
          url: `/api/v1/knowledge-base-links/${KB}`,
        })
      ).statusCode
    ).toBe(404);
  });
  it('previews an empty effective set and hides inaccessible repos', async () => {
    prisma.connection.findFirst.mockResolvedValue({ id: REPO, team: { orgId: ORG }, teamId: TEAM });
    const response = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/repositories/${REPO}/knowledge-bases/effective`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ dropped: [], refusedExclusions: [], selected: [] });
    prisma.connection.findFirst.mockResolvedValue(null);
    expect(
      (
        await app.inject({
          headers: AUTH,
          method: 'GET',
          url: `/api/v1/repositories/${REPO}/knowledge-bases/effective`,
        })
      ).statusCode
    ).toBe(404);
  });
});
