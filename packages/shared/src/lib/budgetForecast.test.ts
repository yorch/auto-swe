import { describe, expect, it } from 'vitest';
import { forecastMonthlyBudget } from './budgetForecast.js';

describe('forecastMonthlyBudget', () => {
  it('projects against fractional UTC elapsed days in a leap-year month', () => {
    const forecast = forecastMonthlyBudget({
      alertThresholdPercent: 80,
      monthlyBudgetUsdCents: 9_000,
      now: new Date('2024-02-15T12:00:00.000Z'),
      spendUsd: 50,
    });
    expect(forecast.elapsedDays).toBe(14.5);
    expect(forecast.daysInMonth).toBe(29);
    expect(forecast.projectedUsd).toBeCloseTo(100);
    expect(forecast.status).toBe('projected_over');
    expect(forecast.lowConfidence).toBe(false);
  });

  it('computes a first-day projection and marks it low confidence', () => {
    const forecast = forecastMonthlyBudget({
      alertThresholdPercent: null,
      monthlyBudgetUsdCents: 10_000,
      now: new Date('2024-02-01T12:00:00.000Z'),
      spendUsd: 5,
    });
    expect(forecast.projectedUsd).toBeCloseTo(290);
    expect(forecast.lowConfidence).toBe(true);
  });

  it('prioritizes actual overspend and reports alert thresholds otherwise', () => {
    const over = forecastMonthlyBudget({
      alertThresholdPercent: 50,
      monthlyBudgetUsdCents: 10_000,
      now: new Date('2026-06-20T00:00:00.000Z'),
      spendUsd: 101,
    });
    const alert = forecastMonthlyBudget({
      alertThresholdPercent: 50,
      monthlyBudgetUsdCents: 10_000,
      now: new Date('2026-06-20T00:00:00.000Z'),
      spendUsd: 60,
    });
    expect(over.status).toBe('over');
    expect(alert.status).toBe('alert');
    expect(alert.alertThresholdUsd).toBe(50);
  });

  it('uses no_cap when there is no monthly limit', () => {
    expect(
      forecastMonthlyBudget({
        alertThresholdPercent: 50,
        monthlyBudgetUsdCents: null,
        now: new Date('2026-06-20T00:00:00.000Z'),
        spendUsd: 60,
      }).status
    ).toBe('no_cap');
  });
});
