import { encryptSecret } from './crypto.js';

/**
 * The model configuration `yarn quickstart` writes so the worker's boot gate
 * (`assertConfigReady`) passes on a fresh database: one GLOBAL credential per
 * provider and the `EmbeddingConfig` singleton. `db:seed` creates the agents
 * but neither of these.
 *
 * Existing rows are never touched. A credential or embedding choice an admin
 * already made is theirs; this only fills what is absent.
 */

/** The embedding model a fresh deployment uses; `memory_items.embedding` is 1536-dimensional. */
export const QUICKSTART_EMBEDDING_SPEC = 'openai/text-embedding-3-large';

export interface QuickstartKeys {
  /** Backs the seeded agents (their default models are Anthropic). */
  anthropic?: string;
  /** Backs the embedding model. */
  openai?: string;
}

export type QuickstartProvider = 'anthropic' | 'openai';

export interface QuickstartPlan {
  /** Providers that get a GLOBAL credential if none exists. */
  credentials: Array<{ provider: QuickstartProvider; apiKey: string }>;
  /** Providers the worker needs that no key was supplied for. */
  missing: QuickstartProvider[];
}

/** Trim a key; a blank value means "not supplied". */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function planQuickstartSeed(keys: QuickstartKeys): QuickstartPlan {
  const credentials: QuickstartPlan['credentials'] = [];
  const missing: QuickstartPlan['missing'] = [];
  for (const provider of ['anthropic', 'openai'] as const) {
    const apiKey = clean(keys[provider]);
    if (apiKey) {
      credentials.push({ apiKey, provider });
    } else {
      missing.push(provider);
    }
  }
  return { credentials, missing };
}

/** The slice of the Prisma client this module uses, so tests can stand in for it. */
export interface QuickstartDb {
  providerCredential: {
    findFirst(args: { where: { provider: string; scope: 'GLOBAL' } }): Promise<{
      id: string;
    } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  embeddingConfig: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string } | null>;
    create(args: { data: { id: string; modelSpec: string } }): Promise<unknown>;
  };
}

export interface QuickstartSeedResult {
  credentialsCreated: QuickstartProvider[];
  credentialsKept: QuickstartProvider[];
  embeddingCreated: boolean;
}

export async function applyQuickstartSeed(
  db: QuickstartDb,
  plan: QuickstartPlan
): Promise<QuickstartSeedResult> {
  const result: QuickstartSeedResult = {
    credentialsCreated: [],
    credentialsKept: [],
    embeddingCreated: false,
  };
  for (const { provider, apiKey } of plan.credentials) {
    const existing = await db.providerCredential.findFirst({
      where: { provider, scope: 'GLOBAL' },
    });
    if (existing) {
      result.credentialsKept.push(provider);
      continue;
    }
    const sealed = encryptSecret(apiKey);
    await db.providerCredential.create({
      data: {
        apiKeyAuthTag: sealed.authTag,
        apiKeyCiphertext: sealed.ciphertext,
        apiKeyNonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
        lastFour: sealed.lastFour,
        provider,
        scope: 'GLOBAL',
      },
    });
    result.credentialsCreated.push(provider);
  }
  const embedding = await db.embeddingConfig.findUnique({ where: { id: 'default' } });
  if (!embedding) {
    await db.embeddingConfig.create({
      data: { id: 'default', modelSpec: QUICKSTART_EMBEDDING_SPEC },
    });
    result.embeddingCreated = true;
  }
  return result;
}
