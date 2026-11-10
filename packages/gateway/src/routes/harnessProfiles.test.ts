import { createHash } from 'node:crypto';
import { unpackFiles } from '@auto-swe/shared/lib/harnessProfile';
import type { SkillSourceDeps } from '@auto-swe/shared/lib/skillSource';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessProfileRoutes } from './harnessProfiles.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const blobId = (b: Buffer) =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

const profileJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    description: 'Demo profile',
    instructions: 'INSTRUCTIONS.md',
    name: 'demo',
    ...over,
  });

const BASE = [
  { content: profileJson(), path: 'p/profile.json' },
  { content: '# Be careful\n', path: 'p/INSTRUCTIONS.md' },
];
const WITH_HOOKS = [
  { content: profileJson({ plugins: ['plugins/a'] }), path: 'p/profile.json' },
  { content: '# Be careful\n', path: 'p/INSTRUCTIONS.md' },
  { content: '{"name":"a"}', path: 'p/plugins/a/.claude-plugin/plugin.json' },
  { content: '{}', path: 'p/plugins/a/hooks/hooks.json' },
];

type Entry = { content: string; path: string; mode?: string };

/** A fake GitHub holding one repository whose ref can move. */
function fakeHub(state: { entries: Entry[]; sha: string }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const tree = state.entries.map((e) => {
      const b = Buffer.from(e.content);
      return {
        mode: e.mode ?? '100644',
        path: e.path,
        sha: blobId(b),
        size: b.length,
        type: 'blob',
      };
    });
    if (u.includes('/commits/')) {
      return ok({ sha: state.sha });
    }
    if (u.includes('/git/trees/')) {
      return ok({ tree, truncated: false });
    }
    const m = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    const e = state.entries.find((x) => blobId(Buffer.from(x.content)) === m?.[1]);
    return e
      ? ok({ content: Buffer.from(e.content).toString('base64'), encoding: 'base64' })
      : new Response('{}', { status: 404 });
  });
}

type Row = Record<string, unknown> & { id: string };

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN', scanHits: string[] = []) {
  const hub = { entries: [...BASE] as Entry[], sha: SHA };
  const state = { audit: [] as Row[], profiles: [] as Row[], versions: [] as Row[] };
  let seq = 0;
  const id = () => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`;

  const versionOut = (v: Row, select?: Record<string, unknown>) => {
    if (!select) {
      return { ...v };
    }
    return Object.fromEntries(Object.keys(select).map((k) => [k, v[k]]));
  };
  const profileOut = (p: Row, args: { select?: Record<string, unknown> }) => {
    const out: Record<string, unknown> = { ...p };
    const vs = args.select?.versions as { select?: Record<string, unknown> } | undefined;
    if (vs) {
      out.versions = state.versions
        .filter((v) => v.profileId === p.id)
        .sort((a, b) => (b.version as number) - (a.version as number))
        .map((v) => versionOut(v, vs.select));
    }
    return out;
  };

  const profileModel = {
    create: vi.fn(async ({ data, ...args }: { data: Record<string, unknown> }) => {
      if (state.profiles.some((p) => p.name === data.name)) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const { versions, ...rest } = data as { versions?: { create: Record<string, unknown> } };
      const row = {
        createdAt: new Date(0),
        id: id(),
        status: 'OK',
        updatedAt: new Date(0),
        ...rest,
      } as Row;
      state.profiles.push(row);
      if (versions) {
        state.versions.push({
          createdAt: new Date(0),
          id: id(),
          profileId: row.id,
          ...versions.create,
        });
      }
      return profileOut(row, args as never);
    }),
    findMany: vi.fn(
      async ({
        select,
        where,
      }: {
        select?: Record<string, unknown>;
        where?: { name?: { equals: string } };
      } = {}) =>
        state.profiles
          .filter(
            (p) => !where?.name || String(p.name).toLowerCase() === where.name.equals.toLowerCase()
          )
          .map((p) =>
            select ? Object.fromEntries(Object.keys(select).map((k) => [k, p[k]])) : { ...p }
          )
    ),
    findUnique: vi.fn(
      async (args: { where: { name: string }; select?: Record<string, unknown> }) => {
        const p = state.profiles.find((x) => x.name === args.where.name);
        return p ? profileOut(p, args) : null;
      }
    ),
    update: vi.fn(
      async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const p = state.profiles.find((x) => x.id === where.id) as Row;
        Object.assign(p, data);
        return { ...p };
      }
    ),
    updateMany: vi.fn(
      async ({
        data,
        where,
      }: {
        data: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        const p = state.profiles.find(
          (x) =>
            x.id === where.id &&
            x.latestVersion === where.latestVersion &&
            x.status === where.status
        );
        if (!p) {
          return { count: 0 };
        }
        Object.assign(p, data);
        return { count: 1 };
      }
    ),
  };
  const versionModel = {
    create: vi.fn(async ({ data, select }: { data: Row; select?: Record<string, unknown> }) => {
      const row = { createdAt: new Date(0), ...data, id: id() } as Row;
      state.versions.push(row);
      return versionOut(row, select);
    }),
    findFirst: vi.fn(async ({ where }: { where: { contentHash: string; profileId: string } }) => {
      const v = state.versions.find(
        (x) => x.contentHash === where.contentHash && x.profileId === where.profileId
      );
      return v ? { version: v.version } : null;
    }),
    findMany: vi.fn(async () => state.versions.map((v) => ({ ...v }))),
    findUnique: vi.fn(
      async ({
        where,
      }: {
        where: { profileId_version: { profileId: string; version: number } };
      }) => {
        const k = where.profileId_version;
        return (
          state.versions.find((v) => v.profileId === k.profileId && v.version === k.version) ?? null
        );
      }
    ),
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snap = {
        audit: [...state.audit],
        profiles: state.profiles.map((p) => ({ ...p })),
        versions: [...state.versions],
      };
      try {
        return await cb(prisma);
      } catch (err) {
        state.audit.splice(0, state.audit.length, ...snap.audit);
        state.profiles.splice(0, state.profiles.length, ...snap.profiles);
        state.versions.splice(0, state.versions.length, ...snap.versions);
        throw err;
      }
    }),
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audit.push({ id: id(), ...data });
        return {};
      }),
    },
    harnessProfile: profileModel,
    harnessProfileVersion: versionModel,
  };

  const fetchFn = fakeHub(hub);
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
    shell: vi.fn(async () => ({ hits: scanHits, incomplete: false })),
    text: vi.fn(async () => ({ hits: scanHits, incomplete: false })),
  };

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(harnessProfileRoutes, {
    prefix: '/api/v1/platform',
    readDeps: { scanners, source },
  });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/harness-profiles${url}`,
    });
  const ZERO = '0'.repeat(64);
  /** Hashes as the preview shows them now (placeholders when the preview itself is refused). */
  const hashesFrom = async (url: string, payload: unknown) => {
    const res = await call('POST', url, payload);
    const data = res.statusCode === 200 ? res.json().data : null;
    return { contentHash: data?.contentHash ?? ZERO, warningsHash: data?.warningsHash ?? ZERO };
  };
  /** Create / accept the way a client does: previewed hashes plus the previewed sha. */
  const create = async (extra: Record<string, unknown> = {}) =>
    call('POST', '', {
      ...LOC,
      ...(await hashesFrom('/preview', LOC)),
      sha: SHA,
      ...extra,
    });
  const accept = async (extra: Record<string, unknown> = {}) =>
    call('POST', '/demo/accept', {
      ...(await hashesFrom('/demo/preview-update', { sha: SHA2 })),
      sha: SHA2,
      ...extra,
    });
  return { accept, call, create, fetchFn, hub, prisma, state };
}

const LOC = { owner: 'acme', path: 'p', ref: 'main', repo: 'profiles' };

describe('harness profile routes', () => {
  let t: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    t = await buildApp();
  });

  it.each([
    ['GET', ''],
    ['GET', '/demo'],
    ['POST', '/preview'],
    ['POST', ''],
    ['POST', '/demo/preview-update'],
    ['POST', '/demo/accept'],
    ['PATCH', '/demo'],
  ] as const)('refuses a non-admin on %s %s', async (method, url) => {
    const engineer = await buildApp('ENGINEER');
    const res = await engineer.call(
      method,
      url,
      method === 'GET' ? undefined : { ...LOC, sha: SHA, status: 'OK' }
    );
    expect(res.statusCode).toBe(403);
    expect(engineer.fetchFn).not.toHaveBeenCalled();
    expect(engineer.prisma.harnessProfile.create).not.toHaveBeenCalled();
  });

  it('has no DELETE route', async () => {
    expect((await t.call('DELETE', '/demo')).statusCode).toBe(404);
  });

  describe('preview', () => {
    it('returns the manifest, files, sha, hash and conflicts without writing', async () => {
      const res = await t.call('POST', '/preview', LOC);
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data).toMatchObject({
        conflicts: [],
        manifest: { name: 'demo' },
        matchesVersion: null,
        sha: SHA,
        source: { host: 'github.com', owner: 'acme', path: 'p', ref: 'main', repo: 'profiles' },
        warnings: [],
      });
      expect(data.files).toEqual([
        { mode: '100644', path: 'INSTRUCTIONS.md', size: 13 },
        { mode: '100644', path: 'profile.json', size: expect.any(Number) },
      ]);
      expect(data.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain('Be careful');
      expect(t.prisma.harnessProfile.create).not.toHaveBeenCalled();
      expect(t.state.audit).toEqual([]);
    });

    it('lists a case-insensitive name conflict', async () => {
      t.state.profiles.push({ id: 'x', name: 'DEMO', status: 'DISABLED' });
      const res = await t.call('POST', '/preview', LOC);
      expect(res.json().data.conflicts).toEqual([{ name: 'DEMO', status: 'DISABLED' }]);
    });

    it('warns about hooks, and about scanner hits', async () => {
      t.hub.entries = WITH_HOOKS;
      const res = await t.call('POST', '/preview', LOC);
      expect(res.json().data.warnings.join('\n')).toContain(
        'hooks run commands inside the run container'
      );
      const flagged = await buildApp('ADMIN', ['injection:override']);
      const hit = await flagged.call('POST', '/preview', LOC);
      expect(hit.json().data.warnings).toContain(
        'INSTRUCTIONS.md: text pattern injection:override'
      );
    });

    it('returns one file for review, with a binary marker and a size cap', async () => {
      t.hub.entries = [
        ...BASE,
        { content: 'x'.repeat(250_000), path: 'p/big.txt' },
        { content: 'a\0b', path: 'p/bin.dat' },
      ];
      const text = await t.call('POST', '/preview', { ...LOC, file: 'INSTRUCTIONS.md', sha: SHA });
      expect(text.json().data).toMatchObject({
        binary: false,
        text: '# Be careful\n',
        truncated: false,
      });
      const big = await t.call('POST', '/preview', { ...LOC, file: 'big.txt', sha: SHA });
      expect(big.json().data.truncated).toBe(true);
      expect(big.json().data.text).toHaveLength(200_000);
      const bin = await t.call('POST', '/preview', { ...LOC, file: 'bin.dat', sha: SHA });
      expect(bin.json().data).toMatchObject({ binary: true, text: null });
      expect(
        (await t.call('POST', '/preview', { ...LOC, file: 'nope', sha: SHA })).statusCode
      ).toBe(404);
      expect((await t.call('POST', '/preview', { ...LOC, file: 'big.txt' })).statusCode).toBe(400);
    });

    it('downloads only the reviewed blob, not the folder', async () => {
      t.hub.entries = [...BASE, { content: 'x'.repeat(10), path: 'p/other.txt' }];
      const res = await t.call('POST', '/preview', { ...LOC, file: 'other.txt', sha: SHA });
      expect(res.json().data).toMatchObject({ text: 'x'.repeat(10) });
      const urls = t.fetchFn.mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u.includes('/git/blobs/'))).toHaveLength(1);
      expect(urls.some((u) => u.includes('/commits/'))).toBe(false);
    });

    it('answers 422 with the reasons for an invalid folder', async () => {
      t.hub.entries = [...BASE, { content: 'target', mode: '120000', path: 'p/link' }];
      const res = await t.call('POST', '/preview', LOC);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({
        code: 'HARNESS_PROFILE_INVALID',
        details: { errors: ['symlink not allowed: link'] },
      });
    });

    it('answers with fixed codes for fetch refusals', async () => {
      const res = await t.call('POST', '/preview', { ...LOC, host: 'evil.example.com' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_HOST_NOT_APPROVED');
    });
  });

  describe('create', () => {
    it('stores the profile and version 1 at the previewed commit, and audits it', async () => {
      const res = await t.create();
      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data).toMatchObject({
        latestVersion: 1,
        name: 'demo',
        status: 'OK',
        versions: [{ commitSha: SHA, fileCount: 2, version: 1 }],
      });
      const stored = t.state.versions[0] as Row;
      expect(unpackFiles(stored.files as Uint8Array).map((f) => f.path)).toEqual([
        'INSTRUCTIONS.md',
        'profile.json',
      ]);
      expect(JSON.stringify(data)).not.toContain('Be careful');
      expect(t.state.audit).toHaveLength(1);
      expect(t.state.audit[0]).toMatchObject({
        action: 'CREATE',
        actorId: 'user-1',
        entityType: 'HarnessProfile',
      });
    });

    it('refuses 400 (validation) without the preview hashes', async () => {
      for (const body of [
        { ...LOC, sha: SHA },
        { ...LOC, contentHash: 'f'.repeat(64), sha: SHA },
        { ...LOC, sha: SHA, warningsHash: 'f'.repeat(64) },
      ]) {
        expect((await t.call('POST', '', body)).statusCode).toBe(400);
      }
      expect(t.state.profiles).toEqual([]);
    });

    it('refuses 409 PREVIEW_STALE with fresh values when the content changed after the preview', async () => {
      const preview = (await t.call('POST', '/preview', LOC)).json().data;
      t.hub.entries = [BASE[0] as Entry, { content: '# Swapped\n', path: 'p/INSTRUCTIONS.md' }];
      const res = await t.call('POST', '', {
        ...LOC,
        contentHash: preview.contentHash,
        sha: SHA,
        warningsHash: preview.warningsHash,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PREVIEW_STALE');
      expect(res.json().error.details.contentHash).not.toBe(preview.contentHash);
      expect(t.state.profiles).toEqual([]);
    });

    it('refuses 409 PREVIEW_STALE even with acknowledgeWarnings when the warnings changed', async () => {
      const preview = (await t.call('POST', '/preview', LOC)).json().data;
      expect(preview.warnings).toEqual([]);
      // Same commit and content, but the scanner now reports something.
      const scanned = await buildApp('ADMIN', ['injection:override']);
      const res = await scanned.call('POST', '', {
        ...LOC,
        acknowledgeWarnings: true,
        contentHash: preview.contentHash,
        sha: SHA,
        warningsHash: preview.warningsHash,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PREVIEW_STALE');
      expect(res.json().error.details.warnings.length).toBeGreaterThan(0);
      expect(scanned.state.profiles).toEqual([]);
    });

    it('maps a database unique violation (case-insensitive race) to the same 409', async () => {
      t.prisma.harnessProfile.findMany.mockResolvedValueOnce([]);
      t.prisma.harnessProfile.create.mockRejectedValueOnce(
        Object.assign(new Error('unique'), { code: 'P2002' })
      );
      const res = await t.create();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_NAME_EXISTS');
    });

    it('refuses 409 SHA_MOVED when the ref moved since the preview', async () => {
      t.hub.sha = SHA2;
      const res = await t.create();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SHA_MOVED');
      expect(t.state.profiles).toEqual([]);
    });

    it('needs acknowledgeWarnings when there are warnings', async () => {
      t.hub.entries = WITH_HOOKS;
      const refused = await t.create();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('WARNINGS_UNACKNOWLEDGED');
      expect(refused.json().error.details.warnings.length).toBeGreaterThan(0);
      expect(t.state.profiles).toEqual([]);
      const ok = await t.create({ acknowledgeWarnings: true });
      expect(ok.statusCode).toBe(201);
      expect((t.state.versions[0] as Row).scanWarnings).toEqual(
        expect.arrayContaining([expect.stringContaining('hooks run commands')])
      );
    });

    it('refuses a duplicate name, in any case', async () => {
      await t.create();
      const again = await t.create();
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('HARNESS_PROFILE_NAME_EXISTS');
      t.hub.entries = [
        { content: profileJson({ instructions: undefined, name: 'DEMO' }), path: 'p/profile.json' },
      ];
      const upper = await t.create();
      expect(upper.statusCode).toBe(409);
      expect(t.state.profiles).toHaveLength(1);
    });

    it('refuses an invalid folder', async () => {
      t.hub.entries = [{ content: '{}', path: 'p/profile.json' }];
      const res = await t.create();
      expect(res.statusCode).toBe(422);
      expect(t.state.profiles).toEqual([]);
    });
  });

  describe('list and get', () => {
    it('lists profiles with their latest version and never the files', async () => {
      await t.create();
      const list = await t.call('GET', '');
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toEqual([
        expect.objectContaining({
          latest: expect.objectContaining({ commitSha: SHA, version: 1 }),
          name: 'demo',
        }),
      ]);
      expect(JSON.stringify(list.json())).not.toContain('"files"');
      const one = await t.call('GET', '/demo');
      expect(one.json().data.versions).toHaveLength(1);
      expect(one.json().data.versions[0].files).toHaveLength(2);
      expect((await t.call('GET', '/missing')).statusCode).toBe(404);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await t.create();
      t.hub.entries = [BASE[0] as Entry, { content: '# Newer\n', path: 'p/INSTRUCTIONS.md' }];
      t.hub.sha = SHA2;
    });

    it('previews the profile source again and says when content already exists as a version', async () => {
      const res = await t.call('POST', '/demo/preview-update', {});
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ matchesVersion: null, sha: SHA2 });
      t.hub.entries = [...BASE];
      const same = await t.call('POST', '/demo/preview-update', {});
      expect(same.json().data.matchesVersion).toBe(1);
      expect((await t.call('POST', '/missing/preview-update', {})).statusCode).toBe(404);
    });

    it('accepts a new immutable version and audits it', async () => {
      const res = await t.accept();
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({ commitSha: SHA2, version: 2 });
      expect(t.state.versions).toHaveLength(2);
      expect((t.state.versions[0] as Row).commitSha).toBe(SHA);
      expect((t.state.profiles[0] as Row).latestVersion).toBe(2);
      expect(t.state.audit.at(-1)).toMatchObject({
        action: 'UPDATE',
        entityType: 'HarnessProfile',
      });
    });

    it('refuses SHA_MOVED, unchanged content, a renamed manifest and unacknowledged warnings', async () => {
      t.hub.sha = 'c'.repeat(40);
      expect((await t.accept()).json().error.code).toBe('SHA_MOVED');
      t.hub.sha = SHA2;

      t.hub.entries = [...BASE];
      expect((await t.accept()).json().error.code).toBe('HARNESS_PROFILE_NO_CHANGE');

      t.hub.entries = [
        { content: profileJson({ name: 'other' }), path: 'p/profile.json' },
        BASE[1] as Entry,
      ];
      const renamed = await t.accept();
      expect(renamed.statusCode).toBe(422);

      t.hub.entries = WITH_HOOKS;
      const warn = await t.accept();
      expect(warn.json().error.code).toBe('WARNINGS_UNACKNOWLEDGED');
      expect(t.state.versions).toHaveLength(1);
      expect((await t.accept({ acknowledgeWarnings: true })).statusCode).toBe(201);
    });

    it('refuses accept without hashes (400) and with stale ones (409 PREVIEW_STALE)', async () => {
      expect((await t.call('POST', '/demo/accept', { sha: SHA2 })).statusCode).toBe(400);
      const stale = await t.accept({ contentHash: 'f'.repeat(64) });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('PREVIEW_STALE');
      const staleWarnings = await t.accept({ warningsHash: 'f'.repeat(64) });
      expect(staleWarnings.json().error.code).toBe('PREVIEW_STALE');
      expect(t.state.versions).toHaveLength(1);
    });

    it('answers 409 when another accept took the version number', async () => {
      t.prisma.harnessProfile.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await t.accept();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HARNESS_PROFILE_CHANGED');
      expect(t.state.versions).toHaveLength(1);
    });
  });

  describe('disable', () => {
    beforeEach(async () => {
      await t.create();
    });

    it('disables and re-enables with an audit entry; a disabled profile takes no new version', async () => {
      const off = await t.call('PATCH', '/demo', { status: 'DISABLED' });
      expect(off.statusCode).toBe(200);
      expect(off.json().data).toMatchObject({ name: 'demo', status: 'DISABLED' });
      expect(t.state.audit.at(-1)).toMatchObject({
        action: 'UPDATE',
        afterJson: { name: 'demo', status: 'DISABLED' },
        beforeJson: { name: 'demo', status: 'OK' },
        entityType: 'HarnessProfile',
      });
      t.hub.sha = SHA2;
      t.hub.entries = [BASE[0] as Entry, { content: '# Newer\n', path: 'p/INSTRUCTIONS.md' }];
      const accept = await t.accept();
      expect(accept.statusCode).toBe(409);
      expect(accept.json().error.code).toBe('HARNESS_PROFILE_DISABLED');
      expect((await t.call('PATCH', '/demo', { status: 'OK' })).json().data.status).toBe('OK');
      expect((await t.call('PATCH', '/demo', { status: 'GONE' })).statusCode).toBe(400);
      expect((await t.call('PATCH', '/missing', { status: 'OK' })).statusCode).toBe(404);
    });
  });
});
