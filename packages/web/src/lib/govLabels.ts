/**
 * Plain-language names for the enums the govern pages show. The wire values
 * (`STANDARD`, `EPIC`) stay in requests and filters; people read these.
 */
import { BUDGET_TIERS, type BudgetTier } from '@auto-swe/shared/types/workflow';

export type { BudgetTier };

const BUDGET_TIER_LABELS: Record<BudgetTier, string> = {
  EPIC: 'Epic',
  LARGE: 'Large',
  STANDARD: 'Standard',
};

export function budgetTierLabel(tier: string): string {
  return BUDGET_TIER_LABELS[tier as BudgetTier] ?? tier;
}

export const BUDGET_TIER_OPTIONS = BUDGET_TIERS.map((value) => ({
  label: BUDGET_TIER_LABELS[value],
  value,
}));

/** A platform-role change needs a second look: it grants or takes away every capability at once. */
export function roleChangeNeedsConfirm(from: string, to: string): boolean {
  return from !== to;
}

/**
 * A readable name for a machine key (`executeImplementation`, `code_security.scan`,
 * `PR_OPENED`): split on case changes and separators, sentence-cased. For keys
 * the API does not resolve to a title.
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-/]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** An outcome type as people read it; a run with none recorded is "Not classified". */
export function outcomeTypeLabel(outcomeType: string): string {
  return outcomeType === 'unknown' ? 'Not classified' : humanizeKey(outcomeType);
}
