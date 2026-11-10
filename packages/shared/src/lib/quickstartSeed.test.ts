import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyQuickstartSeed,
  planQuickstartSeed,
  QUICKSTART_EMBEDDING_SPEC,
  type QuickstartDb,
} from './quickstartSeed.js';

beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

function fakeDb(existing: { creds?: string[]; embedding?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const embeddings: unknown[] = [];
  const db: QuickstartDb = {
    embeddingConfig: {
      create: vi.fn(async (args) => {
        embeddings.push(args.data);
        return args.data;
      }),
      findUnique: vi.fn(async () => (existing.embedding ? { id: 'default' } : null)),
    },
    providerCredential: {
      create: vi.fn(async (args) => {
        created.push(args.data);
        return { id: 'x' };
      }),
      findFirst: vi.fn(async (args) =>
        existing.creds?.includes(args.where.provider) ? { id: 'old' } : null
      ),
    },
  };
  return { created, db, embeddings };
}

describe('planQuickstartSeed', () => {
  it('plans a credential per supplied key and reports the rest as missing', () => {
    const plan = planQuickstartSeed({ anthropic: ' sk-ant-1234567890 ', openai: '   ' });
    expect(plan.credentials).toEqual([{ apiKey: 'sk-ant-1234567890', provider: 'anthropic' }]);
    expect(plan.missing).toEqual(['openai']);
  });

  it('reports both providers missing when no key is supplied', () => {
    expect(planQuickstartSeed({}).missing).toEqual(['anthropic', 'openai']);
  });
});

describe('applyQuickstartSeed', () => {
  it('stores credentials encrypted and creates the embedding config', async () => {
    const { db, created, embeddings } = fakeDb();
    const plan = planQuickstartSeed({
      anthropic: 'sk-ant-abcdefgh1234',
      openai: 'sk-oai-abcdefgh5678',
    });
    const result = await applyQuickstartSeed(db, plan);
    expect(result.credentialsCreated).toEqual(['anthropic', 'openai']);
    expect(result.embeddingCreated).toBe(true);
    expect(embeddings).toEqual([{ id: 'default', modelSpec: QUICKSTART_EMBEDDING_SPEC }]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ lastFour: '1234', provider: 'anthropic', scope: 'GLOBAL' });
    for (const row of created) {
      expect(JSON.stringify(row)).not.toContain('sk-ant-abcdefgh1234');
      expect(row).not.toHaveProperty('apiKey');
    }
  });

  it('keeps credentials and embedding config that already exist', async () => {
    const { db, created, embeddings } = fakeDb({ creds: ['anthropic'], embedding: true });
    const plan = planQuickstartSeed({ anthropic: 'sk-ant-abcdefgh1234' });
    const result = await applyQuickstartSeed(db, plan);
    expect(result).toEqual({
      credentialsCreated: [],
      credentialsKept: ['anthropic'],
      embeddingCreated: false,
    });
    expect(created).toHaveLength(0);
    expect(embeddings).toHaveLength(0);
  });
});
