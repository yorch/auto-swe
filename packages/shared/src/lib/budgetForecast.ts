const DAY_MS = 24 * 60 * 60 * 1000;

export type BudgetForecastStatus = 'over' | 'projected_over' | 'alert' | 'ok' | 'no_cap';

export interface BudgetForecast {
  alertThresholdUsd: number | null;
  daysInMonth: number;
  elapsedDays: number;
  lowConfidence: boolean;
  monthlyBudgetUsd: number | null;
  projectedUsd: number;
  status: BudgetForecastStatus;
}

export function forecastMonthlyBudget(input: {
  alertThresholdPercent: number | null;
  monthlyBudgetUsdCents: number | null;
  now: Date;
  spendUsd: number;
}): BudgetForecast {
  const year = input.now.getUTCFullYear();
  const month = input.now.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const monthEnd = Date.UTC(year, month + 1, 1);
  const elapsedDays = (input.now.getTime() - monthStart) / DAY_MS;
  const daysInMonth = (monthEnd - monthStart) / DAY_MS;
  const projectedUsd = (input.spendUsd / Math.max(elapsedDays, Number.EPSILON)) * daysInMonth;
  const monthlyBudgetUsd =
    input.monthlyBudgetUsdCents === null ? null : input.monthlyBudgetUsdCents / 100;
  const alertThresholdUsd =
    monthlyBudgetUsd === null || input.alertThresholdPercent === null
      ? null
      : (monthlyBudgetUsd * input.alertThresholdPercent) / 100;

  let status: BudgetForecastStatus = 'ok';
  if (monthlyBudgetUsd === null) {
    status = 'no_cap';
  } else if (input.spendUsd > monthlyBudgetUsd) {
    status = 'over';
  } else if (projectedUsd > monthlyBudgetUsd) {
    status = 'projected_over';
  } else if (alertThresholdUsd !== null && input.spendUsd >= alertThresholdUsd) {
    status = 'alert';
  }

  return {
    alertThresholdUsd,
    daysInMonth,
    elapsedDays,
    lowConfidence: elapsedDays < 1,
    monthlyBudgetUsd,
    projectedUsd,
    status,
  };
}
