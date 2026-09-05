import { describe, expect, it } from 'vitest';
import {
  AutonomyRulesSchema,
  FALLBACK_RULES,
  getSafeAutonomyRules,
  RiskRuleSchema,
} from './autonomyPolicy.js';

describe('AutonomyRulesSchema', () => {
  it('accepts a valid set of rules', () => {
    const rules = {
      external_communication: { action: 'require_approval' as const },
      internal_read: { action: 'auto' as const, approverCount: 1 },
      mass_communication: { action: 'require_approval' as const, approverCount: 2 },
    };
    expect(AutonomyRulesSchema.safeParse(rules).success).toBe(true);
  });

  it('rejects a malformed action', () => {
    const result = AutonomyRulesSchema.safeParse({
      external_communication: { action: 'maybe_later' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid approverCount', () => {
    const result = AutonomyRulesSchema.safeParse({
      external_communication: { action: 'require_approval', approverCount: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer approverCount', () => {
    const result = AutonomyRulesSchema.safeParse({
      external_communication: { action: 'require_approval', approverCount: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty risk class key', () => {
    const result = AutonomyRulesSchema.safeParse({
      '': { action: 'auto' },
    });
    expect(result.success).toBe(false);
  });
});

describe('RiskRuleSchema', () => {
  it('accepts auto without approverCount', () => {
    expect(RiskRuleSchema.safeParse({ action: 'auto' }).success).toBe(true);
  });

  it('requires action', () => {
    expect(RiskRuleSchema.safeParse({ approverCount: 2 }).success).toBe(false);
  });
});

describe('getSafeAutonomyRules', () => {
  it('returns the parsed rules for valid input', () => {
    const rules = { internal_read: { action: 'auto' as const } };
    expect(getSafeAutonomyRules(rules)).toEqual(rules);
  });

  it('returns the hard-coded fallback when input is null', () => {
    expect(getSafeAutonomyRules(null)).toEqual(FALLBACK_RULES);
  });

  it('fails closed for the requested risk class when stored JSON is malformed', () => {
    const result = getSafeAutonomyRules('not-valid-json', { requestedRiskClass: 'internal_read' });
    expect(result.internal_read).toEqual({ action: 'require_approval' });
  });

  it('keeps fallback rules for other risk classes on malformed input', () => {
    const result = getSafeAutonomyRules('not-valid-json', { requestedRiskClass: 'internal_read' });
    expect(result.internal_write).toEqual({ action: 'auto' });
    expect(result.external_communication).toEqual({ action: 'require_approval' });
  });
});
