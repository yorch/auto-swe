import type { prisma as Prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  listStaleMemoryIds as ListStale,
  searchMemoryItemsByVector as Search,
} from './memoryStore.js';

/**
 * Scoped vector search against real pgvector. Every memory search filters one
 * repository (or channel) and orders by distance, so the planner may answer it
 * from the HNSW index — which yields only its first `hnsw.ef_search` (40)
 * candidates, nearest first, from the WHOLE table, and the scope filter runs
 * after. A small repository whose lessons sit away from a large repository's
 * crowd then gets none of them back. A mocked client cannot show this.
 *
 * At production scale the planner picks that index plan by itself, but only
 * once the table holds tens of thousands of rows, and seeding that many
 * indexed 1536-dimension vectors takes minutes. So the test's connections run
 * with `enable_sort = off`, which leaves the planner the index plan only, and a
 * crowd of a few hundred rows is enough to show the starvation.
 *
 * Opt in with `MEMORY_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate
 * deploy` has been run against, on pgvector 0.8 or later:
 *
 *   docker run -d --rm --name mem-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55492:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55492/t yarn workspace @auto-swe/shared db:deploy
 *   MEMORY_PG_TEST=1 DATABASE_URL=... yarn vitest run packages/worker/src/lib/memoryStore.pg.test.ts
 */
const enabled = process.env.MEMORY_PG_TEST === '1';

let prisma: typeof Prisma;
let searchMemoryItemsByVector: typeof Search;
let listStaleMemoryIds: typeof ListStale;

const ORG = '7a000000-0000-4000-8000-000000000001';
const TEAM = '7a000000-0000-4000-8000-000000000002';
const CROWDED_REPO = '7a000000-0000-4000-8000-000000000003';
const SMALL_REPO = '7a000000-0000-4000-8000-000000000004';
const AGED_REPO = '7a000000-0000-4000-8000-000000000005';
const SPEC = 'test/embedding';
const DIMS = 1536;

/** A random direction; the crowded repository's lessons cluster tightly around it. */
const query = Array.from({ length: DIMS }, () => Math.random() - 0.5);

/** Insert `count` rows for `repoId`, each `query` plus uniform noise of width `spread`. */
async function seed(repoId: string, count: number, spread: number, around: number[] | null) {
  // Vectors are built in SQL: shipping thousands of 1536-float literals from
  // the client would dominate the test's run time. `g * 0` correlates the
  // subquery with each row so every row gets its own noise.
  await prisma.$executeRawUnsafe(
    `INSERT INTO memory_items
       (id, repo_id, rationale, lesson_summary, embedding, embedding_model, skills_active, created_at)
     SELECT gen_random_uuid(), $1::uuid, 'r', 'lesson ' || g,
       (SELECT array_agg(COALESCE(c, 0) + (random() - 0.5) * $3 + g * 0 ORDER BY i)::vector
          FROM generate_series(1, ${DIMS}) i
          LEFT JOIN unnest($4::real[]) WITH ORDINALITY AS q(c, j) ON j = i),
       $5, '{}', now()
     FROM generate_series(1, $2) g`,
    repoId,
    count,
    spread,
    around,
    SPEC
  );
}

describe.skipIf(!enabled)('scoped vector search against pgvector', () => {
  beforeAll(async () => {
    // Before the client is created: the singleton reads DATABASE_URL once.
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.searchParams.set('options', '-c enable_sort=off');
    process.env.DATABASE_URL = url.toString();
    ({ prisma } = await import('@auto-swe/shared/db'));
    ({ listStaleMemoryIds, searchMemoryItemsByVector } = await import('./memoryStore.js'));

    await cleanup();
    await prisma.organization.create({ data: { id: ORG, name: 'mem-pg', slug: 'mem-pg' } });
    await prisma.team.create({ data: { id: TEAM, name: 'mem-pg', orgId: ORG, slug: 'mem-pg' } });
    await prisma.connection.createMany({
      data: [
        { id: CROWDED_REPO, teamId: TEAM },
        { id: SMALL_REPO, teamId: TEAM },
        { id: AGED_REPO, teamId: TEAM },
      ],
    });
    // The crowded repository fills the query's neighbourhood; the small one's
    // lessons are spread elsewhere, so none is among the 40 nearest overall.
    await seed(CROWDED_REPO, 400, 0.3, query);
    await seed(SMALL_REPO, 50, 1, null);
    await prisma.$executeRawUnsafe('ANALYZE memory_items');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function search(scopeId: string, limit: number) {
    return searchMemoryItemsByVector({
      limit,
      precomputed: { embedding: query, spec: SPEC },
      queryText: 'unused: the embedding is precomputed',
      scopeColumn: 'repo_id',
      scopeId,
      selectColumns: ['id'],
      // Every row qualifies, so the only thing that can shorten the result is
      // how the index is scanned.
      similarityThreshold: -1,
    });
  }

  it('returns a small repository its nearest lessons despite a crowded neighbour', async () => {
    const rows = await search(SMALL_REPO, 5);
    expect(rows).toHaveLength(5);
  });

  it('still orders results by similarity', async () => {
    const rows = await search(SMALL_REPO, 20);
    const similarities = rows.map((r) => Number(r.similarity));
    expect(similarities).toEqual([...similarities].sort((a, b) => b - a));
  });

  it('lists the rows another model embedded, and unlabelled ones, for re-embedding', async () => {
    const [other, unlabelled] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO memory_items (id, repo_id, rationale, lesson_summary, embedding_model, skills_active, created_at)
       VALUES (gen_random_uuid(), $1::uuid, 'r', 'old', 'old/model', '{}', now()),
              (gen_random_uuid(), $1::uuid, 'r', 'legacy', NULL, '{}', now())
       RETURNING id`,
      SMALL_REPO
    );
    const stale = await listStaleMemoryIds(SPEC, null, 1_000);
    expect(new Set(stale)).toEqual(new Set([other?.id, unlabelled?.id]));
    // The cursor excludes everything up to and including itself.
    const sorted = [...stale].sort();
    expect(await listStaleMemoryIds(SPEC, sorted[0] ?? null, 1_000)).toEqual(sorted.slice(1));
  });

  it('leaves lessons past the maximum age out before LIMIT, so N fresh ones still come back', async () => {
    // Ten old lessons right at the query, five fresh ones far from it: without
    // the filter the old ones take every slot.
    await seed(AGED_REPO, 10, 0.1, query);
    await prisma.$executeRawUnsafe(
      `UPDATE memory_items SET created_at = now() - interval '100 days' WHERE repo_id = $1::uuid`,
      AGED_REPO
    );
    await seed(AGED_REPO, 5, 1, null);
    const fresh = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM memory_items WHERE repo_id = $1::uuid AND created_at > now() - interval '1 day'`,
      AGED_REPO
    );

    const rows = await searchMemoryItemsByVector({
      limit: 5,
      maxAgeDays: 30,
      precomputed: { embedding: query, spec: SPEC },
      queryText: 'unused: the embedding is precomputed',
      scopeColumn: 'repo_id',
      scopeId: AGED_REPO,
      selectColumns: ['id'],
      similarityThreshold: -1,
    });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(fresh.map((r) => r.id)));
    // Without the filter the old lessons win every slot.
    const unfiltered = await search(AGED_REPO, 5);
    expect(unfiltered.some((r) => fresh.some((f) => f.id === r.id))).toBe(false);
  });

  it('returns the crowded repository its own lessons too', async () => {
    const rows = await search(CROWDED_REPO, 5);
    expect(rows).toHaveLength(5);
  });
});

async function cleanup() {
  await runUnscoped(
    'test fixture rows, by fixed id',
    ['MemoryItem', 'Connection', 'Team'],
    async () => {
      const repos = [CROWDED_REPO, SMALL_REPO, AGED_REPO];
      await prisma.memoryItem.deleteMany({ where: { repoId: { in: repos } } });
      await prisma.connection.deleteMany({ where: { id: { in: repos } } });
      await prisma.team.deleteMany({ where: { id: TEAM } });
      await prisma.organization.deleteMany({ where: { id: ORG } });
    }
  );
}
