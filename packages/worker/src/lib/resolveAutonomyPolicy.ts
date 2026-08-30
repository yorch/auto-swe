import { prisma } from '@auto-swe/shared/db';

export type AutonomyAction = 'auto' | 'require_approval';

export interface RiskRule {
  action: AutonomyAction;
  approverCount?: number;
}

export interface AutonomyRules {
  [riskClass: string]: RiskRule;
}

const FALLBACK_RULES: AutonomyRules = {
  external_communication: { action: 'require_approval' },
  internal_read: { action: 'auto' },
  internal_write: { action: 'auto' },
  mass_communication: { action: 'require_approval', approverCount: 2 },
};

function coerceRules(raw: unknown): AutonomyRules {
  if (typeof raw !== 'object' || raw == null) {
    return FALLBACK_RULES;
  }
  return raw as AutonomyRules;
}

export async function resolveAutonomyPolicy(
  templateId: string,
  teamId: string | null
): Promise<{ name: string; rules: AutonomyRules }> {
  const templatePolicy = await prisma.autonomyPolicy.findFirst({
    where: { templateId },
  });
  if (templatePolicy) {
    return { name: templatePolicy.name, rules: coerceRules(templatePolicy.rules) };
  }

  if (teamId) {
    const teamPolicy = await prisma.autonomyPolicy.findFirst({
      where: { isDefault: true, teamId, templateId: null },
    });
    if (teamPolicy) {
      return { name: teamPolicy.name, rules: coerceRules(teamPolicy.rules) };
    }
  }

  const globalPolicy = await prisma.autonomyPolicy.findFirst({
    where: { isDefault: true, teamId: null, templateId: null },
  });
  if (globalPolicy) {
    return { name: globalPolicy.name, rules: coerceRules(globalPolicy.rules) };
  }

  return { name: 'platform fallback', rules: FALLBACK_RULES };
}
