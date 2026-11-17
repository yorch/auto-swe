import { createHash } from 'node:crypto';
import { unpackFiles } from '@auto-swe/shared/lib/harnessProfile';
import type { SkillSourceDeps } from '@auto-swe/shared/lib/skillSource';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marketplaceRoutes } from './marketplaces.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const PLUGIN_SHA = 'd'.repeat(40);

const blobId = (b: Buffer) =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

type Entry = { content: string; path: string; mode?: string };

const CATALOG = {
  metadata: { description: 'ignored' },
  name: 'acme-market',
  owner: { name: 'Acme' },
  plugins: [
    { description: 'Formats code', name: 'fmt', source: './plugins/fmt', version: '1.0.0' },
    { name: 'remote', source: { ref: 'main', repo: 'acme/remote', source: 'github' } },
    {
      name: 'pinned',
      source: { repo: 'acme/pinned', sha: PLUGIN_SHA, source: 'github' },
    },
    { name: 'gitonly', source: { source: 'url', url: 'https://example.com/x.git' } },
    { name: 'escape', source: '../outside' },
  ],
};

const pluginFiles = (prefix: string, extra: Entry[] = []): Entry[] => [
  { content: '{"name":"fmt"}', path: `${prefix}.claude-plugin/plugin.json` },
  { content: 'Say hi', path: `${prefix}commands/hi.md` },
  ...extra,
];

const MCP = JSON.stringify({
  mcpServers: {
    docs: { type: 'http', url: 'https://mcp.example.com/mcp?token=SECRET' },
    local: { args: ['SECRET'], command: 'node' },
  },
});

type Row = Record<string, unknown> & { id: string };

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const hub = {
    repos: {
      market: [
        { content: JSON.stringify(CATALOG), path: '.claude-plugin/marketplace.json' },
        ...pluginFiles('plugins/fmt/'),
      ] as Entry[],
      pinned: pluginFiles('') as Entry[],
      remote: pluginFiles('') as Entry[],
    } as Record<string, Entry[]>,
    shas: { market: SHA } as Record<string, string>,
  };
  const state = {
    audit: [] as Row[],
    profiles: [] as Row[],
    sources: [] as Row[],
    versions: [] as Row[],
  };
  let seq = 0;
  const id = () => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`;

  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const repo = /\/repos\/[^/]+\/([^/]+)/.exec(u)?.[1] as string;
    const entries = hub.repos[repo] ?? [];
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes('/commits/')) {
      return ok({ sha: hub.shas[repo] ?? SHA2 });
    }
    if (u.includes('/git/trees/')) {
      return ok({
        tree: entries.map((e) => {
          const b = Buffer.from(e.content);
          return {
            mode: e.mode ?? '100644',
            path: e.path,
            sha: blobId(b),
            size: b.length,
            type: 'blob',
          };
        }),
        truncated: false,
      });
    }
    const m = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    const e = entries.find((x) => blobId(Buffer.from(x.content)) === m?.[1]);
    return e
      ? ok({ content: Buffer.from(e.content).toString('base64'), encoding: 'base64' })
      : new Response('{}', { status: 404 });
  });

  const pick = (row: Row, select?: Record<string, unknown>) => {
    if (!select) {
      return { ...row };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) {
      out[k] =
        k === '_count'
          ? { profiles: state.profiles.filter((p) => p.marketplaceSourceId === row.id).length }
          : row[k];
    }
    return out;
  };
  const sourceModel = {
    create: vi.fn(async ({ data, select }: { data: Row; select?: Record<string, unknown> }) => {
      if (
        state.sources.some(
          (s) =>
            s.host === data.host &&
            s.owner === data.owner &&
            s.repo === data.repo &&
            s.path === data.path
        )
      ) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = {
        createdAt: new Date(0),
        lastCheckedAt: null,
        lastError: null,
        latestSha: null,
        status: 'OK',
        updatedAt: new Date(0),
        ...data,
        id: id(),
      } as Row;
      state.sources.push(row);
      return pick(row, select);
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      state.sources = state.sources.filter((s) => s.id !== where.id);
      for (const p of state.profiles) {
        if (p.marketplaceSourceId === where.id) {
          p.marketplaceSourceId = null;
        }
      }
      return {};
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const s = state.sources.find((x) => Object.entries(where).every(([k, v]) => x[k] === v));
      return s ? { id: s.id } : null;
    }),
    findMany: vi.fn(async ({ select }: { select?: Record<string, unknown> } = {}) =>
      state.sources.map((s) => pick(s, select))
    ),
    findUnique: vi.fn(
      async ({ select, where }: { select?: Record<string, unknown>; where: { id: string } }) => {
        const s = state.sources.find((x) => x.id === where.id);
        return s ? pick(s, select) : null;
      }
    ),
    update: vi.fn(
      async ({
        data,
        select,
        where,
      }: {
        data: Row;
        select?: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        const s =
          state.sources.find(
            (x) =>
              x.id === where.id &&
              (where.pinnedSha === undefined || x.pinnedSha === where.pinnedSha) &&
              x.status !== 'DISABLED'
          ) ??
          (where.pinnedSha === undefined
            ? state.sources.find((x) => x.id === where.id)
            : undefined);
        if (!s) {
          throw Object.assign(new Error('missing'), { code: 'P2025' });
        }
        Object.assign(s, data);
        return pick(s, select);
      }
    ),
    updateMany: vi.fn(async ({ data, where }: { data: Row; where: Record<string, unknown> }) => {
      const s = state.sources.find(
        (x) => x.id === where.id && x.pinnedSha === where.pinnedSha && x.status !== 'DISABLED'
      );
      if (!s) {
        return { count: 0 };
      }
      Object.assign(s, data);
      return { count: 1 };
    }),
  };
  const profileModel = {
    create: vi.fn(
      async ({
        data,
        select,
      }: {
        data: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        if (
          state.profiles.some(
            (p) => String(p.name).toLowerCase() === String(data.name).toLowerCase()
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const { versions, ...rest } = data as { versions: { create: Record<string, unknown> } };
        const row = { id: id(), status: 'OK', ...rest } as Row;
        state.profiles.push(row);
        state.versions.push({ id: id(), profileId: row.id, ...versions.create });
        return pick(row, select);
      }
    ),
    findMany: vi.fn(
      async ({
        select,
        where,
      }: {
        select?: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        const match = (p: Row, w: Record<string, unknown>): boolean => {
          const n = w.name as { equals?: string; in?: string[] } | undefined;
          if (n?.equals !== undefined) {
            return String(p.name).toLowerCase() === n.equals.toLowerCase();
          }
          if (n?.in) {
            return n.in.some((x) => x.toLowerCase() === String(p.name).toLowerCase());
          }
          if (w.marketplaceSourceId !== undefined) {
            return p.marketplaceSourceId === w.marketplaceSourceId;
          }
          return false;
        };
        const ors = (where.OR as Array<Record<string, unknown>> | undefined) ?? [where];
        return state.profiles
          .filter((p) => ors.some((w) => match(p, w)))
          .map((p) => pick(p, select));
      }
    ),
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audit.push({ id: id(), ...data });
        return {};
      }),
    },
    harnessProfile: profileModel,
    marketplaceSource: sourceModel,
  };

  const source: SkillSourceDeps = {
    approvedHosts: async () => [],
    fetch: fetchFn as unknown as typeof fetch,
    githubConfig: (async () => ({
      apiUrl: 'https://api.github.com',
      baseUrl: 'https://github.com',
    })) as unknown as SkillSourceDeps['githubConfig'],
    githubToken: (async () => 't') as SkillSourceDeps['githubToken'],
    platformCredential: (async () => ({
      scope: 'none',
    })) as unknown as SkillSourceDeps['platformCredential'],
    privateNetworkHosts: async () => [],
  };
  const scanners = {
    shell: vi.fn(async () => ({ hits: [] as string[], incomplete: false })),
    text: vi.fn(async () => ({ hits: [] as string[], incomplete: false })),
  };

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(marketplaceRoutes, {
    prefix: '/api/v1/platform',
    readDeps: { scanners, source },
  });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/marketplaces${url}`,
    });
  return { call, fetchFn, hub, prisma, scanners, state };
}

const LOC = { owner: 'acme', ref: 'main', repo: 'market' };

describe('marketplace routes', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    t = await buildApp();
  });

  const add = async () => {
    const res = await t.call('POST', '', { ...LOC, sha: SHA });
    expect(res.statusCode).toBe(201);
    return res.json().data as { id: string };
  };
  /** Preview an entry and approve it with its hashes. */
  const approve = async (id: string, entry: string, over: Record<string, unknown> = {}) => {
    const pv = await t.call('POST', `/${id}/entries/preview`, { entry });
    const d = pv.json().data;
    return t.call('POST', `/${id}/entries/approve`, {
      acknowledgeWarnings: true,
      contentHash: d?.contentHash ?? '0'.repeat(64),
      entry,
      hooksEnabled: false,
      sha: d?.sha ?? SHA,
      warningsHash: d?.warningsHash ?? '0'.repeat(64),
      ...over,
    });
  };

  it('is ADMIN only', async () => {
    const e = await buildApp('ENGINEER');
    for (const [m, u] of [
      ['GET', ''],
      ['POST', '/preview'],
      ['POST', ''],
      ['GET', '/00000000-0000-4000-a000-000000000001'],
    ] as const) {
      expect((await e.call(m, u, m === 'POST' ? { ...LOC, sha: SHA } : undefined)).statusCode).toBe(
        403
      );
    }
    expect(e.fetchFn).not.toHaveBeenCalled();
  });

  describe('preview', () => {
    it('reads the catalog, flags installable entries with a reason, and lists ignored keys', async () => {
      const res = await t.call('POST', '/preview', LOC);
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d).toMatchObject({ existingId: null, sha: SHA });
      expect(d.source).toEqual({
        host: 'github.com',
        owner: 'acme',
        path: '',
        ref: 'main',
        repo: 'market',
      });
      expect(d.catalog).toMatchObject({ ignoredKeys: [], name: 'acme-market', ownerName: 'Acme' });
      const byName = Object.fromEntries(
        d.catalog.entries.map((e: { name: string }) => [e.name, e])
      );
      expect(byName.fmt).toMatchObject({
        installable: true,
        nameTaken: false,
        profile: null,
        reason: null,
      });
      expect(byName.remote.installable).toBe(true);
      expect(byName.gitonly).toMatchObject({ installable: false });
      expect(byName.gitonly.reason).toContain('GitHub repository');
      expect(byName.escape).toMatchObject({ installable: false });
      expect(t.fetchFn).toHaveBeenCalledTimes(3);
    });

    it('answers a missing or invalid catalog with a fixed 422', async () => {
      t.hub.repos.market = [];
      const res = await t.call('POST', '/preview', LOC);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('MARKETPLACE_INVALID');
    });

    it('maps a host refusal to a fixed code and makes no request', async () => {
      const res = await t.call('POST', '/preview', { ...LOC, host: 'ghe.example.com' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('MARKETPLACE_HOST_NOT_APPROVED');
      expect(t.fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('add, list, get, patch, delete', () => {
    it('pins the previewed commit, audits, and refuses a duplicate', async () => {
      const created = await t.call('POST', '', { ...LOC, sha: SHA });
      expect(created.statusCode).toBe(201);
      expect(created.json().data).toMatchObject({ pinnedSha: SHA, profileCount: 0, status: 'OK' });
      expect(t.state.audit).toHaveLength(1);
      expect(t.state.audit[0]).toMatchObject({ action: 'CREATE', entityType: 'MarketplaceSource' });
      const dup = await t.call('POST', '', { ...LOC, owner: 'ACME', sha: SHA });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('MARKETPLACE_EXISTS');
      const pv = await t.call('POST', '/preview', LOC);
      expect(pv.json().data.existingId).toBe(created.json().data.id);
    });

    it('refuses when the ref moved since the preview', async () => {
      t.hub.shas.market = SHA2;
      const res = await t.call('POST', '', { ...LOC, sha: SHA });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('MARKETPLACE_SHA_MOVED');
      expect(t.state.sources).toHaveLength(0);
    });

    it('lists sources and returns the catalog at the pinned commit with per-entry profile info', async () => {
      const { id } = await add();
      expect((await t.call('GET', '')).json().data).toHaveLength(1);
      const before = (await t.call('GET', `/${id}`)).json().data;
      expect(before.catalog.entries.map((e: { profile: unknown }) => e.profile)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(await approve(id, 'fmt').then((r) => r.statusCode)).toBe(201);
      const after = (await t.call('GET', `/${id}`)).json().data;
      expect(after.profileCount).toBe(1);
      expect(after.catalog.entries[0].profile).toEqual({
        latestVersion: 1,
        name: 'fmt',
        status: 'OK',
      });
      expect(after.catalog.entries[0].nameTaken).toBe(false);
    });

    it('reports an unreadable catalog as a fixed catalogError instead of failing', async () => {
      const { id } = await add();
      t.hub.repos.market = [];
      const res = await t.call('GET', `/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.catalog).toBeNull();
      expect(res.json().data.catalogError).toContain('not found');
    });

    it('404s an unknown id and a non-uuid is a 400', async () => {
      expect((await t.call('GET', '/00000000-0000-4000-a000-0000000000ff')).statusCode).toBe(404);
      expect((await t.call('GET', '/nope')).statusCode).toBe(400);
    });

    it('disables and re-enables, auditing both, and a disabled source refuses entry work and checks', async () => {
      const { id } = await add();
      const off = await t.call('PATCH', `/${id}`, { status: 'DISABLED' });
      expect(off.json().data.status).toBe('DISABLED');
      for (const [u, b] of [
        [`/${id}/entries/preview`, { entry: 'fmt' }],
        [`/${id}/check`, undefined],
        [`/${id}/accept-update`, { sha: SHA2 }],
      ] as const) {
        const res = await t.call('POST', u, b);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('MARKETPLACE_DISABLED');
      }
      const on = await t.call('PATCH', `/${id}`, { status: 'OK' });
      expect(on.json().data.status).toBe('OK');
      expect(t.state.audit.filter((a) => a.action === 'UPDATE')).toHaveLength(2);
    });

    it('deletes the source and leaves its profiles in place, detached', async () => {
      const { id } = await add();
      await approve(id, 'fmt');
      const res = await t.call('DELETE', `/${id}`);
      expect(res.statusCode).toBe(204);
      expect(t.state.sources).toHaveLength(0);
      expect(t.state.profiles).toHaveLength(1);
      expect(t.state.profiles[0]?.marketplaceSourceId).toBeNull();
      expect(t.state.audit.at(-1)).toMatchObject({
        action: 'DELETE',
        entityType: 'MarketplaceSource',
      });
      expect((await t.call('DELETE', `/${id}`)).statusCode).toBe(404);
    });
  });

  describe('check and accept-update', () => {
    it('check records the newest commit and flags an update; accept-update moves the pin only', async () => {
      const { id } = await add();
      t.hub.shas.market = SHA2;
      const chk = await t.call('POST', `/${id}/check`);
      expect(chk.statusCode).toBe(200);
      expect(chk.json().data).toMatchObject({
        check: { error: null, status: 'UPDATE_AVAILABLE' },
        recorded: true,
        source: { latestSha: SHA2, pinnedSha: SHA, status: 'UPDATE_AVAILABLE' },
      });
      const acc = await t.call('POST', `/${id}/accept-update`, { sha: SHA2 });
      expect(acc.statusCode).toBe(200);
      expect(acc.json().data).toMatchObject({ pinnedSha: SHA2, status: 'OK' });
      expect(t.state.profiles).toHaveLength(0);
      expect(t.state.audit.at(-1)).toMatchObject({
        action: 'UPDATE',
        entityType: 'MarketplaceSource',
      });
    });

    it('check records a fixed error string for a failing host', async () => {
      const { id } = await add();
      t.hub.repos.market = [];
      t.fetchFn.mockImplementationOnce(
        async () => new Response('upstream secret', { status: 500 })
      );
      const chk = await t.call('POST', `/${id}/check`);
      expect(chk.json().data.check.status).toBe('ERROR');
      expect(JSON.stringify(chk.json())).not.toContain('secret');
      expect(chk.json().data.source.status).toBe('ERROR');
    });

    it('accept-update refuses the current pin, a moved ref and an unreadable catalog', async () => {
      const { id } = await add();
      expect((await t.call('POST', `/${id}/accept-update`, { sha: SHA })).json().error.code).toBe(
        'MARKETPLACE_NO_CHANGE'
      );
      const moved = await t.call('POST', `/${id}/accept-update`, { sha: 'c'.repeat(40) });
      expect(moved.statusCode).toBe(409);
      expect(moved.json().error.code).toBe('MARKETPLACE_SHA_MOVED');
      t.hub.shas.market = SHA2;
      t.hub.repos.market = [];
      const broken = await t.call('POST', `/${id}/accept-update`, { sha: SHA2 });
      expect(broken.statusCode).toBe(422);
      expect(t.state.sources[0]?.pinnedSha).toBe(SHA);
    });
  });

  describe('entries', () => {
    it('previews a relative entry as a single-plugin profile and surfaces MCP dependencies', async () => {
      t.hub.repos.market.push({ content: MCP, path: 'plugins/fmt/.mcp.json' });
      const { id } = await add();
      const res = await t.call('POST', `/${id}/entries/preview`, { entry: 'fmt' });
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d.manifest).toEqual({
        description: 'Formats code',
        name: 'fmt',
        plugins: ['plugins/fmt'],
      });
      expect(d.sha).toBe(SHA);
      expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.warningsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.files.map((f: { path: string }) => f.path)).toContain('plugins/fmt/commands/hi.md');
      expect(d.mcpServers).toEqual([
        { name: 'docs', supported: true, transport: 'http', url: 'https://mcp.example.com/mcp' },
        { name: 'local', supported: false, transport: 'stdio', url: null },
      ]);
      expect(d.warnings.join('\n')).toContain('local (stdio) is not supported');
      expect(d.warnings.join('\n')).toContain('mcpConnectionId');
      expect(JSON.stringify(d)).not.toContain('SECRET');
      expect(d.hasHooks).toBe(false);
      expect(d.entry).toMatchObject({ name: 'fmt', version: '1.0.0' });
      expect(d.source).toEqual({
        host: 'github.com',
        owner: 'acme',
        path: 'plugins/fmt',
        ref: 'main',
        repo: 'market',
      });
      expect(t.state.profiles).toHaveLength(0);
    });

    it('reports hooks', async () => {
      t.hub.repos.market.push({ content: '{"hooks":{}}', path: 'plugins/fmt/hooks/hooks.json' });
      const { id } = await add();
      const d = (await t.call('POST', `/${id}/entries/preview`, { entry: 'fmt' })).json().data;
      expect(d.hasHooks).toBe(true);
      expect(d.warnings.join('\n')).toContain('hooks');
    });

    it('answers unknown, non-installable and invalid entries without fetching a plugin', async () => {
      const { id } = await add();
      const before = t.fetchFn.mock.calls.length;
      const unknown = await t.call('POST', `/${id}/entries/preview`, { entry: 'nope' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('MARKETPLACE_ENTRY_NOT_FOUND');
      for (const entry of ['gitonly', 'escape']) {
        const res = await t.call('POST', `/${id}/entries/preview`, { entry });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe('MARKETPLACE_ENTRY_NOT_INSTALLABLE');
      }
      // three catalog reads (ref is pinned, so tree + file each) and no plugin folder read
      expect(t.fetchFn.mock.calls.length - before).toBe(6);
    });

    it('refuses a plugin folder that is not a valid plugin', async () => {
      t.hub.repos.market = t.hub.repos.market.filter((e) => !e.path.endsWith('plugin.json'));
      const { id } = await add();
      const res = await t.call('POST', `/${id}/entries/preview`, { entry: 'fmt' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_INVALID');
    });

    it('refuses a folder with a symlink', async () => {
      t.hub.repos.market.push({ content: 'x', mode: '120000', path: 'plugins/fmt/link' });
      const { id } = await add();
      const res = await t.call('POST', `/${id}/entries/preview`, { entry: 'fmt' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.errors?.[0] ?? res.json().error.details.errors[0]).toContain(
        'symlink'
      );
    });

    it('approve creates a pinned single-plugin profile bound to the entry, with hooksEnabled as given', async () => {
      const { id } = await add();
      const res = await approve(id, 'fmt', { hooksEnabled: false });
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({
        commitSha: SHA,
        hooksEnabled: false,
        name: 'fmt',
        version: 1,
      });
      const profile = t.state.profiles[0] as Row;
      expect(profile).toMatchObject({
        description: 'Formats code',
        hooksEnabled: false,
        host: 'github.com',
        latestVersion: 1,
        marketplaceEntry: 'fmt',
        marketplaceSourceId: id,
        owner: 'acme',
        path: 'plugins/fmt',
        ref: 'main',
        repo: 'market',
      });
      const version = t.state.versions[0] as Row;
      expect(version).toMatchObject({ approvedById: 'user-1', commitSha: SHA, version: 1 });
      const files = unpackFiles(Buffer.from(version.files as Uint8Array));
      expect(files.map((f) => f.path).sort()).toEqual([
        'plugins/fmt/.claude-plugin/plugin.json',
        'plugins/fmt/commands/hi.md',
        'profile.json',
      ]);
      expect(t.state.audit.at(-1)).toMatchObject({
        action: 'CREATE',
        entityType: 'HarnessProfile',
      });
      expect(JSON.stringify(t.state.audit.at(-1))).toContain('"hooksEnabled":false');
    });

    it('approve records hooksEnabled true when the admin chose it', async () => {
      const { id } = await add();
      await approve(id, 'fmt', { hooksEnabled: true });
      expect(t.state.profiles[0]?.hooksEnabled).toBe(true);
    });

    it('approve requires an explicit hooksEnabled', async () => {
      const { id } = await add();
      const pv = (await t.call('POST', `/${id}/entries/preview`, { entry: 'fmt' })).json().data;
      const res = await t.call('POST', `/${id}/entries/approve`, {
        contentHash: pv.contentHash,
        entry: 'fmt',
        sha: pv.sha,
        warningsHash: pv.warningsHash,
      });
      expect(res.statusCode).toBe(400);
      expect(t.state.profiles).toHaveLength(0);
    });

    it('approve refuses stale hashes with the fresh values', async () => {
      const { id } = await add();
      const res = await approve(id, 'fmt', { contentHash: 'f'.repeat(64) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PREVIEW_STALE');
      expect(res.json().error.details.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const res2 = await approve(id, 'fmt', { warningsHash: 'f'.repeat(64) });
      expect(res2.json().error.code).toBe('PREVIEW_STALE');
      expect(t.state.profiles).toHaveLength(0);
    });

    it('approve requires acknowledging warnings (the MCP warning is one)', async () => {
      t.hub.repos.market.push({ content: MCP, path: 'plugins/fmt/.mcp.json' });
      const { id } = await add();
      const res = await approve(id, 'fmt', { acknowledgeWarnings: false });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('WARNINGS_UNACKNOWLEDGED');
      expect((await approve(id, 'fmt', { acknowledgeWarnings: true })).statusCode).toBe(201);
    });

    it('approve refuses a taken name, case-insensitively', async () => {
      const { id } = await add();
      t.state.profiles.push({ id: 'p0', name: 'FMT', status: 'OK' });
      const res = await approve(id, 'fmt');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_NAME_EXISTS');
      const d = (await t.call('GET', `/${id}`)).json().data;
      expect(d.catalog.entries[0].nameTaken).toBe(true);
    });

    it('a relative entry cannot be approved at a commit other than the pinned one', async () => {
      const { id } = await add();
      const res = await approve(id, 'fmt', { sha: SHA2 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SHA_MOVED');
    });

    it('reads a GitHub entry from its own repository and binds approval to the ref commit', async () => {
      t.hub.shas.remote = 'c'.repeat(40);
      const { id } = await add();
      const pv = (await t.call('POST', `/${id}/entries/preview`, { entry: 'remote' })).json().data;
      expect(pv.sha).toBe('c'.repeat(40));
      expect(pv.source).toMatchObject({ owner: 'acme', path: '', ref: 'main', repo: 'remote' });
      const ok = await approve(id, 'remote');
      expect(ok.statusCode).toBe(201);
      expect(t.state.profiles[0]).toMatchObject({ marketplaceEntry: 'remote', repo: 'remote' });
      expect(t.state.versions[0]?.commitSha).toBe('c'.repeat(40));
      // the ref moves after the preview
      const pv2 = (await t.call('POST', `/${id}/entries/preview`, { entry: 'remote' })).json().data;
      t.state.profiles.length = 0;
      t.hub.shas.remote = 'e'.repeat(40);
      const moved = await t.call('POST', `/${id}/entries/approve`, {
        contentHash: pv2.contentHash,
        entry: 'remote',
        hooksEnabled: false,
        sha: pv2.sha,
        warningsHash: pv2.warningsHash,
      });
      expect(moved.statusCode).toBe(409);
      expect(moved.json().error.code).toBe('SHA_MOVED');
    });

    it('reads a GitHub entry that names a commit at exactly that commit', async () => {
      const { id } = await add();
      const pv = (await t.call('POST', `/${id}/entries/preview`, { entry: 'pinned' })).json().data;
      expect(pv.sha).toBe(PLUGIN_SHA);
      expect(t.fetchFn.mock.calls.some((c) => String(c[0]).includes('/pinned/commits/'))).toBe(
        false
      );
      expect((await approve(id, 'pinned')).statusCode).toBe(201);
      expect(t.state.versions[0]?.commitSha).toBe(PLUGIN_SHA);
      const wrong = await t.call('POST', `/${id}/entries/preview`, { entry: 'pinned', sha: SHA2 });
      expect(wrong.json().error.code).toBe('SHA_MOVED');
    });

    it('maps a host refusal for a GitHub entry to the profile flow codes', async () => {
      t.hub.repos.market = [
        {
          content: JSON.stringify({
            name: 'm',
            plugins: [{ name: 'x', source: { repo: 'a/b', source: 'github' } }],
          }),
          path: '.claude-plugin/marketplace.json',
        },
      ];
      const { id } = await add();
      t.hub.repos.b = [];
      const res = await t.call('POST', `/${id}/entries/preview`, { entry: 'x' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_INVALID');
    });
  });
});
