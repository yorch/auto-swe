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

import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { readinessRoutes } from './readiness.js';

function newMockPrisma() {
  return {
    agent: {
      findMany: vi.fn().mockResolvedValue([
        { credentialId: null, key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' },
        { credentialId: null, key: 'evalJudge', modelSpec: 'google/gemini-3.8-flash' },
      ]),
    },
    connection: { count: vi.fn().mockResolvedValue(1) },
    embeddingConfig: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ credentialId: null, modelSpec: 'openai/text-embedding-3-large' }),
    },
    providerCredential: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'c1', provider: 'anthropic' },
        { id: 'c2', provider: 'google' },
        { id: 'c3', provider: 'openai' },
      ]),
    },
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

beforeEach(() => vi.clearAllMocks());

describe('GET /readiness', () => {
  it('is ADMIN-only', async () => {
    const { app } = await buildApp('LEAD');
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(403);
  });

  it('counts only the highest active version of each agent', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findMany.mockResolvedValue([
      { credentialId: null, key: 'implementer', modelSpec: 'mistral/old', version: 1 },
      {
        credentialId: null,
        key: 'implementer',
        modelSpec: 'anthropic/claude-opus-5-5',
        version: 2,
      },
    ]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    const { data } = res.json();
    expect(data.ready).toBe(true);
    expect(data.providers.map((p: { provider: string }) => p.provider)).not.toContain('mistral');
  });

  it('skips an agent whose latest version inherits its model, even if an older one had a spec', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findMany.mockResolvedValue([
      { credentialId: null, key: 'implementer', modelSpec: 'mistral/old', version: 1 },
      { credentialId: null, key: 'implementer', modelSpec: null, version: 2 },
    ]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    const { data } = res.json();
    expect(data.providers.map((p: { provider: string }) => p.provider)).not.toContain('mistral');
  });

  it('reports ready when everything is configured', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.ready).toBe(true);
    expect(data.providers.map((p: { provider: string }) => p.provider)).toEqual([
      'anthropic',
      'google',
      'openai',
    ]);
    expect(
      data.providers.find((p: { provider: string }) => p.provider === 'openai').usedBy
    ).toEqual(['embeddings']);
  });

  it('names a provider an active agent uses that has no credential', async () => {
    const { app, prisma } = await buildApp();
    prisma.providerCredential.findMany.mockResolvedValue([{ id: 'c1', provider: 'anthropic' }]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    const { data } = res.json();
    expect(data.ready).toBe(false);
    const creds = data.items.find((i: { id: string }) => i.id === 'credentials');
    expect(creds.ok).toBe(false);
    expect(creds.detail).toContain('google');
    expect(creds.href).toBe('/studio/models?tab=credentials');
    expect(data.items.find((i: { id: string }) => i.id === 'embeddings').ok).toBe(false);
  });

  it('accepts an agent pinned to its own credential', async () => {
    const { app, prisma } = await buildApp();
    prisma.providerCredential.findMany.mockResolvedValue([
      { id: 'c1', provider: 'anthropic' },
      { id: 'c3', provider: 'openai' },
    ]);
    prisma.agent.findMany.mockResolvedValue([
      { credentialId: 'c1', key: 'evalJudge', modelSpec: 'google/gemini-3.8-flash' },
    ]);
    const res = await app.inject({ headers: AUTH, method: 'GET', url: URL });
    expect(res.json().data.items.find((i: { id: string }) => i.id === 'credentials').ok).toBe(true);
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
