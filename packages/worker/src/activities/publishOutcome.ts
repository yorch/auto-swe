import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';

export interface PublishOutcomeInput {
  /** Temporal workflow ID used to locate the run and its template/team context. */
  workflowId: string;
  /** Risk class of the action being attempted, e.g. external_communication. */
  action: string;
  description?: string;
}

export interface PublishOutcomeResult {
  decision: 'auto' | 'require_approval';
  policyName: string;
  reason: string;
  /** Number of distinct human approvers required when decision is 'require_approval'. */
  approverCount: number;
}

export type AutonomyAction = 'auto' | 'require_approval';

interface RiskRule {
  action: AutonomyAction;
  approverCount?: number;
}

interface AutonomyRules {
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

export async function publishOutcome(input: PublishOutcomeInput): Promise<PublishOutcomeResult> {
  const run = await prisma.workflowRun.findUnique({
    include: { template: { include: { team: true } } },
    where: { workflowId: input.workflowId },
  });
  if (!run) {
    throw ApplicationFailure.nonRetryable(
      `WorkflowRun not found for workflowId ${input.workflowId}`
    );
  }

  const policy = await resolveAutonomyPolicy(run.templateId, run.template?.teamId ?? null);
  const rules = coerceRules(policy?.rules);
  const rule = rules[input.action] ?? { action: 'require_approval' };
  const decision = rule.action === 'auto' ? 'auto' : 'require_approval';
  const approverCount = normalizeApproverCount(rule.approverCount);
  const reason =
    decision === 'auto'
      ? `Policy '${policy?.name ?? 'platform fallback'}' allows auto for '${input.action}'`
      : `Policy '${policy?.name ?? 'platform fallback'}' requires human approval for '${input.action}'`;

  await prisma.autonomyDecision.create({
    data: {
      event: 'publish',
      payload: { decision, reason },
      policyName: policy?.name ?? 'platform fallback',
      requiredApprovers: approverCount,
      riskClass: input.action,
      runId: run.id,
    },
  });

  return {
    approverCount,
    decision,
    policyName: policy?.name ?? 'platform fallback',
    reason,
  };
}

function normalizeApproverCount(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
}

async function resolveAutonomyPolicy(
  templateId: string,
  teamId: string | null
): Promise<{ name: string; rules: AutonomyRules } | null> {
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

  return null;
}
