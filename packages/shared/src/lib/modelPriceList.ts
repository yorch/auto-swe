import { resolveSetting } from '../config/index.js';
import {
  DISCOVERY_ERRORS,
  isPrivateHostListed,
  type ModelKind,
  modelListFetch,
  perTokenToPerMTok,
  resolvePrivateModelHosts,
  safeFetchError,
} from './modelDiscovery.js';
import { checkProbeUrl } from './ssrfGuard.js';

/**
 * A community price list in LiteLLM's `model_prices_and_context_window.json`
 * format, at `models.priceListUrl` (empty turns it off). It suggests prices — to
 * the catalog's Add form and bulk add, and as a cross-check to the catalog
 * refresh — and is never a price: nothing costs a call from it.
 *
 * The URL is operator-supplied, so the fetch goes through the model-list guard
 * (resolved, checked, pinned; a private host only when `models.privateNetworkHosts`
 * lists it), refuses redirects, and caps the body. Failures are fixed strings,
 * like discovery's: no fetch error text or response body leaves this module.
 */

/** One price-list entry, as the catalog's fields. */
export interface PriceListEntry {
  /** The price-list key the entry was found under. */
  matchedId: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadMultiplier?: number;
  cacheWrite5mMultiplier?: number;
  cacheWrite1hMultiplier?: number;
  /** What the list says the model is, where it says chat or embedding. */
  kind?: ModelKind;
}

export const PRICE_LIST_ERRORS = {
  tooLarge: 'price list too large',
  unrecognised: 'unrecognised price list',
} as const;

/** How long a fetched price list is kept; a failed fetch is retried sooner. */
const PRICE_LIST_TTL_MS = 6 * 60 * 60_000;
const PRICE_LIST_RETRY_MS = 5 * 60_000;
const PRICE_LIST_TIMEOUT_MS = 15_000;
/** LiteLLM's file is a few MB; anything far past that is not the file. */
const PRICE_LIST_MAX_BYTES = 32 * 1024 * 1024;

/** The catalog's own limit on a cache multiplier. */
const MAX_MULTIPLIER = 20;

/** Where a provider name differs between auto-swe specs and LiteLLM's `litellm_provider`. */
const LITELLM_PROVIDER: Readonly<Record<string, string>> = {
  fireworks: 'fireworks_ai',
  google: 'gemini',
  together: 'together_ai',
};

export type PriceTable = Record<string, unknown>;
/** A loaded list, or why it could not be loaded. */
export type PriceListLoad =
  | { ok: true; table: PriceTable; url: string }
  | { ok: false; error: string };
type PriceListFetch = { ok: true; table: PriceTable } | { ok: false; error: string };

export interface PriceListDeps {
  /** The fetch; defaults to the model-list guard over `models.privateNetworkHosts`. */
  fetcher?: typeof globalThis.fetch;
  now?: () => number;
  /** The list's URL; defaults to `models.priceListUrl`. */
  priceListUrl?: () => Promise<string>;
}

let priceListCache: {
  url: string;
  at: number;
  ttl: number;
  result: Promise<PriceListFetch>;
} | null = null;

/** Forgets the cached list. For tests. */
export function resetPriceListCache(): void {
  priceListCache = null;
}

async function resolvePriceListUrl(): Promise<string> {
  try {
    return await resolveSetting('models.priceListUrl');
  } catch {
    // An unreadable setting turns the lookup off rather than guessing a URL.
    return '';
  }
}

/** A multiple of the input rate, or undefined when either side is not a usable price. */
function multiplier(raw: unknown, inputPerToken: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || inputPerToken <= 0) {
    return undefined;
  }
  const m = Math.round((raw / inputPerToken) * 10_000) / 10_000;
  return m <= MAX_MULTIPLIER ? m : undefined;
}

function kindOf(mode: unknown): ModelKind | undefined {
  if (mode === 'embedding') {
    return 'EMBEDDING';
  }
  return mode === 'chat' || mode === 'completion' || mode === 'responses' ? 'CHAT' : undefined;
}

/**
 * The price-list entry for `provider/modelId`. LiteLLM keys most
 * models as `<litellm_provider>/<id>` and some first-party ones by bare id, so
 * both are tried, and an entry counts only when its `litellm_provider` is the
 * provider asked about — `gpt-4o` under Azure is not OpenAI's price.
 */
export function lookupPriceList(
  table: PriceTable,
  provider: string,
  modelId: string
): PriceListEntry | null {
  const lp = LITELLM_PROVIDER[provider] ?? provider;
  for (const key of [`${lp}/${modelId}`, modelId]) {
    if (!Object.hasOwn(table, key)) {
      continue;
    }
    const entry = table[key] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || entry.litellm_provider !== lp) {
      continue;
    }
    const kind = kindOf(entry.mode);
    const input = perTokenToPerMTok(entry.input_cost_per_token);
    // An embedding entry may leave its output rate out: it bills input only.
    const output =
      entry.output_cost_per_token === undefined && kind === 'EMBEDDING'
        ? 0
        : perTokenToPerMTok(entry.output_cost_per_token);
    if (input === null || output === null) {
      continue;
    }
    const inputPerToken = Number(entry.input_cost_per_token);
    const cacheRead = multiplier(entry.cache_read_input_token_cost, inputPerToken);
    const cacheWrite5m = multiplier(entry.cache_creation_input_token_cost, inputPerToken);
    const cacheWrite1h = multiplier(entry.cache_creation_input_token_cost_above_1hr, inputPerToken);
    return {
      inputUsdPerMTok: input,
      matchedId: key,
      outputUsdPerMTok: output,
      ...(cacheRead === undefined ? {} : { cacheReadMultiplier: cacheRead }),
      ...(cacheWrite5m === undefined ? {} : { cacheWrite5mMultiplier: cacheWrite5m }),
      ...(cacheWrite1h === undefined ? {} : { cacheWrite1hMultiplier: cacheWrite1h }),
      ...(kind ? { kind } : {}),
    };
  }
  return null;
}

/** The body as text, or null once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    return null;
  }
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPriceList(
  url: string,
  fetcher: typeof globalThis.fetch | undefined
): Promise<PriceListFetch> {
  const fail = (error: string): PriceListFetch => ({ error, ok: false });
  const privateHosts = await resolvePrivateModelHosts();
  const safety = checkProbeUrl(url, { allowPrivate: isPrivateHostListed(url, privateHosts) });
  if (!safety.ok || safety.url.username || safety.url.password) {
    return fail(DISCOVERY_ERRORS.blocked);
  }
  const doFetch = fetcher ?? modelListFetch(privateHosts);
  let res: Response;
  try {
    res = await doFetch(safety.url.toString(), {
      // The guard checked this URL, not wherever it redirects to.
      redirect: 'error',
      signal: AbortSignal.timeout(PRICE_LIST_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(safeFetchError(err));
  }
  if (!res.ok) {
    return fail(`HTTP ${res.status}`);
  }
  let text: string | null;
  try {
    text = await readCapped(res, PRICE_LIST_MAX_BYTES);
  } catch (err) {
    return fail(safeFetchError(err));
  }
  if (text === null) {
    return fail(PRICE_LIST_ERRORS.tooLarge);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, table: parsed as PriceTable };
    }
  } catch {
    // Falls through to the fixed error below.
  }
  return fail(PRICE_LIST_ERRORS.unrecognised);
}

function cachedPriceList(url: string, deps: PriceListDeps): Promise<PriceListFetch> {
  const now = (deps.now ?? Date.now)();
  if (
    priceListCache &&
    priceListCache.url === url &&
    now - priceListCache.at < priceListCache.ttl
  ) {
    return priceListCache.result;
  }
  const entry = {
    at: now,
    result: fetchPriceList(url, deps.fetcher),
    ttl: PRICE_LIST_TTL_MS,
    url,
  };
  priceListCache = entry;
  // A failure is kept for a shorter time, so a transient outage does not hide hints for hours.
  void entry.result.then((r) => {
    if (!r.ok) {
      entry.ttl = PRICE_LIST_RETRY_MS;
    }
  });
  return entry.result;
}

/**
 * The price list, fetched or from the per-process cache (six hours; five minutes
 * after a failure). Null when `models.priceListUrl` is empty. Never throws.
 */
export async function loadPriceList(deps: PriceListDeps = {}): Promise<PriceListLoad | null> {
  const url = await (deps.priceListUrl ?? resolvePriceListUrl)();
  if (!url) {
    return null;
  }
  const result = await cachedPriceList(url, deps);
  return result.ok ? { ok: true, table: result.table, url } : result;
}
