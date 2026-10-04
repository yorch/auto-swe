/**
 * Pure helpers over the model catalog (`/api/v1/platform/model-catalog`) for
 * the model pickers and the Catalog tab.
 */

export type ModelKind = 'CHAT' | 'EMBEDDING';
export type ModelStatus = 'ACTIVE' | 'DEPRECATED' | 'RETIRED';

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  modelId: string;
  kind: ModelKind;
  displayName: string | null;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  status: ModelStatus;
  notes: string | null;
  isBuiltIn: boolean;
  isCustomized: boolean;
  /** Cache rates as multiples of the input price; null falls back to `cacheDefaults`. */
  cacheReadMultiplier?: number | null;
  cacheWrite5mMultiplier?: number | null;
  cacheWrite1hMultiplier?: number | null;
  /** The code-table rates a null multiplier stands for. */
  cacheDefaults?: {
    cacheReadMultiplier: number;
    cacheWrite5mMultiplier: number;
    cacheWrite1hMultiplier: number;
  };
  /** For a built-in row: the values code ships, which a customized row may diverge from. */
  builtin: {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    kind: ModelKind;
    status: ModelStatus;
  } | null;
}

export function entrySpec(e: Pick<ModelCatalogEntry, 'provider' | 'modelId'>): string {
  return `${e.provider}/${e.modelId}`;
}

function usd(n: number): string {
  return `$${Number(n.toFixed(4))}`;
}

/** `$4 / $20 per MTok`, or `$0.13 per MTok` for an embedding model (input only), or `free`. */
export function formatPrice(
  e: Pick<ModelCatalogEntry, 'inputUsdPerMTok' | 'outputUsdPerMTok' | 'kind'>
): string {
  if (e.inputUsdPerMTok === 0 && e.outputUsdPerMTok === 0) {
    return 'free';
  }
  return e.kind === 'EMBEDDING' && e.outputUsdPerMTok === 0
    ? `${usd(e.inputUsdPerMTok)} per MTok`
    : `${usd(e.inputUsdPerMTok)} / ${usd(e.outputUsdPerMTok)} per MTok`;
}

/**
 * Picker options for a model-spec field: each cataloged model, its price as the
 * second line, ACTIVE models first, DEPRECATED ones labelled. A RETIRED model is
 * left out — the catalog route already omits it — since nothing should newly
 * pick it. The option text is the spec itself, as a custom-value combobox needs.
 */
export function modelSpecOptions(entries: ModelCatalogEntry[]) {
  return entries
    .filter((e) => e.status !== 'RETIRED')
    .sort(
      (a, b) =>
        Number(a.status === 'DEPRECATED') - Number(b.status === 'DEPRECATED') ||
        entrySpec(a).localeCompare(entrySpec(b))
    )
    .map((e) => ({
      description: e.status === 'DEPRECATED' ? `deprecated · ${formatPrice(e)}` : formatPrice(e),
      label: entrySpec(e),
      value: entrySpec(e),
    }));
}

/**
 * Whether code now ships different values than a customized built-in row holds
 * — a correction the row is not getting until an admin resets it.
 */
export function divergesFromBuiltin(e: ModelCatalogEntry): boolean {
  return (
    e.isCustomized &&
    e.builtin !== null &&
    (e.builtin.inputUsdPerMTok !== e.inputUsdPerMTok ||
      e.builtin.outputUsdPerMTok !== e.outputUsdPerMTok ||
      e.builtin.kind !== e.kind ||
      e.builtin.status !== e.status)
  );
}

/** A role's price as `/model-catalog/role-pricing` returns it. */
export interface RolePrice {
  modelSpec: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/**
 * The cost estimator's per-role `pricing` override from live role prices. A role
 * the gateway could not price is absent, so the estimator keeps its default.
 */
export function estimatorPricing(
  roles: Record<string, RolePrice>
): Record<string, { inputUsdPerM: number; outputUsdPerM: number }> {
  return Object.fromEntries(
    Object.entries(roles).map(([role, p]) => [
      role,
      { inputUsdPerM: p.inputUsdPerMTok, outputUsdPerM: p.outputUsdPerMTok },
    ])
  );
}
