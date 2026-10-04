/**
 * The models this repo ships prices for. One entry per `<provider>/<model-id>`
 * spec, in USD per million tokens at base (non-cached, non-batch) rates.
 * Verified against:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing  (Sep 2026)
 * - OpenAI:    https://developers.openai.com/api/docs/pricing  (Sep 2026)
 * - Google:    https://ai.google.dev/gemini-api/docs/pricing  (Sep 2026)
 *
 * A spec missing here is priced at zero and emits `llm.cost_pricing_known=false`,
 * so USD budgets never see its spend — `builtinModels.test.ts` fails the build
 * if any model this repo seeds is missing.
 *
 * Prompt caching is priced separately, as multiples of these input prices
 * (`cacheMultipliers` below). Caveats these prices do NOT account for — set a
 * customized catalog price if any apply to your deployment:
 *  - Batch API discount (50%) — nothing in this repo calls a batch API
 *  - Anthropic data-residency premium (1.1x for `inference_geo: us`)
 *  - Anthropic fast-mode premium (6x on Opus 4.6)
 *  - Gemini 2.5 Pro / 3.1 Pro >200K-token surcharge (input doubles)
 */

/**
 * Where this table lives in the repository. The `model-catalog-refresh` template, its
 * precondition step, its changed-files guard and its gate all name this one constant;
 * `builtinModels.test.ts` fails if the file is moved without updating it.
 */
export const BUILTIN_MODELS_PATH = 'packages/shared/src/lib/builtinModels.ts';

export type BuiltinModelKind = 'CHAT' | 'EMBEDDING';

/** RETIRED models are still priced: pinned agent versions and history bill against them. */
export type BuiltinModelStatus = 'ACTIVE' | 'RETIRED';

export interface BuiltinModel {
  /** Lowercase, as `parseProviderModelSpec` returns it. */
  provider: string;
  modelId: string;
  kind: BuiltinModelKind;
  status: BuiltinModelStatus;
  inputUsdPerMTok: number;
  /** Zero for embedding models, which bill input only. */
  outputUsdPerMTok: number;
  /**
   * The official pricing page these prices were read from: the provider's page
   * cited in this file's header, not a per-model anchor (anchors rot; the page is
   * what a reviewer opens). `builtinModels.test.ts` requires an https URL on a host
   * it fixes per provider, and that the header cites exactly those pages, so neither a
   * row nor the header can widen the allowlist.
   */
  priceSourceUrl: string;
}

export function builtinModelSpec(model: Pick<BuiltinModel, 'provider' | 'modelId'>): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * Prompt-cache rates as multiples of a model's input price: `read` for input
 * served from the provider's cache, `write` for input written into it with the
 * default 5-minute TTL, `write1h` for input written with the 1-hour TTL. They
 * apply to whatever input price the call is costed at — a customized catalog
 * price included — so a catalog edit never needs a second edit here.
 */
export interface CacheMultipliers {
  read: number;
  write: number;
  write1h: number;
}

/** Cached input priced as ordinary input: no published discount is known. */
const NO_CACHE_DISCOUNT: CacheMultipliers = { read: 1, write: 1, write1h: 1 };

/** Vendors that publish one caching rule for every model. */
const PROVIDER_CACHE_MULTIPLIERS: Readonly<Record<string, CacheMultipliers>> = {
  // Reads 0.1x input, 5-minute writes 1.25x, 1-hour writes 2x, on every Claude model.
  anthropic: { read: 0.1, write: 1.25, write1h: 2 },
};

/**
 * Vendors that price caching model by model. OpenAI caches automatically and
 * charges nothing to write, so only the read rate differs from 1.
 */
const MODEL_CACHE_MULTIPLIERS: Readonly<Record<string, CacheMultipliers>> = {
  'openai/gpt-5': { read: 0.1, write: 1, write1h: 1 },
};

/**
 * The cache rates for a `<provider>/<model-id>` spec: the model's own entry,
 * then its provider's rule, else no discount. Defaulting to 1 overstates the
 * cost of a cached read rather than understating it, so a USD budget errs
 * toward stopping early.
 */
export function cacheMultipliers(spec: string): CacheMultipliers {
  return (
    MODEL_CACHE_MULTIPLIERS[spec] ??
    PROVIDER_CACHE_MULTIPLIERS[spec.slice(0, spec.indexOf('/'))] ??
    NO_CACHE_DISCOUNT
  );
}

export const BUILTIN_MODELS: ReadonlyArray<BuiltinModel> = [
  // Anthropic — Fable 5.x, above the Opus tier ($10 / $50, verified Sep 2026)
  {
    inputUsdPerMTok: 10,
    kind: 'CHAT',
    modelId: 'claude-fable-5',
    outputUsdPerMTok: 50,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 10,
    kind: 'CHAT',
    modelId: 'claude-fable-5-1',
    outputUsdPerMTok: 50,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  // Anthropic — Haiku
  {
    inputUsdPerMTok: 0.8,
    kind: 'CHAT',
    modelId: 'claude-haiku-3-5-20241022',
    outputUsdPerMTok: 4,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 1,
    kind: 'CHAT',
    modelId: 'claude-haiku-4-5-20251001',
    outputUsdPerMTok: 5,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  // Anthropic — Opus 4 / 4.1 legacy pricing ($15 / $75); Opus 4.5+ is $5 / $25
  {
    inputUsdPerMTok: 15,
    kind: 'CHAT',
    modelId: 'claude-opus-4-1-20250805',
    outputUsdPerMTok: 75,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 5,
    kind: 'CHAT',
    modelId: 'claude-opus-4-5',
    outputUsdPerMTok: 25,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 5,
    kind: 'CHAT',
    modelId: 'claude-opus-4-6',
    outputUsdPerMTok: 25,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 5,
    kind: 'CHAT',
    modelId: 'claude-opus-4-8',
    outputUsdPerMTok: 25,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 15,
    kind: 'CHAT',
    modelId: 'claude-opus-4-20250514',
    outputUsdPerMTok: 75,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  // Anthropic — Opus 5 ($5 / $25) and Opus 5.5 ($4 / $20), verified Sep 2026
  {
    inputUsdPerMTok: 5,
    kind: 'CHAT',
    modelId: 'claude-opus-5',
    outputUsdPerMTok: 25,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 4,
    kind: 'CHAT',
    modelId: 'claude-opus-5-5',
    outputUsdPerMTok: 20,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  // Anthropic — Sonnet 4.x ($3 / $15)
  {
    inputUsdPerMTok: 3,
    kind: 'CHAT',
    modelId: 'claude-sonnet-4-5',
    outputUsdPerMTok: 15,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 3,
    kind: 'CHAT',
    modelId: 'claude-sonnet-4-6',
    outputUsdPerMTok: 15,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 3,
    kind: 'CHAT',
    modelId: 'claude-sonnet-4-20250514',
    outputUsdPerMTok: 15,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'RETIRED',
  },
  // Anthropic — Sonnet 5.x ($2 / $10, verified Sep 2026)
  {
    inputUsdPerMTok: 2,
    kind: 'CHAT',
    modelId: 'claude-sonnet-5',
    outputUsdPerMTok: 10,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 2,
    kind: 'CHAT',
    modelId: 'claude-sonnet-5-5',
    outputUsdPerMTok: 10,
    priceSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    provider: 'anthropic',
    status: 'ACTIVE',
  },
  // Google — Gemini 2.5 (base prices; Pro input/output ~doubles above 200K context)
  {
    inputUsdPerMTok: 0.3,
    kind: 'CHAT',
    modelId: 'gemini-2.5-flash',
    outputUsdPerMTok: 2.5,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.1,
    kind: 'CHAT',
    modelId: 'gemini-2.5-flash-lite',
    outputUsdPerMTok: 0.4,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 1.25,
    kind: 'CHAT',
    modelId: 'gemini-2.5-pro',
    outputUsdPerMTok: 10,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  // Google — Gemini 3.x. Pro is still `-preview`; 3 Pro Preview and
  // 3.1 Flash-Lite Preview are shut down (kept for historical runs).
  {
    inputUsdPerMTok: 0.5,
    kind: 'CHAT',
    modelId: 'gemini-3-flash-preview',
    outputUsdPerMTok: 3,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.25,
    kind: 'CHAT',
    modelId: 'gemini-3.1-flash-lite',
    outputUsdPerMTok: 1.5,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.25,
    kind: 'CHAT',
    modelId: 'gemini-3.1-flash-lite-preview',
    outputUsdPerMTok: 1.5,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'RETIRED',
  },
  {
    inputUsdPerMTok: 2,
    kind: 'CHAT',
    modelId: 'gemini-3.1-pro-preview',
    outputUsdPerMTok: 12,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 1.5,
    kind: 'CHAT',
    modelId: 'gemini-3.5-flash',
    outputUsdPerMTok: 9,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.3,
    kind: 'CHAT',
    modelId: 'gemini-3.5-flash-lite',
    outputUsdPerMTok: 2.5,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  // Listed at $0.75 / $3.75 through 2026-12-31. This records the $1.50 / $7.50
  // list price that applies from 2027-01-01, so budgets over-count rather than
  // under-count once the introductory price lapses.
  {
    inputUsdPerMTok: 1.5,
    kind: 'CHAT',
    modelId: 'gemini-3.8-flash',
    outputUsdPerMTok: 7.5,
    priceSourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    provider: 'google',
    status: 'ACTIVE',
  },
  // OpenAI — GPT-5 line
  {
    inputUsdPerMTok: 1.25,
    kind: 'CHAT',
    modelId: 'gpt-5',
    outputUsdPerMTok: 10,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 5,
    kind: 'CHAT',
    modelId: 'gpt-5.5',
    outputUsdPerMTok: 30,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 30,
    kind: 'CHAT',
    modelId: 'gpt-5.5-pro',
    outputUsdPerMTok: 180,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  // OpenAI — GPT-6 line (verified Sep 2026)
  {
    inputUsdPerMTok: 10,
    kind: 'CHAT',
    modelId: 'gpt-6-astra',
    outputUsdPerMTok: 50,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.1,
    kind: 'CHAT',
    modelId: 'gpt-6-luna',
    outputUsdPerMTok: 0.5,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 2,
    kind: 'CHAT',
    modelId: 'gpt-6.1-sol',
    outputUsdPerMTok: 10,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  // OpenAI — embeddings (input only)
  {
    inputUsdPerMTok: 0.13,
    kind: 'EMBEDDING',
    modelId: 'text-embedding-3-large',
    outputUsdPerMTok: 0,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
  {
    inputUsdPerMTok: 0.02,
    kind: 'EMBEDDING',
    modelId: 'text-embedding-3-small',
    outputUsdPerMTok: 0,
    priceSourceUrl: 'https://developers.openai.com/api/docs/pricing',
    provider: 'openai',
    status: 'ACTIVE',
  },
];
