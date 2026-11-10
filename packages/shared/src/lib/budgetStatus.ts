/**
 * The pure core of a budget status, shared by the gateway's meters and the worker's team report
 * digest so the two cannot disagree: a state and a percentage, never an amount.
 *
 * Two caps can refuse a launch on a team's repositories: the organization's and the team's own.
 * The status shown is the one that is tighter, by the share of its cap already used.
 */
import type { BudgetStatus } from '../types/api.js';
import { usdToCents } from './billing.js';
import { forecastMonthlyBudget } from './budgetForecast.js';

export interface OrgBudgetInputs {
  monthlyBudgetUsdCents: number | null;
  budgetAlertThresholdPercent: number | null;
}

/**
 * The status for one cap, threshold and month-to-date spend. Pure, and the one core an
 * organization's and a team's status share: only `scope` differs.
 */
export function budgetStatusFor(
  org: OrgBudgetInputs,
  spendUsd: number,
  now: Date,
  scope: BudgetStatus['scope'] = 'org'
): BudgetStatus {
  const cap = org.monthlyBudgetUsdCents;
  if (cap == null) {
    return {
      alertThresholdPercent: org.budgetAlertThresholdPercent,
      percentUsed: null,
      scope,
      state: 'no_cap',
    };
  }
  const spentCents = usdToCents(spendUsd);
  // A zero cap refuses every launch, so it reads as full whatever has been spent.
  const percentUsed = cap <= 0 ? 100 : Math.round((spentCents / cap) * 1000) / 10;
  const forecast = forecastMonthlyBudget({
    alertThresholdPercent: org.budgetAlertThresholdPercent,
    monthlyBudgetUsdCents: cap,
    now,
    spendUsd,
  });
  let state = forecast.status;
  // Inside the first day of the month a pace is an extrapolation from hours of spend: $1 at half
  // past midnight "projects" past a $1000 cap. Without a trustworthy pace the state falls back to
  // what is known, the alert threshold.
  if (state === 'projected_over' && forecast.lowConfidence) {
    state =
      forecast.alertThresholdUsd !== null && spendUsd >= forecast.alertThresholdUsd
        ? 'alert'
        : 'ok';
  }
  if (spentCents >= cap) {
    state = 'over';
  }
  return {
    alertThresholdPercent: org.budgetAlertThresholdPercent,
    percentUsed,
    scope,
    state,
  };
}

const SEVERITY: Record<BudgetStatus['state'], number> = {
  alert: 1,
  no_cap: -1,
  ok: 0,
  over: 3,
  projected_over: 2,
};

/**
 * The tighter of two statuses: the one with the larger share of its cap used. An equal share goes
 * to the more severe state (a cap that refuses launches beats one that merely has not yet), and a
 * remaining tie to the team, the more specific of the two. A side with no cap never binds; with
 * neither capped the answer is the organization's `no_cap` status when given, else the team's.
 * Pure.
 */
export function tighterBudgetStatus(
  org: BudgetStatus | null | undefined,
  team: BudgetStatus | null | undefined
): BudgetStatus | null {
  const capped = [team, org].filter(
    (s): s is BudgetStatus => !!s && s.state !== 'no_cap' && s.percentUsed !== null
  );
  if (capped.length === 0) {
    return org ?? team ?? null;
  }
  return capped.reduce((best, candidate) => {
    const bestPct = best.percentUsed ?? 0;
    const candidatePct = candidate.percentUsed ?? 0;
    if (candidatePct !== bestPct) {
      return candidatePct > bestPct ? candidate : best;
    }
    return SEVERITY[candidate.state] > SEVERITY[best.state] ? candidate : best;
  });
}
