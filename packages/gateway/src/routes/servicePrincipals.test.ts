import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: vi.fn(async () => ({
    'repoAccess.mode': 'off',
    'repoAccess.staleAfterHours': 24,
  })),
}));

import { servicePrincipalRoutes } from './servicePrincipals.js';

const LEAD = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const SP = '33333333-3333-4333-8333-333333333333';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TEMPLATE = 'cccccccc-1111-4111-8111-cccccccccccc';
const TOKEN = 'dddddddd-1111-4111-8111-dddddddddddd';

interface State {
  platformRole: string;
  teamRole: string | null;
  repoTeamId: string;
  orgOverBudget: boolean;
  orgMember: boolean;
  template: { teamId: string | null; origin: string | null; status: string; name: string } | null;
  liveTokens: number;
  principal: Record<string, unknown> | null;
  tokenRow: Record<string, unknown> | null;
  inFlight: number;
}

describe('service principal management routes', () => {
  let app: FastifyInstance;
  let s: State;
  let audits: Array<Record<string, unknown>>;
  let created: Array<Record<string, unknown>>;
  let updated: Array<Record<string, unknown>>;
  let connectionLookups: number;
  let tokensCreated: Array<Record<string, unknown>>;
  let deleted: number;

  const principalRow = (over: Record<string, unknown> = {}) => ({
    connectionIds: [] as string[],
    createdAt: new Date(),
    createdBy: { email: 'lead@example.com', id: LEAD },
    description: null,
    disabledAt: null,
    id: SP,
    maxInFlight: 5,
    maxRunsPerDay: 50,
    name: 'deployer',
    teamId: TEAM,
    templateIds: [] as string[],
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    s = {
      inFlight: 0,
      liveTokens: 0,
      orgMember: true,
      orgOverBudget: false,
      platformRole: 'LEAD',
      principal: principalRow(),
      repoTeamId: TEAM,
      teamRole: 'LEAD',
      template: { name: 'Release notes', origin: null, status: 'ACTIVE', teamId: TEAM },
      tokenRow: null,
    };
    audits = [];
    created = [];
    updated = [];
    tokensCreated = [];
    connectionLookups = 0;
    deleted = 0;

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      hashToken: (t: string) => `hash:${t}`,
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: s.platformRole, sub: LEAD }),
    } as unknown as never);

    const prisma: Record<string, unknown> = {
      $queryRaw: async () => [{ id: SP }],
      activeWorkflow: { count: async () => s.inFlight },
      apiToken: {
        count: async () => s.liveTokens,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          tokensCreated.push(data);
          return {
            createdAt: new Date(),
            id: TOKEN,
            lastUsedAt: null,
            revokedAt: null,
            userId: null,
            ...data,
          };
        },
        findFirst: async () => s.tokenRow,
        // A service token presented to these routes.
        findUnique: async () => ({
          expiresAt: new Date(Date.now() + 86_400_000),
          id: 'tok-x',
          revokedAt: null,
          scopes: ['runs:launch', 'runs:read', 'runs:cancel'],
          servicePrincipal: {
            connectionIds: [],
            disabledAt: null,
            id: SP,
            name: 'deployer',
            team: { isActive: true, organization: { isActive: true } },
            teamId: TEAM,
            templateIds: [],
          },
          servicePrincipalId: SP,
          user: null,
          userId: null,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => ({
          ...(s.tokenRow as Record<string, unknown>),
          ...data,
        }),
      },
      configAuditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          audits.push(data);
          return data;
        },
      },
      connection: {
        findUnique: async () => {
          connectionLookups++;
          return {
            githubApiUrl: null,
            githubUrl: null,
            id: REPO,
            installation: null,
            isActive: true,
            organizationName: 'acme',
            repoName: 'api',
            shares: [],
            team: {
              memberships: s.repoTeamId === TEAM ? [{ userId: LEAD }] : [],
              organization: { monthlyBudgetUsdCents: s.orgOverBudget ? 100 : null },
              orgId: 'org-1',
            },
            teamId: s.repoTeamId,
            type: 'git_repo',
          };
        },
      },
      organizationMembership: {
        findUnique: async () => (s.orgMember ? { role: 'ORG_MEMBER' } : null),
      },
      orgMonthlyUsage: {
        findUnique: async () => (s.orgOverBudget ? { costUsdAccrued: 100 } : null),
      },
      servicePrincipal: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return principalRow(data);
        },
        delete: async () => {
          deleted++;
          return {};
        },
        findFirst: async () => s.principal,
        findMany: async () => [{ ...principalRow(), _count: { tokens: 1 } }],
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return { ...(s.principal as Record<string, unknown>), ...data };
        },
      },
      team: { findUnique: async () => ({ id: TEAM }) },
      teamMembership: {
        findUnique: async () => (s.teamRole ? { role: s.teamRole } : null),
      },
      workflowTemplate: {
        findUnique: async () => (s.template ? { id: TEMPLATE, ...s.template } : null),
      },
    };
    prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
    app.decorate('prisma', prisma as unknown as never);
    app.register(servicePrincipalRoutes, { prefix: '/api/v1/teams' });
    await app.ready();
  });

  afterEach(() => app.close());

  const base = `/api/v1/teams/${TEAM}/service-principals`;
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer jwt' },
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  describe('who may manage', () => {
    it('a LEAD of the team', async () => {
      expect((await send('GET', base)).statusCode).toBe(200);
    });

    it('a platform ADMIN who is not a member', async () => {
      s.platformRole = 'ADMIN';
      s.teamRole = null;
      expect((await send('GET', base)).statusCode).toBe(200);
    });

    it('not an ENGINEER of the team', async () => {
      s.teamRole = 'ENGINEER';
      expect((await send('GET', base)).statusCode).toBe(403);
    });

    it('not a platform ENGINEER, whatever their team role', async () => {
      s.platformRole = 'ENGINEER';
      expect((await send('POST', base, { name: 'x' })).statusCode).toBe(403);
      expect(created).toHaveLength(0);
    });

    it('not a service principal token', async () => {
      const res = await app.inject({
        headers: { authorization: 'Bearer ats_service' },
        method: 'GET',
        url: base,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    });
  });

  describe('create and the grant-time launch decision', () => {
    it('creates with empty allowlists and audits it', async () => {
      const res = await send('POST', base, { name: 'deployer' });
      expect(res.statusCode).toBe(201);
      expect(created[0]).toMatchObject({
        connectionIds: [],
        createdById: LEAD,
        maxInFlight: 5,
        maxRunsPerDay: 50,
        teamId: TEAM,
        templateIds: [],
      });
      expect(audits[0]).toMatchObject({ action: 'CREATE', entityType: 'ServicePrincipal' });
    });

    it("grants a team repository after the lead's own launch decision", async () => {
      const res = await send('POST', base, { connectionIds: [REPO], name: 'deployer' });
      expect(res.statusCode).toBe(201);
      expect(created[0]?.connectionIds).toEqual([REPO]);
    });

    it("refuses a repository the principal's team neither owns nor shares", async () => {
      s.repoTeamId = OTHER_TEAM;
      const res = await send('POST', base, { connectionIds: [REPO], name: 'deployer' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CONNECTION_NOT_GRANTABLE');
      expect(created).toHaveLength(0);
    });

    it("refuses when the lead's launch decision fails: the org is over its cap", async () => {
      s.orgOverBudget = true;
      const res = await send('POST', base, { connectionIds: [REPO], name: 'deployer' });
      expect(res.statusCode).toBe(402);
      expect(created).toHaveLength(0);
    });

    it("refuses when the lead is not in the repository's organization", async () => {
      s.orgMember = false;
      const res = await send('POST', base, { connectionIds: [REPO], name: 'deployer' });
      expect(res.statusCode).toBe(403);
      expect(created).toHaveLength(0);
    });

    it('takes no decision to remove a repository, even with the org over its cap', async () => {
      s.principal = principalRow({ connectionIds: [REPO] });
      s.orgOverBudget = true;
      const res = await send('PATCH', `${base}/${SP}`, { connectionIds: [] });
      expect(res.statusCode).toBe(200);
      expect(connectionLookups).toBe(0);
      expect(updated[0]).toEqual({ connectionIds: [] });
      expect(audits[0]).toMatchObject({
        action: 'UPDATE',
        afterJson: expect.objectContaining({ connectionIds: [] }),
        beforeJson: expect.objectContaining({ connectionIds: [REPO] }),
      });
    });

    it('decides only what an update adds, not what was already granted', async () => {
      s.principal = principalRow({ connectionIds: [REPO] });
      s.orgOverBudget = true;
      const res = await send('PATCH', `${base}/${SP}`, { connectionIds: [REPO], name: 'renamed' });
      expect(res.statusCode).toBe(200);
      expect(connectionLookups).toBe(0);
    });

    it.each([
      ['another team', { name: 'x', origin: null, status: 'ACTIVE', teamId: OTHER_TEAM }],
      [
        'the system',
        { name: 'Agent Run', origin: 'system:agent-run', status: 'ACTIVE', teamId: null },
      ],
      [
        'the platform (Channel Assistant)',
        { name: 'Channel Assistant', origin: null, status: 'ACTIVE', teamId: null },
      ],
      ['nobody: archived', { name: 'x', origin: null, status: 'ARCHIVED', teamId: TEAM }],
    ])('refuses a template owned by %s', async (_label, template) => {
      s.template = template;
      const res = await send('POST', base, { name: 'deployer', templateIds: [TEMPLATE] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TEMPLATE_NOT_GRANTABLE');
    });

    it('grants a global template', async () => {
      s.template = { name: 'Docs', origin: null, status: 'ACTIVE', teamId: null };
      const res = await send('POST', base, { name: 'deployer', templateIds: [TEMPLATE] });
      expect(res.statusCode).toBe(201);
    });

    it('disables and re-enables', async () => {
      const off = await send('PATCH', `${base}/${SP}`, { disabled: true });
      expect(off.statusCode).toBe(200);
      expect(updated[0]?.disabledAt).toBeInstanceOf(Date);
      await send('PATCH', `${base}/${SP}`, { disabled: false });
      expect(updated[1]).toEqual({ disabledAt: null });
    });

    it('deletes a principal with nothing in flight, and audits it', async () => {
      const res = await send('DELETE', `${base}/${SP}`);
      expect(res.statusCode).toBe(204);
      expect(deleted).toBe(1);
      expect(audits[0]).toMatchObject({ action: 'DELETE', entityType: 'ServicePrincipal' });
    });

    it('refuses to delete a principal with runs in flight: 409, disable it instead', async () => {
      s.inFlight = 1;
      const res = await send('DELETE', `${base}/${SP}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SERVICE_PRINCIPAL_HAS_RUNS');
      expect(deleted).toBe(0);
      expect(audits).toHaveLength(0);
    });

    it("404s another team's principal", async () => {
      s.principal = null;
      expect((await send('PATCH', `${base}/${SP}`, { name: 'x' })).statusCode).toBe(404);
    });
  });

  describe('tokens', () => {
    const mint = (body: Record<string, unknown>) =>
      send('POST', `${base}/${SP}/tokens`, {
        expiresInDays: 90,
        name: 'ci',
        scopes: ['runs:launch'],
        ...body,
      });

    it('mints a token with an expiry, returns the plaintext once, and never audits it', async () => {
      const res = await mint({});
      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data.token).toMatch(/^ats_/);
      expect(data.prefix).toBe(data.token.slice(0, 12));
      expect(data).not.toHaveProperty('tokenHash');
      const row = tokensCreated[0] as Record<string, unknown>;
      expect(row.servicePrincipalId).toBe(SP);
      expect(row).not.toHaveProperty('userId');
      expect(row.scopes).toEqual(['runs:launch']);
      const days = ((row.expiresAt as Date).getTime() - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(90);
      const audit = JSON.stringify(audits[0]);
      expect(audits[0]).toMatchObject({ action: 'CREATE', entityType: 'ServiceToken' });
      expect(audit).not.toContain(data.token);
      expect(audit).not.toContain('hash:');
    });

    it.each([
      ['no expiry', { expiresInDays: undefined }],
      ['an expiry past a year', { expiresInDays: 366 }],
      ['no scopes', { scopes: [] }],
      ['an unknown scope', { scopes: ['admin'] }],
    ])('refuses %s', async (_label, body) => {
      const res = await mint(body);
      expect(res.statusCode).toBe(400);
      expect(tokensCreated).toHaveLength(0);
    });

    it('refuses a third live token: two is rotation overlap', async () => {
      s.liveTokens = 2;
      const res = await mint({});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SERVICE_TOKEN_LIMIT_REACHED');
      expect(tokensCreated).toHaveLength(0);
    });

    it('revokes a token of this principal and audits it', async () => {
      s.tokenRow = {
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        id: TOKEN,
        lastUsedAt: null,
        name: 'ci',
        prefix: 'ats_abcdefgh',
        revokedAt: null,
        scopes: ['runs:launch'],
        servicePrincipalId: SP,
        userId: null,
      };
      const res = await send('DELETE', `${base}/${SP}/tokens/${TOKEN}`);
      expect(res.statusCode).toBe(200);
      expect(audits[0]).toMatchObject({ entityType: 'ServiceToken' });
    });

    it("404s a token that is not this principal's", async () => {
      s.tokenRow = null;
      expect((await send('DELETE', `${base}/${SP}/tokens/${TOKEN}`)).statusCode).toBe(404);
    });
  });
});
