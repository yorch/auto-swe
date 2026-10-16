import type { PrismaClient } from '@auto-swe/shared';
import {
  DISCOVERY_ERRORS,
  listGlobalProviderModels,
  type ModelKind,
  type ProviderListing,
} from '@auto-swe/shared/lib/modelDiscovery';
import {
  loadPriceList,
  lookupPriceList,
  type PriceListDeps,
  resetPriceListCache,
} from '@auto-swe/shared/lib/modelPriceList';
import { isBuiltInProvider } from '@auto-swe/shared/lib/modelSpec';

/**
 * Price hints for the catalog's Add form and bulk add: what a model is
 * published to cost, so an admin confirms a price instead of typing it. Two
 * sources, in order:
 *
 * 1. The provider's own model listing, for OpenAI-compatible providers whose
 *    listing states prices (OpenRouter's `pricing`), read through the GLOBAL
 *    credential exactly as discovery reads it.
 * 2. The community price list (`@auto-swe/shared/lib/modelPriceList`).
 *
 * A hint is never a price: nothing here writes the catalog, and the pricing path
 * never reads a hint. Failures are fixed strings, like discovery's.
 */

export type PriceHintSource = 'provider' | 'priceList';

export interface PriceHint {
  source: PriceHintSource;
  /** The id or price-list key the hint was found under. */
  matchedId: string;
  /** The price list's URL; absent for a provider listing. */
  url?: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadMultiplier?: number;
  cacheWrite5mMultiplier?: number;
  cacheWrite1hMultiplier?: number;
  /** What the price list says the model is, where it says chat or embedding. */
  kind?: ModelKind;
}

export interface PriceHintResult {
  hints: PriceHint[];
  /** Sources that were asked and could not answer — not ones that had no entry. */
  unavailable: Array<{ source: PriceHintSource; reason: string }>;
}

/** How long a provider listing answers hints before it is asked again. */
const PROVIDER_TTL_MS = 5 * 60_000;

export interface PriceHintDeps extends PriceListDeps {
  listProvider?: (prisma: PrismaClient, provider: string) => Promise<ProviderListing | null>;
}

const providerCache = new Map<string, { at: number; listing: Promise<ProviderListing | null> }>();

/** Forgets every cached listing and price list. For tests. */
export function resetPriceHintCaches(): void {
  providerCache.clear();
  resetPriceListCache();
}

function cachedProviderListing(
  prisma: PrismaClient,
  provider: string,
  deps: PriceHintDeps
): Promise<ProviderListing | null> {
  const now = (deps.now ?? Date.now)();
  const hit = providerCache.get(provider);
  if (hit && now - hit.at < PROVIDER_TTL_MS) {
    return hit.listing;
  }
  const listing = (deps.listProvider ?? listGlobalProviderModels)(prisma, provider);
  providerCache.set(provider, { at: now, listing });
  // Only a successful listing is reused; the next hint asks a failed provider again.
  void listing.then(
    (l) => {
      if (!l?.ok) {
        providerCache.delete(provider);
      }
    },
    () => providerCache.delete(provider)
  );
  return listing;
}

/** Every hint for `provider/modelId`, provider listing first. Never throws on a source failing. */
export async function findPriceHints(
  prisma: PrismaClient,
  provider: string,
  modelId: string,
  deps: PriceHintDeps = {}
): Promise<PriceHintResult> {
  const hints: PriceHint[] = [];
  const unavailable: PriceHintResult['unavailable'] = [];

  // A built-in provider's listing states no price, and behind a proxy it lists the proxy's ids.
  const fromProvider = isBuiltInProvider(provider)
    ? Promise.resolve(null)
    : cachedProviderListing(prisma, provider, deps).catch(
        (): ProviderListing => ({ error: DISCOVERY_ERRORS.unrecognised, ok: false })
      );
  const fromList = loadPriceList(deps);

  const [listing, list] = await Promise.all([fromProvider, fromList]);
  if (listing && !listing.ok) {
    unavailable.push({ reason: listing.error, source: 'provider' });
  } else if (listing?.ok) {
    const listed = listing.models.find((m) => m.modelId === modelId)?.listedPrice;
    if (listed) {
      hints.push({ matchedId: modelId, source: 'provider', ...listed });
    }
  }
  if (list && !list.ok) {
    unavailable.push({ reason: list.error, source: 'priceList' });
  } else if (list?.ok) {
    const found = lookupPriceList(list.table, provider, modelId);
    if (found) {
      hints.push({ ...found, source: 'priceList', url: list.url });
    }
  }
  return { hints, unavailable };
}
