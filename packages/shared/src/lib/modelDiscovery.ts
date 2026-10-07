import type { PrismaClient } from '../index.js';
import { BUILTIN_MODELS, builtinModelSpec } from './builtinModels.js';
import {
  createOriginScopedFetch,
  type GuardedFetchOptions,
  SSRF_BLOCKED_CODE,
} from './guardedDispatcher.js';
import { checkProbeUrl } from './ssrfGuard.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * Discovery of provider models the catalog lacks, and of catalog models a
 * provider no longer lists. Lists models through each GLOBAL provider credential
 * and returns the unpriced ones as suggestions — discovery never writes the
 * catalog, so it can never make a model "known" at $0. An admin supplies each
 * price. One copy serves the gateway (the on-demand route, the credential probe)
 * and the worker (the scheduled run).
 */

export type ModelKind = 'CHAT' | 'EMBEDDING';

/**
 * A provider's list-models request: URL plus auth. `query` adds parameters (page
 * size, cursor). Shared by the credential probe and model discovery, so both hit
 * the same endpoint with the same auth behind the same SSRF guard. Returns why
 * the request cannot be made instead, for an OpenAI-compatible provider without a
 * usable `apiBase`.
 */
export function modelListRequest(args: {
  provider: string;
  apiKey: string;
  apiBase?: string | null;
  /** The credential's opt-in: waives the private-network refusal, never loopback or metadata. */
  allowPrivateNetwork?: boolean;
  query?: Record<string, string>;
}): { url: string; init: RequestInit } | { error: string } {
  const { provider, apiKey, apiBase, allowPrivateNetwork, query = {} } = args;
  const withQuery = (base: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ ...extra, ...query });
    return params.size ? `${base}?${params}` : base;
  };
  if (provider === 'anthropic') {
    return {
      init: { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey } },
      url: withQuery('https://api.anthropic.com/v1/models'),
    };
  }
  if (provider === 'openai') {
    return {
      init: { headers: { Authorization: `Bearer ${apiKey}` } },
      url: withQuery('https://api.openai.com/v1/models'),
    };
  }
  if (provider === 'google') {
    return {
      init: {},
      url: withQuery('https://generativelanguage.googleapis.com/v1beta/models', { key: apiKey }),
    };
  }
  // OpenAI-compatible: `<base>/models`. SSRF guards run here.
  if (!apiBase) {
    return { error: 'apiBase required to list models from an OpenAI-compatible provider' };
  }
  const safety = checkProbeUrl(apiBase, { allowPrivate: allowPrivateNetwork });
  if (!safety.ok) {
    return { error: `apiBase rejected: ${safety.reason}` };
  }
  if (safety.url.username || safety.url.password) {
    return { error: 'apiBase rejected: credentials in the URL are not allowed' };
  }
  const base = safety.url.toString().replace(/\/+$/, '');
  return {
    // The guard checked `apiBase`, not wherever it redirects to.
    init: { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'manual' },
    url: withQuery(`${base}/models`),
  };
}

/**
 * What a failed list-models call may say. Node puts header values and URL
 * userinfo into fetch's error messages, so no message text from fetch or from
 * the provider's body ever leaves this module: every failure is one of a fixed
 * set of strings, which is what reaches the status row, the API, the logs and
 * the activity result in Temporal history.
 */
export const DISCOVERY_ERRORS = {
  blocked: 'blocked address',
  missingBase: 'apiBase required',
  timeout: 'timed out',
  unrecognised: 'unrecognised response',
} as const;

/**
 * The fetch for one list-models request. A credential's private-network opt-in
 * is waived for that request's origin only; any other origin is checked
 * strictly. `opts` is a test seam (an injected resolver).
 */
export function modelListFetch(
  url: string,
  allowPrivateNetwork: boolean,
  opts: Omit<GuardedFetchOptions, 'allowPrivate'> = {}
): typeof fetch {
  return createOriginScopedFetch(allowPrivateNetwork ? [new URL(url).origin] : [], opts);
}

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,40}$/;

/** A thrown fetch error as a fixed string: its name and error code, never its message. */
export function safeFetchError(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return DISCOVERY_ERRORS.timeout;
  }
  const e = err as { cause?: { code?: unknown }; code?: unknown } | null;
  const code = e?.cause?.code ?? e?.code;
  if (code === SSRF_BLOCKED_CODE) {
    return DISCOVERY_ERRORS.blocked;
  }
  const parts = [
    typeof name === 'string' && SAFE_TOKEN.test(name) ? name : 'Error',
    ...(typeof code === 'string' && SAFE_TOKEN.test(code) ? [code] : []),
  ];
  return `request failed (${parts.join(', ')})`;
}

/** A refusal from {@link modelListRequest} as a fixed string. */
export function safeRequestError(message: string): string {
  return message.startsWith('apiBase required')
    ? DISCOVERY_ERRORS.missingBase
    : DISCOVERY_ERRORS.blocked;
}

/** What nothing may ever hold a price for: the catalog's rows plus the built-in table. */
export interface KnownModel {
  provider: string;
  modelId: string;
  kind: ModelKind;
  displayName: string | null;
  /** Retired models are still priced, but the provider is not expected to list them. */
  retired: boolean;
}

/** Every model the worker can price, by spec. A catalog row overrides its built-in. */
export async function knownModels(prisma: PrismaClient): Promise<Map<string, KnownModel>> {
  const rows = await prisma.modelCatalogEntry.findMany({
    select: { displayName: true, kind: true, modelId: true, provider: true, status: true },
  });
  const known = new Map<string, KnownModel>();
  for (const m of BUILTIN_MODELS) {
    known.set(builtinModelSpec(m), {
      displayName: null,
      kind: m.kind,
      modelId: m.modelId,
      provider: m.provider,
      retired: m.status === 'RETIRED',
    });
  }
  for (const r of rows) {
    known.set(`${r.provider}/${r.modelId}`, {
      displayName: r.displayName ?? null,
      kind: r.kind ?? 'CHAT',
      modelId: r.modelId,
      provider: r.provider,
      retired: r.status === 'RETIRED',
    });
  }
  return known;
}

/** Every spec the worker can price: catalog rows plus the built-in table. */
export async function pricedSpecs(prisma: PrismaClient): Promise<Set<string>> {
  return new Set((await knownModels(prisma)).keys());
}

export interface DiscoveredModel {
  modelId: string;
  /** A guess: Google says which methods a model serves; elsewhere the id is read. */
  kind: ModelKind;
  displayName: string | null;
}

export type DiscoveredSpec = DiscoveredModel & { spec: string };

export interface ProviderDiscovery {
  provider: string;
  ok: boolean;
  error?: string;
  /** Models the provider lists that the catalog and built-in table both lack. */
  models: DiscoveredSpec[];
  /**
   * Priced, not retired, and absent from a listing that succeeded — flagged for
   * an admin to look at, never retired. Empty when the listing failed or was cut
   * short, because a model missing from a partial list proves nothing.
   */
  retirementCandidates: DiscoveredSpec[];
  /** False when paging stopped at {@link MAX_PAGES} with more left to read. */
  complete: boolean;
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
  /** Every id the page lists, whether or not it is a model a text agent could run. */
  ids: string[];
  /** Query parameters for the next page, or null when this was the last. */
  next: Record<string, string> | null;
  /** False when the body is not a list in the shape this provider returns. */
  recognised: boolean;
  /** The provider says more pages exist but gives a continuation this code cannot follow. */
  unfollowable: boolean;
}

/** Parses one page of a provider's list-models response. Unknown shapes yield no models. */
export function parseModelListPage(provider: string, body: unknown): Page {
  const b = (body ?? {}) as Record<string, unknown>;
  if (provider === 'google') {
    const models = Array.isArray(b.models) ? (b.models as Array<Record<string, unknown>>) : [];
    const next =
      typeof b.nextPageToken === 'string' && b.nextPageToken
        ? { pageToken: b.nextPageToken }
        : null;
    return {
      ids: models.flatMap((m) =>
        typeof m.name === 'string' && m.name ? [m.name.replace(/^models\//, '')] : []
      ),
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
      next,
      recognised: Array.isArray(b.models),
      unfollowable: false,
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
  const claimsMore =
    b.has_more === true || (typeof b.next_page_token === 'string' && b.next_page_token !== '');
  return {
    ids: data.flatMap((m) => (typeof m.id === 'string' && m.id ? [m.id] : [])),
    models,
    next,
    recognised: Array.isArray(b.data),
    unfollowable: claimsMore && next === null,
  };
}

/** The first page asks for as much as each provider allows in one response. */
function firstPageQuery(provider: string): Record<string, string> {
  if (provider === 'anthropic') {
    return { limit: '1000' };
  }
  return provider === 'google' ? { pageSize: '1000' } : {};
}

/** One credential's provider listing, following pages up to {@link MAX_PAGES}. */
export type ProviderListing =
  | {
      ok: true;
      /** Models a text agent could run — what a suggestion may name. */
      models: DiscoveredModel[];
      /** Every id listed, speech and image models included — what "still listed" means. */
      listedIds: Set<string>;
      /**
       * False when paging stopped with more left to read, when the provider
       * signalled more pages it gave no cursor for, or when it listed nothing.
       * Only a complete listing can say a model is gone.
       */
      complete: boolean;
    }
  | { ok: false; error: string };

export async function listProviderModels(args: {
  provider: string;
  apiKey: string;
  apiBase?: string | null;
  allowPrivateNetwork?: boolean;
}): Promise<ProviderListing> {
  const models: DiscoveredModel[] = [];
  const listedIds = new Set<string>();
  let unfollowable = false;
  let query: Record<string, string> | null = firstPageQuery(args.provider);
  for (let page = 0; query && page < MAX_PAGES; page++) {
    const request = modelListRequest({ ...args, query });
    if ('error' in request) {
      return { error: safeRequestError(request.error), ok: false };
    }
    let res: Response;
    try {
      res = await modelListFetch(request.url, args.allowPrivateNetwork === true)(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (err) {
      return { error: safeFetchError(err), ok: false };
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, ok: false };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: DISCOVERY_ERRORS.unrecognised, ok: false };
    }
    const parsed = parseModelListPage(args.provider, body);
    if (!parsed.recognised) {
      return { error: DISCOVERY_ERRORS.unrecognised, ok: false };
    }
    unfollowable ||= parsed.unfollowable;
    models.push(...parsed.models);
    for (const id of parsed.ids) {
      listedIds.add(id);
    }
    query = parsed.next;
  }
  return {
    complete: query === null && !unfollowable && listedIds.size > 0,
    listedIds,
    models: models.filter((m) => !NON_TEXT_MODEL.test(m.modelId)),
    ok: true,
  };
}

/**
 * Lists models through every GLOBAL credential, in parallel, and keeps the ones
 * nothing prices — plus, per provider, the priced ones it no longer lists. One
 * provider failing — a bad key, a timeout — is reported on its own entry and
 * never stops the others, and never yields a retirement candidate.
 */
export async function discoverProviderModels(prisma: PrismaClient): Promise<ProviderDiscovery[]> {
  const [credentials, known] = await Promise.all([
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
    knownModels(prisma),
  ]);
  const { decryptSecret } = await import('./crypto.js');
  return Promise.all(
    credentials.map(async (cred): Promise<ProviderDiscovery> => {
      const failed = (error: string): ProviderDiscovery => ({
        complete: false,
        error,
        models: [],
        ok: false,
        provider: cred.provider,
        retirementCandidates: [],
      });
      let apiKey: string;
      try {
        apiKey = decryptSecret({
          authTag: cred.apiKeyAuthTag,
          ciphertext: cred.apiKeyCiphertext,
          keyVersion: cred.keyVersion,
          nonce: cred.apiKeyNonce,
        });
      } catch {
        return failed('credential could not be decrypted');
      }
      const listed = await listProviderModels({
        allowPrivateNetwork: cred.allowPrivateNetwork,
        apiBase: cred.apiBase,
        apiKey,
        provider: cred.provider,
      });
      if (!listed.ok) {
        return failed(listed.error);
      }
      const seen = new Set<string>();
      const models = listed.models
        .map((m) => ({ ...m, spec: `${cred.provider}/${m.modelId}` }))
        .filter((m) => !known.has(m.spec) && !seen.has(m.spec) && seen.add(m.spec))
        .sort((a, b) => a.spec.localeCompare(b.spec));
      const retirementCandidates = listed.complete
        ? [...known.entries()]
            .filter(
              ([, k]) =>
                k.provider === cred.provider && !k.retired && !listed.listedIds.has(k.modelId)
            )
            .map(([spec, k]) => ({
              displayName: k.displayName,
              kind: k.kind,
              modelId: k.modelId,
              spec,
            }))
            .sort((a, b) => a.spec.localeCompare(b.spec))
        : [];
      return {
        complete: listed.complete,
        models,
        ok: true,
        provider: cred.provider,
        retirementCandidates,
      };
    })
  );
}
