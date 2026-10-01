import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_MODELS, builtinModelSpec } from './builtinModels.js';
import { syncModelCatalog } from './syncBuiltins.js';

/**
 * Seeding the model catalog from BUILTIN_MODELS: code owns an untouched
 * built-in row, so a price correction reaches every deployment on restart; an
 * admin's edit is never overwritten; an admin's own row for a model that later
 * ships built-in is adopted with its prices kept; nothing is ever deleted.
 */

interface Row {
  id: string;
  provider: string;
  modelId: string;
  kind: string;
  status: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  isBuiltIn: boolean;
  isCustomized: boolean;
}

function fakePrisma(seed: Partial<Row>[] = [], opts: { raceOn?: string } = {}) {
  const rows: Row[] = seed.map((r, i) => ({
    id: `seed-${i}`,
    inputUsdPerMTok: 0,
    isBuiltIn: false,
    isCustomized: false,
    kind: 'CHAT',
    modelId: '',
    outputUsdPerMTok: 0,
    provider: '',
    status: 'ACTIVE',
    ...r,
  }));
  const writes: string[] = [];
  const modelCatalogEntry = {
    create: async ({ data }: { data: Partial<Row> }) => {
      const spec = `${data.provider}/${data.modelId}`;
      // The column defaults the migration declares.
      const withDefaults = { isBuiltIn: false, isCustomized: false, ...data } as Omit<Row, 'id'>;
      if (opts.raceOn === spec) {
        // Another gateway booting at the same moment inserted it first.
        rows.push({ ...withDefaults, id: 'racer' });
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      writes.push(`create ${spec}`);
      const row = { ...withDefaults, id: `new-${rows.length}` };
      rows.push(row);
      return row;
    },
    findMany: async () => rows.map((r) => ({ ...r })),
    update: async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) {
        throw new Error(`no row ${where.id}`);
      }
      writes.push(`update ${row.provider}/${row.modelId}`);
      Object.assign(row, data);
      return row;
    },
  };
  return { prisma: { modelCatalogEntry } as unknown as PrismaClient, rows, writes };
}

const OPUS = BUILTIN_MODELS.find((m) => builtinModelSpec(m) === 'anthropic/claude-opus-5-5');
if (!OPUS) {
  throw new Error('fixture: anthropic/claude-opus-5-5 is not in BUILTIN_MODELS');
}
const find = (rows: Row[], spec: string) => rows.find((r) => `${r.provider}/${r.modelId}` === spec);

describe('syncModelCatalog', () => {
  it('creates every built-in model on an empty catalog, then writes nothing on a second run', async () => {
    const { prisma, rows, writes } = fakePrisma();
    await syncModelCatalog(prisma);
    expect(rows).toHaveLength(BUILTIN_MODELS.length);
    expect(find(rows, 'anthropic/claude-opus-5-5')).toMatchObject({
      inputUsdPerMTok: OPUS.inputUsdPerMTok,
      isBuiltIn: true,
      isCustomized: false,
      kind: OPUS.kind,
      outputUsdPerMTok: OPUS.outputUsdPerMTok,
      status: OPUS.status,
    });

    writes.length = 0;
    await syncModelCatalog(prisma);
    expect(writes).toEqual([]);
  });

  it('brings an untouched built-in row in step with a price corrected in code', async () => {
    const { prisma, rows } = fakePrisma([
      { inputUsdPerMTok: 99, isBuiltIn: true, modelId: OPUS.modelId, provider: OPUS.provider },
    ]);
    await syncModelCatalog(prisma);
    expect(find(rows, 'anthropic/claude-opus-5-5')).toMatchObject({
      inputUsdPerMTok: OPUS.inputUsdPerMTok,
      isCustomized: false,
      outputUsdPerMTok: OPUS.outputUsdPerMTok,
    });
  });

  it('never overwrites a built-in row an admin has customized', async () => {
    const { prisma, rows, writes } = fakePrisma([
      {
        inputUsdPerMTok: 3,
        isBuiltIn: true,
        isCustomized: true,
        modelId: OPUS.modelId,
        outputUsdPerMTok: 15,
        provider: OPUS.provider,
        status: 'DEPRECATED',
      },
    ]);
    await syncModelCatalog(prisma);
    expect(find(rows, 'anthropic/claude-opus-5-5')).toMatchObject({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      status: 'DEPRECATED',
    });
    expect(writes).not.toContain('update anthropic/claude-opus-5-5');
  });

  it("adopts an admin's own row for a model that now ships built-in, keeping its prices", async () => {
    const { prisma, rows } = fakePrisma([
      {
        inputUsdPerMTok: 3.5,
        modelId: OPUS.modelId,
        outputUsdPerMTok: 17,
        provider: OPUS.provider,
      },
    ]);
    await syncModelCatalog(prisma);
    expect(find(rows, 'anthropic/claude-opus-5-5')).toMatchObject({
      inputUsdPerMTok: 3.5,
      isBuiltIn: true,
      isCustomized: true,
      outputUsdPerMTok: 17,
    });
  });

  it('leaves rows that are not built-in alone, and deletes nothing', async () => {
    const { prisma, rows } = fakePrisma([
      { inputUsdPerMTok: 0, modelId: 'llama-4', outputUsdPerMTok: 0, provider: 'ollama' },
      { inputUsdPerMTok: 1, isBuiltIn: true, modelId: 'dropped-from-code', provider: 'openai' },
    ]);
    await syncModelCatalog(prisma);
    expect(find(rows, 'ollama/llama-4')).toMatchObject({ isBuiltIn: false, isCustomized: false });
    expect(find(rows, 'openai/dropped-from-code')).toMatchObject({ inputUsdPerMTok: 1 });
  });

  it('carries on past a row a concurrently booting gateway inserted first', async () => {
    const { prisma, rows } = fakePrisma([], { raceOn: 'anthropic/claude-opus-5-5' });
    await expect(syncModelCatalog(prisma)).resolves.toBeUndefined();
    expect(rows).toHaveLength(BUILTIN_MODELS.length);
  });
});
