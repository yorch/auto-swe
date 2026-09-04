import { prisma } from '@auto-swe/shared/db';
import { type AutonomyRules, getSafeAutonomyRules } from '@auto-swe/shared/lib/autonomyPolicy';

export type { AutonomyRules };

interface AutonomyPolicyScope {
  isDefault: boolean;
  teamId: string | null;
  templateId: string | null;
}

function isTemplateScope(policy: AutonomyPolicyScope, templateId: string): boolean {
  return policy.templateId === templateId && !policy.isDefault && policy.teamId === null;
}

function isTeamScope(policy: AutonomyPolicyScope, teamId: string): boolean {
  return policy.teamId === teamId && policy.isDefault === true && policy.templateId === null;
}

function isGlobalScope(policy: AutonomyPolicyScope): boolean {
  return policy.isDefault === true && policy.teamId === null && policy.templateId === null;
}

/**
 * Resolve the autonomy policy for a run, cascading from most specific to least:
 *   template override → team default → global default → hard-coded fallback.
 *
 * Each level validates that the returned row matches the expected scope, and any
 * malformed stored rules fail closed to `require_approval` for the requested
 * risk class (or the safe hard-coded fallback).
 */
export async function resolveAutonomyPolicy(
  templateId: string,
  teamId: string | null,
  requestedRiskClass: string
): Promise<{ name: string; rules: AutonomyRules }> {
  const templatePolicy = await prisma.autonomyPolicy.findFirst({
    where: { templateId },
  });
  if (templatePolicy && isTemplateScope(templatePolicy, templateId)) {
    return {
      name: templatePolicy.name,
      rules: getSafeAutonomyRules(templatePolicy.rules, { requestedRiskClass }),
    };
  }

  if (teamId) {
    const teamPolicy = await prisma.autonomyPolicy.findFirst({
      where: { isDefault: true, teamId, templateId: null },
    });
    if (teamPolicy && isTeamScope(teamPolicy, teamId)) {
      return {
        name: teamPolicy.name,
        rules: getSafeAutonomyRules(teamPolicy.rules, { requestedRiskClass }),
      };
    }
  }

  const globalPolicy = await prisma.autonomyPolicy.findFirst({
    where: { isDefault: true, teamId: null, templateId: null },
  });
  if (globalPolicy && isGlobalScope(globalPolicy)) {
    return {
      name: globalPolicy.name,
      rules: getSafeAutonomyRules(globalPolicy.rules, { requestedRiskClass }),
    };
  }

  return {
    name: 'platform fallback',
    rules: getSafeAutonomyRules(null, { requestedRiskClass }),
  };
}
