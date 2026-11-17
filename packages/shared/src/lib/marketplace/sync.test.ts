import { describe, expect, it, vi } from 'vitest';
import type { SkillSourceDeps } from '../skillSource/index.js';
import { checkMarketplaceSource, sweepMarketplaceSources } from './sync.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const source = (over: Record<string, unknown> = {}) => ({
  host: 'github.com',
  id: 's1',
  owner: 'acme',
  path: '',
  pinnedSha: A,
  ref: 'main',
  repo: 'market',
  ...over,
});

function deps(respond: (url: string) => Response | Promise<Response>): SkillSourceDeps {
  return {
    approvedHosts: async () => [],
    fetch: vi.fn(async (u: string | URL | Request) =>
      respond(String(u))
    ) as unknown as typeof fetch,
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
}
const commit = (sha: string) => new Response(JSON.stringify({ sha }), { status: 200 });

const prismaWith = (rows: unknown[], update = vi.fn(async () => ({}))) =>
  ({ marketplaceSource: { findMany: vi.fn(async () => rows), update } }) as never;

describe('checkMarketplaceSource', () => {
  it('records OK when the ref still names the pin', async () => {
    const update = vi.fn(async () => ({}));
    const r = await checkMarketplaceSource(
      prismaWith([], update),
      source(),
      deps(() => commit(A))
    );
    expect(r).toMatchObject({ latestSha: A, recorded: true, status: 'OK' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: null, latestSha: A, status: 'OK' }),
        where: { id: 's1', pinnedSha: A, status: { not: 'DISABLED' } },
      })
    );
  });

  it('records UPDATE_AVAILABLE when the ref moved', async () => {
    const r = await checkMarketplaceSource(
      prismaWith([]),
      source(),
      deps(() => commit(B))
    );
    expect(r).toMatchObject({ latestSha: B, status: 'UPDATE_AVAILABLE' });
  });

  it('records a fixed error string, keeping the last sha', async () => {
    const update = vi.fn(async () => ({}));
    const r = await checkMarketplaceSource(
      prismaWith([], update),
      source(),
      deps(() => new Response('secret body', { status: 404 }))
    );
    expect(r.status).toBe('ERROR');
    const data = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.status).toBe('ERROR');
    expect(data).not.toHaveProperty('latestSha');
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('reports recorded:false when the row changed under the check', async () => {
    const update = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'P2025' });
    });
    const r = await checkMarketplaceSource(
      prismaWith([], update),
      source(),
      deps(() => commit(B))
    );
    expect(r.recorded).toBe(false);
  });
});

describe('sweepMarketplaceSources', () => {
  it('visits every non-disabled source and one failure does not stop the others', async () => {
    const rows = [source({ id: 'bad', repo: 'broken' }), source({ id: 'good' })];
    const update = vi.fn(async () => ({}));
    const prisma = prismaWith(rows, update);
    const out = await sweepMarketplaceSources(
      prisma,
      deps((u) => (u.includes('/broken/') ? new Response('{}', { status: 500 }) : commit(B)))
    );
    expect(out).toMatchObject({ checked: 2, errors: 1, ok: 0, updateAvailable: 1 });
    expect(out.sources.map((s) => [s.id, s.status])).toEqual([
      ['bad', 'ERROR'],
      ['good', 'UPDATE_AVAILABLE'],
    ]);
    expect(
      (prisma as unknown as { marketplaceSource: { findMany: ReturnType<typeof vi.fn> } })
        .marketplaceSource.findMany
    ).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { not: 'DISABLED' } } }));
  });

  it('survives a database failure on one row', async () => {
    const rows = [source({ id: 'a' }), source({ id: 'b' })];
    let n = 0;
    const update = vi.fn(async () => {
      if (n++ === 0) {
        throw new Error('db down');
      }
      return {};
    });
    const out = await sweepMarketplaceSources(
      prismaWith(rows, update),
      deps(() => commit(A))
    );
    expect(out.sources.map((s) => s.status)).toEqual(['ERROR', 'OK']);
  });

  it('leaves the rest of a host for later once its rate limit is low', async () => {
    const rows = [source({ id: 'a' }), source({ id: 'b' })];
    const limited = () =>
      new Response('{}', {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
        status: 403,
      });
    const update = vi.fn(async () => ({}));
    const out = await sweepMarketplaceSources(prismaWith(rows, update), deps(limited));
    expect(out.skipped).toBe(2);
    expect(out.checked).toBe(0);
  });
});
