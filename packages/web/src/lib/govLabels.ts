/**
 * Plain-language names for the enums the govern pages show. The wire values
 * (`ORG_ADMIN`, `STANDARD`) stay in requests and filters; people read these.
 */
import type { OrgRole } from '@/hooks/useOrg';

const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  ORG_ADMIN: 'Organization admin',
  ORG_MEMBER: 'Member',
};

export function orgRoleLabel(role: string): string {
  return ORG_ROLE_LABELS[role as OrgRole] ?? role;
}

export const ORG_ROLE_OPTIONS = (['ORG_MEMBER', 'ORG_ADMIN'] as const).map((value) => ({
  label: ORG_ROLE_LABELS[value],
  value,
}));

export type BudgetTier = 'STANDARD' | 'LARGE' | 'EPIC';

const BUDGET_TIER_LABELS: Record<BudgetTier, string> = {
  EPIC: 'Epic',
  LARGE: 'Large',
  STANDARD: 'Standard',
};

export function budgetTierLabel(tier: string): string {
  return BUDGET_TIER_LABELS[tier as BudgetTier] ?? tier;
}

export const BUDGET_TIER_OPTIONS = (['STANDARD', 'LARGE', 'EPIC'] as const).map((value) => ({
  label: BUDGET_TIER_LABELS[value],
  value,
}));

const PLATFORM_ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  ENGINEER: 'Engineer',
  LEAD: 'Lead',
};

export function platformRoleLabel(role: string): string {
  return PLATFORM_ROLE_LABELS[role] ?? role;
}

const PLATFORM_ROLE_RANK: Record<string, number> = { ADMIN: 3, ENGINEER: 1, LEAD: 2 };

/** A platform-role change needs a second look when it grants admin or takes access away. */
export function roleChangeNeedsConfirm(from: string, to: string): boolean {
  return to === 'ADMIN' || (PLATFORM_ROLE_RANK[to] ?? 0) < (PLATFORM_ROLE_RANK[from] ?? 0);
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
