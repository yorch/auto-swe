import type { prisma as Prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MemoryStore from './memoryStore.js';

/**
 * Supersession against real Postgres and pgvector: a newly written memory
 * retires older near-duplicates in its own repository, and only those. The
 * UPDATE's similarity cut, scope filter and embedding-model filter are all SQL,
 * which a mocked client cannot check.
 *
 * Opt in with `MEMORY_PG_TEST=1` (see memoryStore.pg.test.ts for the setup).
 * Embeddings are stubbed: each text maps to a fixed vector, so similarity is
 * chosen by the test rather than by a provider.
 */
const enabled = process.env.MEMORY_PG_TEST === '1';

const DIMS = 1536;
const SPEC = 'test/embedding';
const vectors = new Map<string, number[]>();

/** A unit-ish vector along `axis`, nudged by `tilt` towards `axis + 1`. */
function direction(axis: number, tilt = 0): number[] {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  v[axis + 1] = tilt;
  return v;
}

vi.mock('./embeddings.js', () => ({
  generateEmbeddingWithSpec: vi.fn(async (text: string) => ({
    embedding: vectors.get(text) ?? direction(0),
    spec: SPEC,
  })),
}));

const ORG = '7b000000-0000-4000-8000-000000000001';
const TEAM = '7b000000-0000-4000-8000-000000000002';
const REPO = '7b000000-0000-4000-8000-000000000003';
const OTHER_REPO = '7b000000-0000-4000-8000-000000000004';

let prisma: typeof Prisma;
let store: typeof MemoryStore;

describe.skipIf(!enabled)('memory supersession against Postgres', () => {
  beforeAll(async () => {
    ({ prisma } = await import('@auto-swe/shared/db'));
    store = await import('./memoryStore.js');
    await cleanup();
    await prisma.organization.create({ data: { id: ORG, name: 'sup-pg', slug: 'sup-pg' } });
    await prisma.team.create({ data: { id: TEAM, name: 'sup-pg', orgId: ORG, slug: 'sup-pg' } });
    await prisma.connection.createMany({
      data: [
        { id: REPO, teamId: TEAM },
        { id: OTHER_REPO, teamId: TEAM },
      ],
    });
  });

  beforeEach(async () => {
    await runUnscoped('test fixture rows', ['MemoryItem'], () =>
      prisma.memoryItem.deleteMany({ where: { repoId: { in: [REPO, OTHER_REPO] } } })
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function write(text: string, repoId: string, vector: number[]) {
    vectors.set(text, vector);
    return store.insertMemoryItem({ lessonSummary: text, rationale: 'r', repoId });
  }

  async function row(id: string) {
    return runUnscoped('test read', ['MemoryItem'], () =>
      prisma.memoryItem.findUniqueOrThrow({
        select: { supersededAt: true, supersededById: true },
        where: { id },
      })
    );
  }

  it('retires an older near-duplicate in the same repository, naming its replacement', async () => {
    const older = await write('run migrations before deploy', REPO, direction(0));
    const newer = await write('always migrate before deploying', REPO, direction(0, 0.1));

    expect(await row(older)).toMatchObject({ supersededById: newer });
    expect((await row(older)).supersededAt).not.toBeNull();
    expect(await row(newer)).toMatchObject({ supersededAt: null, supersededById: null });

    const recalled = await store.searchMemoryItemsByVector({
      limit: 10,
      precomputed: { embedding: direction(0), spec: SPEC },
      queryText: 'unused',
      scopeColumn: 'repo_id',
      scopeId: REPO,
      selectColumns: ['id'],
      similarityThreshold: 0,
    });
    expect(recalled.map((r) => r.id)).toEqual([newer]);
  });

  it('leaves a lesson about something else alone', async () => {
    const first = await write('pin the node version', REPO, direction(0));
    await write('lint before pushing', REPO, direction(10));
    expect(await row(first)).toMatchObject({ supersededById: null });
  });

  it('never reaches into another repository', async () => {
    const elsewhere = await write('run migrations before deploy', OTHER_REPO, direction(0));
    await write('always migrate before deploying', REPO, direction(0, 0.1));
    expect(await row(elsewhere)).toMatchObject({ supersededById: null });
  });
});

async function cleanup() {
  await runUnscoped('test fixture rows', ['MemoryItem', 'Connection', 'Team'], async () => {
    await prisma.memoryItem.deleteMany({ where: { repoId: { in: [REPO, OTHER_REPO] } } });
    await prisma.connection.deleteMany({ where: { id: { in: [REPO, OTHER_REPO] } } });
    await prisma.team.deleteMany({ where: { id: TEAM } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
  });
}
