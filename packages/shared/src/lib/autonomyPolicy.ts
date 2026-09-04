import { z } from 'zod';

export const AUTONOMY_ACTIONS = ['auto', 'require_approval'] as const;

export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

export const RiskRuleSchema = z.object({
  action: z.enum(AUTONOMY_ACTIONS),
  approverCount: z.number().int().min(1).optional(),
});

export type RiskRule = z.infer<typeof RiskRuleSchema>;

export const AutonomyRulesSchema = z.record(z.string().min(1), RiskRuleSchema);

export type AutonomyRules = z.infer<typeof AutonomyRulesSchema>;

export const FALLBACK_RULES: AutonomyRules = {
  external_communication: { action: 'require_approval' },
  internal_read: { action: 'auto' },
  internal_write: { action: 'auto' },
  mass_communication: { action: 'require_approval', approverCount: 2 },
};

export interface SafeAutonomyRulesOptions {
  requestedRiskClass?: string;
}

export function getSafeAutonomyRules(
  raw: unknown,
  options?: SafeAutonomyRulesOptions
): AutonomyRules {
  if (raw === null || raw === undefined) {
    return { ...FALLBACK_RULES };
  }

  const parsed = AutonomyRulesSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const rules = { ...FALLBACK_RULES };
  if (options?.requestedRiskClass) {
    rules[options.requestedRiskClass] = { action: 'require_approval' };
  }
  return rules;
}
