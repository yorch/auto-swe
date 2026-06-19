/**
 * Billing helpers shared between the gateway (budget-cap reader) and the worker
 * (OrgMonthlyUsage writer). Keeping the month-bucket formula in one place keeps
 * the writer and reader from silently diverging (e.g. a timezone change), which
 * would make the budget cap stop matching the accrued row.
 */

/** Current calendar month as `'YYYY-MM'`, e.g. `'2026-06'` (UTC). */
export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
