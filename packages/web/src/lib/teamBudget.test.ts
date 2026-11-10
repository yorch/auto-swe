import { describe, expect, it } from 'vitest';
import {
  centsToDollarsInput,
  dollarsInputToCents,
  MAX_TEAM_BUDGET_DOLLARS,
  thresholdInputToPercent,
} from './teamBudget';

describe('centsToDollarsInput', () => {
  it('shows whole dollars plainly and fractions with two places', () => {
    expect(centsToDollarsInput(50000)).toBe('500');
    expect(centsToDollarsInput(50050)).toBe('500.50');
    expect(centsToDollarsInput(5)).toBe('0.05');
    expect(centsToDollarsInput(0)).toBe('0');
  });
  it('is blank for no cap', () => {
    expect(centsToDollarsInput(null)).toBe('');
    expect(centsToDollarsInput(undefined)).toBe('');
  });
});

describe('dollarsInputToCents', () => {
  it('converts to whole cents without float drift', () => {
    expect(dollarsInputToCents('500')).toEqual({ ok: true, value: 50000 });
    expect(dollarsInputToCents('$1,234.56')).toEqual({ ok: true, value: 123456 });
    expect(dollarsInputToCents('19.99')).toEqual({ ok: true, value: 1999 });
    expect(dollarsInputToCents('0.29')).toEqual({ ok: true, value: 29 });
  });
  it('treats blank as clearing the cap and zero as a real cap', () => {
    expect(dollarsInputToCents('  ')).toEqual({ ok: true, value: null });
    expect(dollarsInputToCents('0')).toEqual({ ok: true, value: 0 });
  });
  it('rejects negatives, junk and sub-cent precision', () => {
    for (const bad of ['-5', 'abc', '1.234', '1e3', '5 0']) {
      expect(dollarsInputToCents(bad).ok).toBe(false);
    }
    expect(dollarsInputToCents('-5')).toMatchObject({ error: /negative/ });
  });
  it('rejects a cap above the maximum but accepts the maximum', () => {
    expect(dollarsInputToCents(String(MAX_TEAM_BUDGET_DOLLARS))).toEqual({
      ok: true,
      value: MAX_TEAM_BUDGET_DOLLARS * 100,
    });
    expect(dollarsInputToCents(String(MAX_TEAM_BUDGET_DOLLARS + 1)).ok).toBe(false);
  });
});

describe('thresholdInputToPercent', () => {
  it('accepts 1 to 100 and blank', () => {
    expect(thresholdInputToPercent('80')).toEqual({ ok: true, value: 80 });
    expect(thresholdInputToPercent('80%')).toEqual({ ok: true, value: 80 });
    expect(thresholdInputToPercent('')).toEqual({ ok: true, value: null });
  });
  it('rejects 0, 101, decimals and junk', () => {
    for (const bad of ['0', '101', '7.5', 'x', '-1']) {
      expect(thresholdInputToPercent(bad).ok).toBe(false);
    }
  });
});
