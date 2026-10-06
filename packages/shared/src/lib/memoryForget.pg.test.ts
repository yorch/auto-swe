import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { forgetMemoryItems } from './memoryForget.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * forgetMemoryItems against real Postgres: the up-walk is a JSON containment
 * query on `metadata.consolidatedFrom`, which a mocked client cannot check.
 *
 * Opt in with `MEMORY_FORGET_PG_TEST=1` and a migrated `DATABASE_URL`
 * (see modelSuggestions.pg.test.ts for a disposable pgvector container).
 */
const enabled = process.env.MEMORY_FORGET_PG_TEST === '1';

const ORG = '7c000000-0000-4000-8000-000000000001';
const TEAM = '7c000000-0000-4000-8000-000000000002';
const REPO = '7c000000-0000-4000-8000-000000000003';

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped('test fixture rows', ['MemoryItem', 'Connection', 'Team'], fn);

/** A row; `from` makes it a merged row of those sources, which are then marked consolidated. */
async function item(name: string, opts: { from?: string[] } = {}) {
  const row = await unscoped(() =>
    prisma.memoryItem.create({
      data: {
        lessonSummary: name,
        metadata: opts.from ? { consolidatedFrom: opts.from } : {},
        rationale: 'r',
        repoId: REPO,
      },
    })
  );
  if (opts.from) {
    await unscoped(() =>
      prisma.memoryItem.updateMany({
        data: { consolidatedAt: new Date() },
        where: { id: { in: opts.from } },
      })
    );
  }
  return row.id;
}

async function state() {
  const rows = await unscoped(() =>
    prisma.memoryItem.findMany({
      select: { consolidatedAt: true, id: true, supersededAt: true },
      where: { repoId: REPO },
    })
  );
  return new Map(rows.map((r) => [r.id, r.consolidatedAt || r.supersededAt ? 'hidden' : 'active']));
}

const forget = (ids: string[]) => prisma.$transaction((tx) => forgetMemoryItems(tx, ids));

describe.skipIf(!enabled)('forgetMemoryItems against Postgres', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.organization.create({ data: { id: ORG, name: 'fg-pg', slug: 'fg-pg' } });
    await prisma.team.create({ data: { id: TEAM, name: 'fg-pg', orgId: ORG, slug: 'fg-pg' } });
    await prisma.connection.create({ data: { id: REPO, teamId: TEAM } });
  });
  beforeEach(() => unscoped(() => prisma.memoryItem.deleteMany({ where: { repoId: REPO } })));
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('retracts what was merged from a forgotten source and restores the other sources', async () => {
    const [a, b, c] = [await item('a'), await item('b'), await item('c')];
    const merged = await item('abc', { from: [a, b, c] });

    const result = await forget([a]);

    expect(new Set(result.deleted)).toEqual(new Set([a, merged]));
    expect(new Set(result.restored)).toEqual(new Set([b, c]));
    expect(await state()).toEqual(
      new Map([
        [b, 'active'],
        [c, 'active'],
      ])
    );
  });

  it('follows merges of merges upward', async () => {
    const [a, b, c] = [await item('a'), await item('b'), await item('c')];
    const ab = await item('ab', { from: [a, b] });
    const abc = await item('abc', { from: [ab, c] });

    const result = await forget([a]);

    expect(new Set(result.deleted)).toEqual(new Set([a, ab, abc]));
    expect(await state()).toEqual(
      new Map([
        [b, 'active'],
        [c, 'active'],
      ])
    );
  });

  it('takes a forgotten merged row’s sources with it, restoring nothing', async () => {
    const [a, b] = [await item('a'), await item('b')];
    const merged = await item('ab', { from: [a, b] });

    const result = await forget([merged]);

    expect(new Set(result.deleted)).toEqual(new Set([merged, a, b]));
    expect(result.restored).toEqual([]);
    expect(await state()).toEqual(new Map());
  });

  it('keeps a source hidden while another surviving merged row stands for it', async () => {
    const [a, b] = [await item('a'), await item('b')];
    await item('ab', { from: [a, b] });
    // `b` is also the source of a second merged row that does not involve `a`.
    const bOnly = await item('b-only', { from: [b] });

    const result = await forget([a]);

    expect(result.restored).toEqual([]);
    expect(await state()).toEqual(
      new Map([
        [b, 'hidden'],
        [bOnly, 'active'],
      ])
    );
  });

  it('brings back what a forgotten row had superseded', async () => {
    const older = await item('older');
    const newer = await item('newer');
    await unscoped(() =>
      prisma.memoryItem.update({
        data: { supersededAt: new Date(), supersededById: newer },
        where: { id: older },
      })
    );

    const result = await forget([newer]);

    expect(result.restored).toEqual([older]);
    expect(await state()).toEqual(new Map([[older, 'active']]));
  });
});

async function cleanup() {
  await unscoped(async () => {
    await prisma.memoryItem.deleteMany({ where: { repoId: REPO } });
    await prisma.connection.deleteMany({ where: { id: REPO } });
    await prisma.team.deleteMany({ where: { id: TEAM } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
  });
}
