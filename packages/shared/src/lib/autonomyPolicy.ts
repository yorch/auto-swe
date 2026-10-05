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

/**
 * The risk classes workflow steps declare (`policyGatedWrite`, `publishOutcome`) and the
 * fallback rules cover. A policy may carry any class name, and a class it omits requires
 * approval; this is the set the policy editor offers, with the wording shown to people.
 */
export const KNOWN_RISK_CLASSES = [
  {
    description: 'Reads data inside your own systems.',
    key: 'internal_read',
    label: 'Internal read',
  },
  {
    description: 'Changes data inside your own systems, such as a draft or an internal ticket.',
    key: 'internal_write',
    label: 'Internal write',
  },
  {
    description: 'Messages one person or channel outside the team, such as a customer reply.',
    key: 'external_communication',
    label: 'External communication',
  },
  {
    description: 'Messages many people at once, such as an announcement.',
    key: 'mass_communication',
    label: 'Mass communication',
  },
  {
    description: 'Creates or changes something in an outside system, such as an issue tracker.',
    key: 'external_write',
    label: 'External write',
  },
] as const;

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
