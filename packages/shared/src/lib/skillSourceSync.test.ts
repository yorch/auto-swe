import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import type { SkillSourceDeps } from './skillSource/index.js';
import {
  checkHarnessProfile,
  checkSkillSource,
  sweepHarnessProfiles,
  sweepSkillSources,
} from './skillSourceSync.js';

const SHA = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const TOKEN = 'ghp_SECRET-TOKEN-9876';

type Row = {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  pinnedSha: string;
  status: string;
  latestSha: string | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  host: 'github.com',
  id,
  lastCheckedAt: null,
  lastError: null,
  latestSha: SHA,
  owner: id,
  path: '',
  pinnedSha: SHA,
  ref: 'main',
  repo: 'skills',
  status: 'OK',
  ...over,
});

/** `replies`: owner → what the fake host answers for that source's commit lookup. */
function fake(rows: Row[], replies: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const updates: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }> = [];
  const prisma = {
    skill: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    skillRevision: { create: vi.fn() },
    skillSource: {
      findMany: vi.fn(async ({ where }: { where: { status: { not: string } } }) =>
        rows.filter((r) => r.status !== where.status.not).map((r) => ({ ...r }))
      ),
      update: vi.fn(
        async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
          updates.push(args);
          const r = rows.find((x) => x.id === args.where.id);
          if (!r || r.pinnedSha !== args.where.pinnedSha || r.status === 'DISABLED') {
            throw Object.assign(new Error('no row'), { code: 'P2025' });
          }
          Object.assign(r, args.data);
          return { ...r };
        }
      ),
    },
  };
  const deps: SkillSourceDeps = {
    approvedHosts: async () => [],
    fetch: (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const owner = /\/repos\/([^/]+)\//.exec(u)?.[1] as string;
      const reply = replies[owner];
      if (!reply) {
        return new Response('{}', { status: 404 });
      }
      return reply();
    }) as typeof fetch,
    githubConfig: (async () => ({
      apiUrl: 'https://api.github.com',
      baseUrl: 'https://github.com',
    })) as unknown as SkillSourceDeps['githubConfig'],
    githubToken: (async () => TOKEN) as SkillSourceDeps['githubToken'],
    platformCredential: (async () => ({
      config: {},
      scope: 'instance',
    })) as unknown as SkillSourceDeps['platformCredential'],
    privateNetworkHosts: async () => [],
  };
  return {
    calls,
    deps,
    prisma: prisma as unknown as PrismaClient,
    rawPrisma: prisma,
    rows,
    updates,
  };
}

const commit = (sha: string, headers?: Record<string, string>) => () =>
  new Response(JSON.stringify({ sha }), { headers, status: 200 });

describe('checkSkillSource', () => {
  it('OK when the ref still names the pinned commit', async () => {
    const f = fake([row('a')], { a: commit(SHA) });
    const result = await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(result).toMatchObject({ error: null, latestSha: SHA, recorded: true, status: 'OK' });
    expect(f.rows[0]).toMatchObject({ lastError: null, status: 'OK' });
    expect(f.rows[0]?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('UPDATE_AVAILABLE with the new sha when the ref moved', async () => {
    const f = fake([row('a')], { a: commit(NEW) });
    await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(f.rows[0]).toMatchObject({ latestSha: NEW, pinnedSha: SHA, status: 'UPDATE_AVAILABLE' });
  });

  it('resolves the sha only: one request, no tree, no blob', async () => {
    const f = fake([row('a')], { a: commit(NEW) });
    await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('/commits/main');
  });

  it('ERROR with a fixed string, keeping the last known latestSha', async () => {
    const f = fake([row('a', { latestSha: NEW, status: 'UPDATE_AVAILABLE' })], {
      a: () => new Response(`secret ${TOKEN} echoed`, { status: 500 }),
    });
    const result = await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(result.status).toBe('ERROR');
    expect(result.error).toBe('the host returned an error (HTTP 500)');
    expect(f.rows[0]).toMatchObject({
      lastError: 'the host returned an error (HTTP 500)',
      latestSha: NEW,
      status: 'ERROR',
    });
    expect(JSON.stringify([result, f.rows])).not.toContain(TOKEN);
  });

  it('never leaks raw error text from a thrown fetch error', async () => {
    const f = fake([row('a')], {
      a: () => {
        throw new Error(`connect failed Authorization: Bearer ${TOKEN}`);
      },
    });
    const result = await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(result.status).toBe('ERROR');
    expect(JSON.stringify([result, f.rows])).not.toContain(TOKEN);
    expect(result.error).toMatch(/^request failed/);
  });

  it('drops its write when the source was disabled or accepted while it asked', async () => {
    const f = fake([row('a')], {
      a: () => {
        // The admin disables the source while the host is being asked.
        (f.rows[0] as Row).status = 'DISABLED';
        return new Response(JSON.stringify({ sha: NEW }), { status: 200 });
      },
    });
    const result = await checkSkillSource(f.prisma, { ...(f.rows[0] as Row) }, f.deps);
    expect(result.recorded).toBe(false);
    expect(f.rows[0]).toMatchObject({ latestSha: SHA, status: 'DISABLED' });
  });

  it('only ever writes the source bookkeeping columns', async () => {
    const f = fake([row('a')], { a: commit(NEW) });
    await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(Object.keys(f.updates[0]?.data ?? {}).sort()).toEqual(
      ['lastCheckedAt', 'lastError', 'latestSha', 'status'].sort()
    );
    expect(f.rawPrisma.skill.create).not.toHaveBeenCalled();
    expect(f.rawPrisma.skill.update).not.toHaveBeenCalled();
    expect(f.rawPrisma.skillRevision.create).not.toHaveBeenCalled();
  });
});

describe('sweepSkillSources', () => {
  it('flags OK, UPDATE_AVAILABLE and ERROR in one pass, and skips DISABLED sources', async () => {
    const f = fake([row('ok'), row('moved'), row('broken'), row('off', { status: 'DISABLED' })], {
      broken: () => new Response('{}', { status: 404 }),
      moved: commit(NEW),
      off: commit(NEW),
      ok: commit(SHA),
    });
    const result = await sweepSkillSources(f.prisma, f.deps);
    expect(result).toMatchObject({ checked: 3, errors: 1, ok: 1, skipped: 0, updateAvailable: 1 });
    expect(result.sources.map((s) => [s.id, s.status])).toEqual(
      expect.arrayContaining([
        ['ok', 'OK'],
        ['moved', 'UPDATE_AVAILABLE'],
        ['broken', 'ERROR'],
      ])
    );
    // The disabled source was never asked and never touched.
    expect(f.calls.some((u) => u.includes('/off/'))).toBe(false);
    expect(f.rows.find((r) => r.id === 'off')).toMatchObject({
      latestSha: SHA,
      status: 'DISABLED',
    });
    // Never any skill or revision write.
    expect(f.rawPrisma.skill.update).not.toHaveBeenCalled();
    expect(f.rawPrisma.skillRevision.create).not.toHaveBeenCalled();
  });

  it('one failing source never stops the others', async () => {
    const f = fake([row('a'), row('b'), row('c')], {
      a: () => {
        throw new Error('boom');
      },
      b: commit(NEW),
      c: commit(SHA),
    });
    const result = await sweepSkillSources(f.prisma, f.deps);
    expect(result).toMatchObject({ checked: 3, errors: 1, ok: 1, updateAvailable: 1 });
  });

  it('a database failure on one row is isolated and carries no raw text', async () => {
    const f = fake([row('a'), row('b')], { a: commit(NEW), b: commit(NEW) });
    f.rawPrisma.skillSource.update.mockRejectedValueOnce(
      new Error(`password authentication failed for ${TOKEN}`)
    );
    const result = await sweepSkillSources(f.prisma, f.deps);
    expect(result.checked).toBe(2);
    expect(result.errors).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(f.rows.find((r) => r.id === 'b')?.status).toBe('UPDATE_AVAILABLE');
  });

  it("stops asking a host once its rate limit is low, and leaves that host's sources for later", async () => {
    const f = fake([row('a'), row('b'), row('c', { host: 'ghe.example.com' })], {
      a: commit(NEW, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '10' }),
      b: commit(NEW),
      c: commit(NEW),
    });
    f.deps.approvedHosts = async () => ['ghe.example.com'];
    const result = await sweepSkillSources(f.prisma, f.deps);
    // github.com: the first answer reports the floor was crossed, so the second is not asked.
    expect(f.calls.some((u) => u.includes('/b/'))).toBe(false);
    // a (rate-limit answer) and b (host spent) are skipped; only the other host's c counts.
    expect(result).toMatchObject({ checked: 1, errors: 0, skipped: 2, updateAvailable: 1 });
    expect(result.sources.find((s) => s.id === 'a')).toMatchObject({
      error: "the host's API rate limit is nearly spent; try again later",
      status: 'SKIPPED',
    });
    // Neither skipped source was recorded as broken, and a keeps its flag and latestSha.
    expect(f.rows.find((r) => r.id === 'a')).toMatchObject({ latestSha: SHA, status: 'OK' });
    expect(f.rows.find((r) => r.id === 'b')?.lastCheckedAt).toBeNull();
  });

  it('a rate-limit answer keeps UPDATE_AVAILABLE and latestSha, moving only lastCheckedAt', async () => {
    const f = fake([row('a', { latestSha: NEW, status: 'UPDATE_AVAILABLE' })], {
      a: commit(NEW, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '10' }),
    });
    const result = await checkSkillSource(f.prisma, f.rows[0] as Row, f.deps);
    expect(result).toMatchObject({ code: 'RATE_LIMIT_LOW', recorded: true, status: 'SKIPPED' });
    expect(f.rows[0]).toMatchObject({
      lastError: null,
      latestSha: NEW,
      status: 'UPDATE_AVAILABLE',
    });
    expect(f.rows[0]?.lastCheckedAt).toBeInstanceOf(Date);
    expect(Object.keys(f.updates[0]?.data ?? {})).toEqual(['lastCheckedAt']);
  });

  it('a result carries ids, statuses and fixed strings only', async () => {
    const f = fake([row('a')], {
      a: () => new Response(`Bearer ${TOKEN}`, { status: 502 }),
    });
    const result = await sweepSkillSources(f.prisma, f.deps);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(Object.keys(result.sources[0] ?? {}).sort()).toEqual(['error', 'id', 'status']);
  });
});

type ProfileRow = {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  status: string;
  latestVersion: number;
  versions: Array<{ version: number; commitSha: string }>;
  latestSha: string | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
  trackStatus: string;
};

const profile = (id: string, over: Partial<ProfileRow> = {}): ProfileRow => ({
  host: 'github.com',
  id,
  lastCheckedAt: null,
  lastError: null,
  latestSha: SHA,
  latestVersion: 2,
  owner: id,
  path: 'p',
  ref: 'main',
  repo: 'profiles',
  status: 'OK',
  trackStatus: 'OK',
  versions: [
    { commitSha: 'c'.repeat(40), version: 1 },
    { commitSha: SHA, version: 2 },
  ],
  ...over,
});

function fakeProfiles(
  rows: ProfileRow[],
  replies: Record<string, () => Response | Promise<Response>>
) {
  const base = fake([], replies);
  const prisma = {
    harnessProfile: {
      findMany: vi.fn(async ({ where }: { where: { status: { not: string } } }) =>
        rows.filter((r) => r.status !== where.status.not).map((r) => ({ ...r }))
      ),
      update: vi.fn(
        async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
          const r = rows.find((x) => x.id === args.where.id);
          if (!r || r.latestVersion !== args.where.latestVersion || r.status === 'DISABLED') {
            throw Object.assign(new Error('no row'), { code: 'P2025' });
          }
          Object.assign(r, args.data);
          return { ...r };
        }
      ),
    },
  };
  return { deps: base.deps, prisma: prisma as unknown as PrismaClient, rows };
}

describe('checkHarnessProfile', () => {
  const input = (r: ProfileRow) => ({ ...r, pinnedSha: SHA });

  it('records OK, UPDATE_AVAILABLE and the new sha on the profile row only', async () => {
    const f = fakeProfiles([profile('a')], { a: commit(SHA) });
    const same = await checkHarnessProfile(f.prisma, input(f.rows[0] as ProfileRow), f.deps);
    expect(same).toMatchObject({ error: null, recorded: true, status: 'OK' });
    const moved = fakeProfiles([profile('a')], { a: commit(NEW) });
    await checkHarnessProfile(moved.prisma, input(moved.rows[0] as ProfileRow), moved.deps);
    expect(moved.rows[0]).toMatchObject({
      lastError: null,
      latestSha: NEW,
      trackStatus: 'UPDATE_AVAILABLE',
    });
    expect(moved.rows[0]?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('records ERROR with a fixed string, never upstream text, and keeps the last sha', async () => {
    const f = fakeProfiles([profile('a')], {
      a: () => new Response(`Bearer ${TOKEN}`, { status: 502 }),
    });
    const result = await checkHarnessProfile(f.prisma, input(f.rows[0] as ProfileRow), f.deps);
    expect(result.status).toBe('ERROR');
    expect(JSON.stringify(f.rows[0])).not.toContain(TOKEN);
    expect(f.rows[0]).toMatchObject({ latestSha: SHA, trackStatus: 'ERROR' });
    expect(typeof f.rows[0]?.lastError).toBe('string');
  });

  it('drops the write when a newer version was accepted while the host was asked', async () => {
    const f = fakeProfiles([profile('a')], { a: commit(NEW) });
    const stale = { ...input(f.rows[0] as ProfileRow), latestVersion: 1 };
    const result = await checkHarnessProfile(f.prisma, stale, f.deps);
    expect(result).toMatchObject({ recorded: false, status: 'UPDATE_AVAILABLE' });
    expect(f.rows[0]?.trackStatus).toBe('OK');
  });
});

describe('sweepHarnessProfiles', () => {
  it('checks every profile that is not disabled against its latest version commit', async () => {
    const f = fakeProfiles([profile('a'), profile('b'), profile('c', { status: 'DISABLED' })], {
      a: commit(SHA),
      b: commit(NEW),
    });
    const result = await sweepHarnessProfiles(f.prisma, f.deps);
    expect(result).toMatchObject({ checked: 2, errors: 0, ok: 1, skipped: 0, updateAvailable: 1 });
    expect(f.rows[1]).toMatchObject({ latestSha: NEW, trackStatus: 'UPDATE_AVAILABLE' });
    expect(f.rows[2]?.lastCheckedAt).toBeNull();
    expect(Object.keys(result.profiles[0] ?? {}).sort()).toEqual(['error', 'id', 'status']);
  });

  it('leaves the rest of a host for the next run once its rate limit runs low', async () => {
    const f = fakeProfiles([profile('a'), profile('b')], {
      a: commit(NEW, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '10' }),
      b: commit(NEW),
    });
    const result = await sweepHarnessProfiles(f.prisma, f.deps);
    expect(result).toMatchObject({ checked: 0, skipped: 2 });
    expect(f.rows.map((r) => r.trackStatus)).toEqual(['OK', 'OK']);
    expect(f.rows[0]?.latestSha).toBe(SHA);
  });

  it('survives a profile whose row cannot be written', async () => {
    const f = fakeProfiles([profile('a'), profile('b')], { a: commit(SHA), b: commit(NEW) });
    (f.prisma.harnessProfile.update as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db down: secret')
    );
    const result = await sweepHarnessProfiles(f.prisma, f.deps);
    expect(result.errors).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.rows[1]?.trackStatus).toBe('UPDATE_AVAILABLE');
  });
});
