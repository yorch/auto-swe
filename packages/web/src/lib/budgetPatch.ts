export interface OrgBudgetValues {
  monthlyBudgetUsdCents: number | null;
  budgetAlertThresholdPercent: number | null;
}

/** Stored cents -> the dollar text a budget input shows (`10000` -> `100.00`); `''` for no cap. */
export function centsToDollarsInput(cents: number | null | undefined): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

/** Dollar text -> whole cents, or `null` when it is not a non-negative amount of at most two decimals. */
export function dollarsInputToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  return Math.round(Number(trimmed) * 100);
}

export type BudgetPatchResult =
  | { kind: 'patch'; body: OrgBudgetValues }
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string };

/**
 * Build the PATCH body for the org budget form. The inputs are prefilled with
 * the stored values, and the endpoint takes both fields, so an untouched field
 * is sent back as its current value — editing the threshold can no longer wipe
 * the cap. The cap is typed in dollars and stored in cents. Emptying a set cap is refused here: removing it is its own explicit
 * action (`removeCapPatch`), not a side effect of a blank input.
 */
export function buildBudgetPatch(
  capDraft: string,
  thresholdDraft: string,
  current: OrgBudgetValues
): BudgetPatchResult {
  const capText = capDraft.trim();
  let cap: number | null;
  if (capText === '') {
    if (current.monthlyBudgetUsdCents != null) {
      return { error: 'Enter a cap in dollars, or use "Remove cap".', kind: 'invalid' };
    }
    cap = null;
  } else {
    cap = dollarsInputToCents(capText);
    if (cap === null) {
      return { error: 'Enter a dollar amount, like 100 or 100.50', kind: 'invalid' };
    }
  }

  const thresholdText = thresholdDraft.trim();
  const threshold = thresholdText === '' ? null : Number(thresholdText);
  if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100)) {
    return { error: 'Alert threshold must be an integer between 0 and 100', kind: 'invalid' };
  }

  if (cap === current.monthlyBudgetUsdCents && threshold === current.budgetAlertThresholdPercent) {
    return { kind: 'unchanged' };
  }
  return {
    body: { budgetAlertThresholdPercent: threshold, monthlyBudgetUsdCents: cap },
    kind: 'patch',
  };
}

/** Remove the cap and keep the stored threshold. */
export function removeCapPatch(current: OrgBudgetValues): OrgBudgetValues {
  return {
    budgetAlertThresholdPercent: current.budgetAlertThresholdPercent,
    monthlyBudgetUsdCents: null,
  };
}
