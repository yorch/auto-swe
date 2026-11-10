import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { indexKnowledgeCandidates, rankKnowledgeByEmbedding } from '../lib/knowledgeRuntime.js';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * The knowledge vector SQL against a real Postgres with pgvector: the schema (extension, a
 * `vector(1536)` column, the HNSW index), the indexing `UPDATE` with its `::vector` cast and
 * digest/version guard, and the cosine-ranking `SELECT` that semantic search runs
 * (`rankKnowledgeByEmbedding`, the statement `searchWorkflowKnowledge` executes).
 *
 * Embeddings are deterministic vectors, not a model's: what is under test is the SQL and the
 * migration DDL, which a mocked Prisma client cannot exercise. Point `DATABASE_URL` at a migrated
 * database (`yarn db:deploy`), name the same one in `LIVE_E2E_DATABASE_URL`, and opt in with
 * `LIVE_KNOWLEDGE_PGVECTOR=1`. The suite writes under its own organization and removes it after.
 */
const gate = liveGate(
  'knowledge pgvector',
  'LIVE_KNOWLEDGE_PGVECTOR',
  process.env.LIVE_KNOWLEDGE_PGVECTOR === '1',
  ['LIVE_E2E_DATABASE_URL']
);

// Only the embedding model and the budget gate are replaced; the SQL under test is the real one.
vi.mock('../lib/embeddings.js', () => ({
  currentEmbeddingSpec: async () => 'live/deterministic',
  generateEmbeddingWithSpec: async (text: string) => ({
    embedding: topicVector(text),
    spec: 'live/deterministic',
  }),
}));
vi.mock('../lib/costTracking.js', () => ({ assertBudgetAvailable: async () => undefined }));

const SPEC = 'live/deterministic';
const DIMENSIONS = 1536;

/** A unit vector on the axis of the first topic word the text mentions. */
function topicVector(text: string): number[] {
  const topics = ['alpha', 'beta', 'gamma'];
  const axis = topics.findIndex((t) => text.toLowerCase().includes(t));
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[axis < 0 ? 3 : axis] = 1;
  return v;
}

const unscoped = <T>(fn: () => Promise<T>) =>
  runUnscoped('live fixture rows', ['KnowledgeItem', 'Team', 'Organization'], fn);

describe.skipIf(!gate.enabled)(liveTitle('live knowledge pgvector SQL', gate), () => {
  const tag = Date.now().toString(36);
  let orgId: string;
  let teamId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must be the database named by LIVE_E2E_DATABASE_URL'
    ).toBe(liveEnv('LIVE_E2E_DATABASE_URL'));
    const org = await prisma.organization.create({
      data: { name: `live-kb-${tag}`, slug: `live-kb-${tag}` },
    });
    orgId = org.id;
    const team = await prisma.team.create({
      data: { name: `live-kb-${tag}`, orgId, slug: `live-kb-${tag}` },
    });
    teamId = team.id;
    for (const topic of ['alpha', 'beta', 'gamma']) {
      const row = await unscoped(() =>
        prisma.knowledgeItem.create({
          data: {
            content: `Notes about ${topic}.`,
            contentDigest: `digest-${topic}`,
            orgId,
            originTeamId: teamId,
            ownerTeamId: teamId,
            title: `${topic} item`,
            visibility: 'TEAM',
          },
        })
      );
      ids[topic] = row.id;
    }
  });

  afterAll(async () => {
    // Deleting the organization cascades to its teams and their knowledge items.
    if (orgId) {
      await unscoped(() => prisma.knowledgeItem.deleteMany({ where: { orgId } })).catch(
        () => undefined
      );
      await unscoped(() => prisma.team.deleteMany({ where: { orgId } })).catch(() => undefined);
      await unscoped(() => prisma.organization.deleteMany({ where: { id: orgId } })).catch(
        () => undefined
      );
    }
    await prisma.$disconnect();
  });

  const candidates = () =>
    unscoped(() =>
      prisma.knowledgeItem.findMany({
        select: {
          content: true,
          contentDigest: true,
          embeddingDigest: true,
          embeddingModel: true,
          id: true,
          status: true,
          title: true,
          version: true,
        },
        where: { id: { in: Object.values(ids) } },
      })
    );

  it('has the extension, a vector(1536) column and an HNSW index', async () => {
    const ext = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(ext).toHaveLength(1);
    const col = await prisma.$queryRaw<Array<{ type: string }>>`
      SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = 'knowledge_items'::regclass AND attname = 'embedding'`;
    expect(col[0]?.type).toBe('vector(1536)');
    const idx = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'knowledge_items_embedding_hnsw_idx'`;
    expect(idx[0]?.indexdef).toMatch(/hnsw/i);
  });

  it('indexes candidates with the guarded UPDATE', async () => {
    await indexKnowledgeCandidates(await candidates(), SPEC);
    for (const row of await candidates()) {
      expect(row.embeddingModel).toBe(SPEC);
      expect(row.embeddingDigest).toBe(row.contentDigest);
    }
  });

  it('does not write a vector for a version that has moved on', async () => {
    const [row] = await candidates();
    expect(row).toBeDefined();
    const stale = { ...(row as NonNullable<typeof row>), embeddingDigest: null, version: 99 };
    await unscoped(() =>
      prisma.knowledgeItem.update({
        data: { embeddingDigest: null, embeddingModel: null },
        where: { id: stale.id },
      })
    );
    await indexKnowledgeCandidates([stale], SPEC);
    const after = await candidates();
    expect(after.find((r) => r.id === stale.id)?.embeddingDigest).toBeNull();
    // Restore, so the ranking tests below see all three vectors.
    await indexKnowledgeCandidates(await candidates(), SPEC);
  });

  it('ranks by cosine similarity, nearest first', async () => {
    const ranked = await rankKnowledgeByEmbedding(
      Object.values(ids),
      topicVector('alpha'),
      SPEC,
      3
    );
    expect(ranked.map((r) => r.id)[0]).toBe(ids.alpha);
    expect(Number(ranked[0]?.similarity)).toBeCloseTo(1, 5);
    expect(Number(ranked[1]?.similarity)).toBeCloseTo(0, 5);
  });

  it('leaves out a vector whose content digest or model no longer matches', async () => {
    await unscoped(() =>
      prisma.knowledgeItem.update({
        data: { contentDigest: 'edited-after-indexing' },
        where: { id: ids.alpha as string },
      })
    );
    const afterEdit = await rankKnowledgeByEmbedding(
      Object.values(ids),
      topicVector('alpha'),
      SPEC,
      3
    );
    expect(afterEdit.map((r) => r.id)).not.toContain(ids.alpha);

    const otherModel = await rankKnowledgeByEmbedding(
      Object.values(ids),
      topicVector('beta'),
      'live/other-model',
      3
    );
    expect(otherModel).toEqual([]);
  });
});
