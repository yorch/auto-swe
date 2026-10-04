import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';
import type { SkillSourceDeps } from './skillSource/index.js';
import { checkSkillSource, sweepSkillSources } from './skillSourceSync.js';

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
    expect(result.skipped).toBe(1);
    expect(result.sources.find((s) => s.id === 'a')).toMatchObject({
      error: "the host's API rate limit is nearly spent; try again later",
      status: 'ERROR',
    });
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
