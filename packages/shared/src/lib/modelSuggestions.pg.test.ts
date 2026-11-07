import '../workflow/runAttribution.pg.js';
import './codeReview.pg.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { deletePendingArtifact, getArtifact, putArtifact } from './artifactStore.js';
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

  it('streams pg artifact chunks and cascades their deletion', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-artifact-pg-'));
    const filePath = path.join(dir, 'recording.bin');
    const payload = Buffer.alloc(1024 * 1024 + 19, 0x5a);
    const previousBackend = process.env.ARTIFACT_WRITE_BACKEND;
    let artifactId: string | undefined;
    await fs.writeFile(filePath, payload);
    process.env.ARTIFACT_WRITE_BACKEND = 'pg';
    try {
      const ref = await putArtifact({
        body: { filePath, sizeBytes: payload.byteLength },
        kind: 'ui.video',
      });
      artifactId = ref.id;
      const row = await prisma.workflowArtifact.findUniqueOrThrow({
        include: { chunks: true },
        where: { id: ref.id },
      });
      expect(row).toMatchObject({
        inlineBlob: null,
        sizeBytes: payload.byteLength,
        status: 'ready',
      });
      expect(row.chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
      await expect(getArtifact(ref.id)).resolves.toMatchObject({ body: payload });

      const pending = await prisma.workflowArtifact.create({
        data: {
          backend: 'pg',
          contentType: 'application/octet-stream',
          kind: 'ui.video',
          sizeBytes: 1,
          status: 'pending',
        },
      });
      await prisma.workflowArtifactChunk.create({
        data: { artifactId: pending.id, data: new Uint8Array([1]), seq: 0 },
      });
      expect(await prisma.workflowArtifactChunk.count({ where: { artifactId: pending.id } })).toBe(
        1
      );
      await expect(deletePendingArtifact(pending.id)).resolves.toBe(true);
      expect(await prisma.workflowArtifactChunk.count({ where: { artifactId: pending.id } })).toBe(
        0
      );
    } finally {
      if (previousBackend === undefined) {
        delete process.env.ARTIFACT_WRITE_BACKEND;
      } else {
        process.env.ARTIFACT_WRITE_BACKEND = previousBackend;
      }
      if (artifactId) {
        await prisma.workflowArtifact.deleteMany({ where: { id: artifactId } });
      }
      await fs.rm(dir, { force: true, recursive: true });
    }
  }, 15_000);
});
