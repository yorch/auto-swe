import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import type { ProviderDiscovery } from './modelDiscovery.js';
import { recordDiscovery } from './modelSuggestions.js';

/**
 * `recordDiscovery` against real Postgres: its upserts are keyed on the
 * (provider, model_id) unique index and a refresh must never duplicate a row or
 * lose a dismissal, which a mocked client cannot show.
 *
 * Opt in with `MODEL_SUGGESTIONS_PG_TEST=1` and a `DATABASE_URL` that
 * `prisma migrate deploy` has been run against (it deletes every suggestion):
 *
 *   docker run -d --rm --name smd-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55491:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55491/t yarn workspace @auto-swe/shared db:deploy
 *   MODEL_SUGGESTIONS_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/shared/src/lib/modelSuggestions.pg.test.ts
 */
const enabled = process.env.MODEL_SUGGESTIONS_PG_TEST === '1';

const spec = (provider: string, modelId: string) => ({
  displayName: null,
  kind: 'CHAT' as const,
  modelId,
  spec: `${provider}/${modelId}`,
});

const listed = (provider: string, models: string[], retired: string[] = []): ProviderDiscovery => ({
  complete: true,
  models: models.map((m) => spec(provider, m)),
  ok: true,
  provider,
  retirementCandidates: retired.map((m) => spec(provider, m)),
});

const T1 = new Date('2026-10-01T04:00:00Z');
const T2 = new Date('2026-10-02T04:00:00Z');

describe.skipIf(!enabled)('recordDiscovery against Postgres', () => {
  beforeEach(async () => {
    await prisma.modelSuggestion.deleteMany();
    await prisma.modelDiscoveryProviderStatus.deleteMany();
  });
  afterAll(() => prisma.$disconnect());

  it('refreshes in place: one row per model, first-seen and dismissal kept', async () => {
    await recordDiscovery(prisma, [listed('openai', ['gpt-9'])], T1);
    const [first] = await prisma.modelSuggestion.findMany();
    await prisma.modelSuggestion.update({
      data: { dismissedAt: T1 },
      where: { id: first?.id },
    });
    await Promise.all([
      recordDiscovery(prisma, [listed('openai', ['gpt-9'])], T2),
      recordDiscovery(prisma, [listed('openai', ['gpt-9'])], T2),
    ]);
    const rows = await prisma.modelSuggestion.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dismissedAt: T1,
      firstSeenAt: T1,
      id: first?.id,
      lastSeenAt: T2,
      type: 'NEW',
    });
  });

  it('flips type, drops what is gone, and leaves a failed provider alone', async () => {
    await recordDiscovery(
      prisma,
      [listed('openai', ['gpt-9', 'gpt-8']), listed('anthropic', ['claude-9'])],
      T1
    );
    await recordDiscovery(
      prisma,
      [
        listed('openai', [], ['gpt-9']),
        {
          complete: false,
          error: 'HTTP 401',
          models: [],
          ok: false,
          provider: 'anthropic',
          retirementCandidates: [],
        },
      ],
      T2
    );
    const rows = await prisma.modelSuggestion.findMany({ orderBy: { modelId: 'asc' } });
    expect(rows.map((r) => `${r.provider}/${r.modelId}:${r.type}`)).toEqual([
      'anthropic/claude-9:NEW',
      'openai/gpt-9:RETIREMENT_CANDIDATE',
    ]);
    const status = await prisma.modelDiscoveryProviderStatus.findUnique({
      where: { provider: 'anthropic' },
    });
    expect(status).toMatchObject({ error: 'HTTP 401', lastSuccessAt: T1 });
  });

  it('keeps a dismissal across a complete listing that omits the model and shows it again', async () => {
    await recordDiscovery(prisma, [listed('openai', ['gpt-9'])], T1);
    await prisma.modelSuggestion.updateMany({ data: { dismissedAt: T1 }, where: {} });
    await recordDiscovery(prisma, [listed('openai', [])], T2);
    await recordDiscovery(prisma, [listed('openai', ['gpt-9'])], T2);
    const rows = await prisma.modelSuggestion.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dismissedAt: T1, firstSeenAt: T1 });
  });
});
