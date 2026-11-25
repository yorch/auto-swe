import { packFiles } from '@auto-swe/shared/lib/harnessProfile';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessProfileRoutes } from './harnessProfiles.js';

const PID = '00000000-0000-4000-a000-000000000001';
const CONN = '00000000-0000-4000-a000-0000000000c1';
const CONN2 = '00000000-0000-4000-a000-0000000000c2';
const URL_SECRET = 'https://secret.example.com/mcp';

const file = (path: string, content: string) => ({
  bytes: Buffer.from(content),
  mode: '100644' as const,
  path,
});
const plugin = (dir: string, name: string, mcp: Record<string, unknown>) => [
  file(`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name })),
  file(`${dir}/.mcp.json`, JSON.stringify({ mcpServers: mcp })),
];

type Opts = {
  files?: ReturnType<typeof file>[];
  plugins?: string[];
  status?: string;
  rawFiles?: unknown;
};

const DEFAULT_FILES = [
  ...plugin('plugins/a', 'a', {
    dup: { url: 'https://d.example.com/x' },
    local: { args: [], command: 'node' },
    web: { url: URL_SECRET },
  }),
  ...plugin('plugins/b', 'b', { dup: { url: 'https://e.example.com/x' } }),
];

async function build(role: 'ADMIN' | 'ENGINEER' = 'ADMIN', o: Opts = {}) {
  const audit: Record<string, unknown>[] = [];
  const mappings: Record<string, unknown>[] = [];
  const connections: Record<string, unknown> = {
    [CONN]: { id: CONN, isActive: true, name: 'Docs MCP', shares: [], teamId: 't', type: 'mcp' },
    [CONN2]: { id: CONN2, isActive: false, shares: [], teamId: 't', type: 'mcp' },
    '00000000-0000-4000-a000-0000000000c3': {
      id: '00000000-0000-4000-a000-0000000000c3',
      isActive: true,
      shares: [],
      teamId: 't',
      type: 'git_repo',
    },
  };
  const profile = {
    createdAt: new Date(0),
    description: 'd',
    hooksEnabled: false,
    host: 'github.com',
    id: PID,
    lastCheckedAt: null,
    lastError: null,
    latestSha: 'a'.repeat(40),
    latestVersion: 1,
    marketplaceEntry: null,
    marketplaceSourceId: null,
    name: 'demo',
    status: o.status ?? 'OK',
    updatedAt: new Date(0),
  };
  const key = (w: { profileId_serverName: { profileId: string; serverName: string } }) =>
    mappings.findIndex(
      (m) =>
        m.profileId === w.profileId_serverName.profileId &&
        m.serverName === w.profileId_serverName.serverName
    );
  const out = (m: Record<string, unknown>) => ({
    ...m,
    connection: {
      name: (connections[m.connectionId as string] as { name?: string })?.name ?? null,
    },
    mappedBy: { email: 'a@b.c', name: 'Ada' },
    updatedAt: new Date(0),
  });
  const prisma: Record<string, unknown> = {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    agent: { findMany: vi.fn(async () => []) },
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return {};
      }),
    },
    connection: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => connections[where.id] ?? null
      ),
    },
    harnessProfile: { findUnique: vi.fn(async () => ({ ...profile, versions: [] })) },
    harnessProfileVersion: {
      findUnique: vi.fn(async () => ({
        files: o.rawFiles ?? packFiles(o.files ?? DEFAULT_FILES),
        manifest: { plugins: o.plugins ?? ['plugins/a', 'plugins/b'] },
      })),
    },
    pluginEnablement: { count: vi.fn(async () => 0) },
    pluginMcpMapping: {
      delete: vi.fn(async ({ where }: { where: never }) => {
        mappings.splice(key(where), 1);
        return {};
      }),
      findMany: vi.fn(async () => mappings.map(out)),
      findUnique: vi.fn(async ({ where }: { where: never }) => mappings[key(where)] ?? null),
      upsert: vi.fn(
        async ({
          create,
          update,
          where,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
          where: never;
        }) => {
          const i = key(where);
          if (i < 0) {
            mappings.push({ ...create });
            return out(create);
          }
          Object.assign(mappings[i] as object, update);
          return out(mappings[i] as Record<string, unknown>);
        }
      ),
    },
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as never);
  await app.register(harnessProfileRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer t' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/harness-profiles${url}`,
    });
  return { audit, call, mappings, prisma };
}

describe('plugin MCP mappings', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build();
  });

  it('maps a declared http server, audits it without any URL', async () => {
    const res = await t.call('PUT', '/demo/mcp-mappings/web', { connectionId: CONN });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      connectionId: CONN,
      connectionName: 'Docs MCP',
      mappedBy: 'Ada',
      serverName: 'web',
    });
    expect(t.audit).toHaveLength(1);
    expect(t.audit[0]).toMatchObject({
      action: 'CREATE',
      entityId: PID,
      entityType: 'HarnessProfile',
    });
    expect(JSON.stringify(t.audit)).not.toContain('http');
    // Remapping updates in place.
    const again = await t.call('PUT', '/demo/mcp-mappings/web', { connectionId: CONN });
    expect(again.statusCode).toBe(200);
    expect(t.mappings).toHaveLength(1);
    expect(t.audit[1]).toMatchObject({ action: 'UPDATE' });
  });

  it.each([
    ['not declared', 'nope', CONN, 400, 'MCP_SERVER_NOT_DECLARED'],
    ['unsupported', 'local', CONN, 400, 'MCP_SERVER_UNSUPPORTED'],
    ['ambiguous', 'dup', CONN, 400, 'MCP_SERVER_AMBIGUOUS'],
    ['inactive connection', 'web', CONN2, 400, 'MCP_CONNECTION_INVALID'],
    ['wrong type', 'web', '00000000-0000-4000-a000-0000000000c3', 400, 'MCP_CONNECTION_INVALID'],
    [
      'unknown connection',
      'web',
      '00000000-0000-4000-a000-0000000000ff',
      400,
      'MCP_CONNECTION_INVALID',
    ],
  ])('refuses %s', async (_l, server, connectionId, status, code) => {
    const res = await t.call('PUT', `/demo/mcp-mappings/${server}`, { connectionId });
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(JSON.stringify(res.json())).not.toContain('example.com');
    expect(t.mappings).toHaveLength(0);
    expect(t.audit).toHaveLength(0);
  });

  it('answers 404 for an unknown profile and 409 for a disabled one', async () => {
    (
      t.prisma.harnessProfile as { findUnique: ReturnType<typeof vi.fn> }
    ).findUnique.mockResolvedValueOnce(null);
    expect((await t.call('PUT', '/x/mcp-mappings/web', { connectionId: CONN })).statusCode).toBe(
      404
    );
    const d = await build('ADMIN', { status: 'DISABLED' });
    const res = await d.call('PUT', '/demo/mcp-mappings/web', { connectionId: CONN });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HARNESS_PROFILE_DISABLED');
  });

  it('is ADMIN only', async () => {
    const e = await build('ENGINEER');
    expect((await e.call('PUT', '/demo/mcp-mappings/web', { connectionId: CONN })).statusCode).toBe(
      403
    );
    expect((await e.call('DELETE', '/demo/mcp-mappings/web')).statusCode).toBe(403);
  });

  it('deletes a mapping (even on a disabled profile), 404 when absent, audited', async () => {
    expect((await t.call('DELETE', '/demo/mcp-mappings/web')).statusCode).toBe(404);
    await t.call('PUT', '/demo/mcp-mappings/web', { connectionId: CONN });
    const res = await t.call('DELETE', '/demo/mcp-mappings/web');
    expect(res.statusCode).toBe(204);
    expect(t.mappings).toHaveLength(0);
    expect(t.audit.at(-1)).toMatchObject({ action: 'DELETE', entityType: 'HarnessProfile' });
    expect(JSON.stringify(t.audit)).not.toContain('http');
    const d = await build('ADMIN', { status: 'DISABLED' });
    d.mappings.push({ connectionId: CONN, profileId: PID, serverName: 'web' });
    expect((await d.call('DELETE', '/demo/mcp-mappings/web')).statusCode).toBe(204);
  });

  it('GET detail lists declared servers, mappings and flags an orphan', async () => {
    t.mappings.push(
      { connectionId: CONN, profileId: PID, serverName: 'web' },
      { connectionId: CONN, profileId: PID, serverName: 'gone' }
    );
    const res = await t.call('GET', '/demo');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.mcpServers.map((s: { name: string }) => s.name).sort()).toEqual([
      'dup',
      'dup',
      'local',
      'web',
    ]);
    expect(d.mcpServers.find((s: { name: string }) => s.name === 'web')).toMatchObject({
      duplicate: false,
      plugin: 'a',
      supported: true,
      transport: 'http',
    });
    expect(d.mcpMappings).toEqual([
      expect.objectContaining({ declared: true, serverName: 'web', supported: true }),
      expect.objectContaining({ declared: false, serverName: 'gone', supported: false }),
    ]);
    expect(d.mcpUnreadable).toEqual([]);
  });

  it('GET detail never fails on an unreadable snapshot', async () => {
    const u = await build('ADMIN', { rawFiles: 'not a snapshot' });
    const res = await u.call('GET', '/demo');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ mcpMappings: [], mcpServers: [], mcpUnreadable: [] });
  });

  it('GET detail reports an unreadable declaration with a fixed reason', async () => {
    const u = await build('ADMIN', {
      files: [
        file('plugins/a/.claude-plugin/plugin.json', '{"name":"a"}'),
        file('plugins/a/.mcp.json', '{broken'),
      ],
      plugins: ['plugins/a'],
    });
    const d = (await u.call('GET', '/demo')).json().data;
    expect(d.mcpServers).toEqual([]);
    expect(d.mcpUnreadable).toEqual([
      { file: 'plugins/a/.mcp.json', plugin: 'a', reason: 'the file is not valid JSON' },
    ]);
  });
});
