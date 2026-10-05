import { describe, expect, it } from 'vitest';
import {
  buildBudgetPatch,
  centsToDollarsInput,
  dollarsInputToCents,
  removeCapPatch,
} from './budgetPatch';

const CURRENT = { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 10_000 };

describe('buildBudgetPatch', () => {
  it('keeps the cap when only the threshold changes', () => {
    expect(buildBudgetPatch('100.00', '90', CURRENT)).toEqual({
      body: { budgetAlertThresholdPercent: 90, monthlyBudgetUsdCents: 10_000 },
      kind: 'patch',
    });
  });

  it('keeps the threshold when only the cap changes', () => {
    expect(buildBudgetPatch('200', '80', CURRENT)).toEqual({
      body: { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 20_000 },
      kind: 'patch',
    });
  });

  it('refuses to remove a set cap through a blank input', () => {
    expect(buildBudgetPatch('', '80', CURRENT).kind).toBe('invalid');
  });

  it('allows a blank cap when there is none', () => {
    expect(
      buildBudgetPatch('', '50', { budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: null })
    ).toEqual({
      body: { budgetAlertThresholdPercent: 50, monthlyBudgetUsdCents: null },
      kind: 'patch',
    });
  });

  it('disables the alert when the threshold is cleared', () => {
    expect(buildBudgetPatch('100', '', CURRENT)).toEqual({
      body: { budgetAlertThresholdPercent: null, monthlyBudgetUsdCents: 10_000 },
      kind: 'patch',
    });
  });

  it('reports no change', () => {
    expect(buildBudgetPatch('100.00', '80', CURRENT)).toEqual({ kind: 'unchanged' });
  });

  it('validates ranges', () => {
    expect(buildBudgetPatch('-1', '80', CURRENT).kind).toBe('invalid');
    expect(buildBudgetPatch('1.555', '80', CURRENT).kind).toBe('invalid');
    expect(buildBudgetPatch('100', '101', CURRENT).kind).toBe('invalid');
  });
});

describe('removeCapPatch', () => {
  it('clears the cap and keeps the threshold', () => {
    expect(removeCapPatch(CURRENT)).toEqual({
      budgetAlertThresholdPercent: 80,
      monthlyBudgetUsdCents: null,
    });
  });
});

describe('dollar conversion', () => {
  it('round-trips cents through the dollar text', () => {
    expect(centsToDollarsInput(10_050)).toBe('100.50');
    expect(centsToDollarsInput(null)).toBe('');
    expect(dollarsInputToCents('100.50')).toBe(10_050);
    expect(dollarsInputToCents('0.1')).toBe(10);
    expect(dollarsInputToCents('abc')).toBeNull();
  });
});
