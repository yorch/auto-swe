/** The largest monthly cap the form accepts, in dollars; far past any real team's spend. */
export const MAX_TEAM_BUDGET_DOLLARS = 1_000_000;

export type BudgetFieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Cents as the text of a dollars field: `12345` becomes `123.45`, `5000` becomes `50`. */
export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) {
    return '';
  }
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** Cents as currency for display. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { currency: 'USD', style: 'currency' }).format(cents / 100);
}

/**
 * A dollars field as a cap in whole cents. Blank means "no team cap" (`null`, which clears it).
 * Rejects negatives, non-numbers, more than two decimals, and anything above the maximum; zero
 * is a valid cap (it blocks new work).
 */
export function dollarsInputToCents(input: string): BudgetFieldResult<number | null> {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (text === '') {
    return { ok: true, value: null };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return {
      error: text.startsWith('-')
        ? 'The monthly cap cannot be negative.'
        : 'Enter a dollar amount such as 500 or 500.50.',
      ok: false,
    };
  }
  const dollars = Number(text);
  if (dollars > MAX_TEAM_BUDGET_DOLLARS) {
    return {
      error: `The monthly cap cannot be more than ${formatCents(MAX_TEAM_BUDGET_DOLLARS * 100).replace('.00', '')}.`,
      ok: false,
    };
  }
  return { ok: true, value: Math.round(dollars * 100) };
}

/** The alert threshold field as a whole percentage from 1 to 100; blank means the default (`null`). */
export function thresholdInputToPercent(input: string): BudgetFieldResult<number | null> {
  const text = input.trim().replace(/%$/, '');
  if (text === '') {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 100) {
    return { error: 'The alert threshold must be a whole number from 1 to 100.', ok: false };
  }
  return { ok: true, value: Number(text) };
}
