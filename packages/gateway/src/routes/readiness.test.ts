import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    appId: null,
    appPrivateKey: null,
    token: 'ghp_x',
  })),
}));

// The agents the worker's boot gate resolves — derived from installed templates, faked here.
const required = vi.hoisted(() => ({ keys: ['implementer'] as string[] }));
vi.mock('@auto-swe/shared/lib/deploymentAgents', () => ({
  deploymentAgentRequirements: vi.fn(async () => ({ keys: required.keys, steps: new Set() })),
}));

import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { readinessRoutes } from './readiness.js';

function agentRow(over: Record<string, unknown>) {
  return {
    channelId: null,
    credentialId: null,
    inheritsModelFrom: null,
    orgId: null,
    scope: 'GLOBAL',
    teamId: null,
    version: 1,
    workflowTemplateId: null,
    ...over,
  };
}

function credRow(id: string, provider: string, over: Record<string, unknown> = {}) {
  return { apiBase: null, id, orgId: null, provider, scope: 'GLOBAL', teamId: null, ...over };
}

function newMockPrisma() {
  return {
    agent: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          agentRow({ key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' }),
          agentRow({ key: 'evalJudge', modelSpec: 'google/gemini-3.8-flash' }),
        ]),
    },
    connection: { count: vi.fn().mockResolvedValue(1) },
    embeddingConfig: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ credentialId: null, modelSpec: 'openai/text-embedding-3-large' }),
    },
    providerCredential: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          credRow('c1', 'anthropic'),
          credRow('c2', 'google'),
          credRow('c3', 'openai'),
        ]),
    },
    team: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

async function buildApp(role: 'ADMIN' | 'LEAD' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(readinessRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
const URL = '/api/v1/platform/readiness';

beforeEach(() => {
  vi.clearAllMocks();
  required.keys = ['implementer'];
});

interface Item {
  id: string;
  ok: boolean;
  detail: string;
  href: string;
}
const item = (data: { items: Item[] }, id: string) => data.items.find((i) => i.id === id) as Item;

describe('GET /readiness', () => {
  it('is ADMIN-only', async () => {
    const { app } = await buildApp('LEAD');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(403);
  });

  it('counts only the highest active version of each agent', async () => {
    const { app, prisma } = await buildApp();
    // Ordered by version descending, as the query asks.
    prisma.agent.findMany.mockResolvedValue([
      agentRow({ key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5', version: 2 }),
      agentRow({ key: 'implementer', modelSpec: 'mistral/old', version: 1 }),
    ]);
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(data.ready).toBe(true);
    expect(data.providers.map((p: { provider: string }) => p.provider)).not.toContain('mistral');
  });

  it('reports ready when everything is configured', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.ready).toBe(true);
    expect(data.gaps).toEqual([]);
    expect(data.providers).toEqual([
      { present: true, provider: 'anthropic', required: true, usedBy: ['implementer'] },
      { present: true, provider: 'google', required: false, usedBy: ['evalJudge'] },
      { present: true, provider: 'openai', required: true, usedBy: ['embeddings'] },
    ]);
  });

  it('fails on an agent the boot gate needs that has no credential, as the worker would', async () => {
    const { app, prisma } = await buildApp();
    prisma.providerCredential.findMany.mockResolvedValue([credRow('c3', 'openai')]);
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(data.ready).toBe(false);
    const creds = item(data, 'credentials');
    expect(creds.ok).toBe(false);
    expect(creds.detail).toContain('implementer (anthropic)');
    expect(creds.href).toBe('/studio/models?tab=credentials');
  });

  it('reports, without failing, an agent no installed template runs', async () => {
    const { app, prisma } = await buildApp();
    prisma.providerCredential.findMany.mockResolvedValue([
      credRow('c1', 'anthropic'),
      credRow('c3', 'openai'),
    ]);
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(data.ready).toBe(true);
    expect(data.providers.find((p: { provider: string }) => p.provider === 'google')).toMatchObject(
      {
        present: false,
        required: false,
      }
    );
    expect(data.gaps).toEqual([
      expect.objectContaining({ blocking: false, problem: 'no-credential', subject: 'evalJudge' }),
    ]);
  });

  it('reports a team override with no reachable credential as advisory', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findMany.mockResolvedValue([
      agentRow({ key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' }),
      agentRow({
        key: 'implementer',
        modelSpec: 'opencode-go/glm-5.2',
        scope: 'TEAM',
        teamId: 't1',
      }),
    ]);
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(data.ready).toBe(true);
    expect(data.gaps).toEqual([
      expect.objectContaining({
        blocking: false,
        scope: 'TEAM',
        subject: 'implementer',
        teamId: 't1',
      }),
    ]);
  });

  it('honours a pin only where the worker would: a GLOBAL pin for its provider', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findMany.mockResolvedValue([
      agentRow({ credentialId: 'c-pin', key: 'implementer', modelSpec: 'openrouter/x' }),
    ]);
    prisma.providerCredential.findMany.mockResolvedValue([
      credRow('c-pin', 'openrouter', { apiBase: 'https://openrouter.ai/api/v1' }),
      credRow('c3', 'openai'),
    ]);
    expect((await app.inject({ headers: AUTH, method: 'GET', url: URL })).json().data.ready).toBe(
      true
    );
    // The same pin to another provider's credential is not used, so nothing covers it.
    prisma.providerCredential.findMany.mockResolvedValue([
      credRow('c-pin', 'anthropic'),
      credRow('c3', 'openai'),
    ]);
    expect((await app.inject({ headers: AUTH, method: 'GET', url: URL })).json().data.ready).toBe(
      false
    );
  });

  it('fails when the boot gate needs an agent that has no platform-wide row', async () => {
    const { app } = await buildApp();
    required.keys = ['implementer', 'securityReview'];
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(item(data, 'credentials')).toMatchObject({ ok: false });
    expect(item(data, 'credentials').detail).toContain('securityReview');
  });

  it('flags a non-built-in provider whose credential has no apiBase', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findMany.mockResolvedValue([
      agentRow({ key: 'implementer', modelSpec: 'opencode-go/glm-5.2' }),
    ]);
    prisma.providerCredential.findMany.mockResolvedValue([
      credRow('c-go', 'opencode-go'),
      credRow('c3', 'openai'),
    ]);
    const { data } = (await app.inject({ headers: AUTH, method: 'GET', url: URL })).json();
    expect(data.ready).toBe(false);
    expect(data.gaps).toEqual([
      expect.objectContaining({ blocking: true, problem: 'no-api-base' }),
    ]);
  });

  it('does not count the seeded placeholder repository as a connection', async () => {
    const { app, prisma } = await buildApp();
    await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(prisma.connection.count).toHaveBeenCalledWith({
      where: {
        isActive: true,
        NOT: { organizationName: 'your-org', repoName: 'your-repo' },
        type: 'git_repo',
      },
    });
  });

  it('flags a missing embedding config, GitHub access and connections', async () => {
    const { app, prisma } = await buildApp();
    prisma.embeddingConfig.findUnique.mockResolvedValue(null);
    prisma.connection.count.mockResolvedValue(0);
    vi.mocked(resolveGitHubConfig).mockResolvedValueOnce({
      appId: null,
      appPrivateKey: null,
      token: null,
    } as never);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    const { data } = res.json();
    const ok = Object.fromEntries(data.items.map((i: { id: string; ok: boolean }) => [i.id, i.ok]));
    expect(ok).toEqual({ connections: false, credentials: true, embeddings: false, github: false });
    expect(data.ready).toBe(false);
  });

  it('counts a GitHub App as GitHub access', async () => {
    const { app } = await buildApp();
    vi.mocked(resolveGitHubConfig).mockResolvedValueOnce({
      appId: '12',
      appPrivateKey: 'pem',
      token: null,
    } as never);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.json().data.items.find((i: { id: string }) => i.id === 'github').ok).toBe(true);
  });
});
