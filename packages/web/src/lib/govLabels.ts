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
