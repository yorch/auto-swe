import type { PrismaClient } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { modelListRequest } from './credentialService.js';
import { type ModelKind, pricedSpecs } from './modelCatalogService.js';

/**
 * On-demand discovery of provider models the catalog lacks. Lists models through
 * each GLOBAL provider credential and returns the ones nothing prices, as
 * suggestions — discovery never writes the catalog, so it can never make a model
 * "known" at $0. An admin supplies each price.
 */

export interface DiscoveredModel {
  modelId: string;
  /** A guess: Google says which methods a model serves; elsewhere the id is read. */
  kind: ModelKind;
  displayName: string | null;
}

export interface ProviderDiscovery {
  provider: string;
  ok: boolean;
  error?: string;
  /** Models the provider lists that the catalog and built-in table both lack. */
  models: Array<DiscoveredModel & { spec: string }>;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
/** Pages followed per provider; at the page sizes requested one page is the norm. */
const MAX_PAGES = 5;

/**
 * Models no text agent runs — speech, transcription, image and video generation,
 * moderation. Providers list them beside their chat models (OpenAI's list is
 * mostly these), and suggesting them would bury the useful entries.
 */
const NON_TEXT_MODEL =
  /(^|[-_./])(tts|whisper|dall-e|image|imagen|veo|sora|moderation|transcribe|audio|realtime|speech|lyria)([-_./]|$)/i;

function embeddingByName(id: string): ModelKind {
  return /embed/i.test(id) ? 'EMBEDDING' : 'CHAT';
}

interface Page {
  models: DiscoveredModel[];
  /** Query parameters for the next page, or null when this was the last. */
  next: Record<string, string> | null;
}

/** Parses one page of a provider's list-models response. Unknown shapes yield no models. */
export function parseModelListPage(provider: string, body: unknown): Page {
  const b = (body ?? {}) as Record<string, unknown>;
  if (provider === 'google') {
    const models = Array.isArray(b.models) ? (b.models as Array<Record<string, unknown>>) : [];
    return {
      models: models.flatMap((m) => {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? (m.supportedGenerationMethods as string[])
          : [];
        const chat = methods.includes('generateContent');
        const embed = methods.includes('embedContent');
        const name = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : '';
        if (!name || !(chat || embed)) {
          return [];
        }
        return [
          {
            displayName: typeof m.displayName === 'string' ? m.displayName : null,
            kind: (chat ? 'CHAT' : 'EMBEDDING') as ModelKind,
            modelId: name,
          },
        ];
      }),
      next:
        typeof b.nextPageToken === 'string' && b.nextPageToken
          ? { pageToken: b.nextPageToken }
          : null,
    };
  }
  const data = Array.isArray(b.data) ? (b.data as Array<Record<string, unknown>>) : [];
  const models = data.flatMap((m) =>
    typeof m.id === 'string' && m.id
      ? [
          {
            displayName: typeof m.display_name === 'string' ? m.display_name : null,
            kind: embeddingByName(m.id),
            modelId: m.id,
          },
        ]
      : []
  );
  // Anthropic pages by cursor; OpenAI and OpenAI-compatible lists are not paged.
  const next =
    provider === 'anthropic' && b.has_more === true && typeof b.last_id === 'string'
      ? { after_id: b.last_id }
      : null;
  return { models, next };
}

/** The first page asks for as much as each provider allows in one response. */
function firstPageQuery(provider: string): Record<string, string> {
  if (provider === 'anthropic') {
    return { limit: '1000' };
  }
  return provider === 'google' ? { pageSize: '1000' } : {};
}

/** Every model one credential's provider lists, following pages up to {@link MAX_PAGES}. */
export async function listProviderModels(args: {
  provider: string;
  apiKey: string;
  apiBase?: string | null;
}): Promise<{ ok: true; models: DiscoveredModel[] } | { ok: false; error: string }> {
  const models: DiscoveredModel[] = [];
  let query: Record<string, string> | null = firstPageQuery(args.provider);
  for (let page = 0; query && page < MAX_PAGES; page++) {
    const request = modelListRequest({ ...args, query });
    if ('error' in request) {
      return { error: request.error, ok: false };
    }
    let res: Response;
    try {
      res = await fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), ok: false };
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, ok: false };
    }
    const parsed = parseModelListPage(args.provider, await res.json().catch(() => null));
    models.push(...parsed.models);
    query = parsed.next;
  }
  return { models: models.filter((m) => !NON_TEXT_MODEL.test(m.modelId)), ok: true };
}

/**
 * Lists models through every GLOBAL credential, in parallel, and keeps the ones
 * nothing prices. One provider failing — a bad key, a timeout — is reported on
 * its own entry and never stops the others.
 */
export async function discoverProviderModels(prisma: PrismaClient): Promise<ProviderDiscovery[]> {
  const [credentials, priced] = await Promise.all([
    // Only the platform-wide credentials, which no tenant owns; the tenant guard
    // cannot read a scope filter as a tenant boundary, so the read says so.
    runUnscoped(
      'admin lists models through the GLOBAL provider credentials',
      ['ProviderCredential'],
      () =>
        prisma.providerCredential.findMany({
          orderBy: { provider: 'asc' },
          where: { scope: 'GLOBAL' },
        })
    ),
    pricedSpecs(prisma),
  ]);
  const { decryptSecret } = await import('@auto-swe/shared/lib/crypto');
  return Promise.all(
    credentials.map(async (cred): Promise<ProviderDiscovery> => {
      let apiKey: string;
      try {
        apiKey = decryptSecret({
          authTag: cred.apiKeyAuthTag,
          ciphertext: cred.apiKeyCiphertext,
          keyVersion: cred.keyVersion,
          nonce: cred.apiKeyNonce,
        });
      } catch {
        return {
          error: 'credential could not be decrypted',
          models: [],
          ok: false,
          provider: cred.provider,
        };
      }
      const listed = await listProviderModels({
        apiBase: cred.apiBase,
        apiKey,
        provider: cred.provider,
      });
      if (!listed.ok) {
        return { error: listed.error, models: [], ok: false, provider: cred.provider };
      }
      const seen = new Set<string>();
      const models = listed.models
        .map((m) => ({ ...m, spec: `${cred.provider}/${m.modelId}` }))
        .filter((m) => !priced.has(m.spec) && !seen.has(m.spec) && seen.add(m.spec))
        .sort((a, b) => a.spec.localeCompare(b.spec));
      return { models, ok: true, provider: cred.provider };
    })
  );
}
