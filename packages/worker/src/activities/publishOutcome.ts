import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
import { resolveAutonomyPolicy } from '../lib/resolveAutonomyPolicy.js';

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

function normalizeApproverCount(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
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
  const rule = policy.rules[input.action] ?? { action: 'require_approval' };
  const decision = rule.action === 'auto' ? 'auto' : 'require_approval';
  const approverCount = normalizeApproverCount(rule.approverCount);
  const policyName = policy.name;
  const reason =
    decision === 'auto'
      ? `Policy '${policyName}' allows auto for '${input.action}'`
      : `Policy '${policyName}' requires human approval for '${input.action}'`;

  await prisma.autonomyDecision.create({
    data: {
      event: 'publish',
      payload: { decision, reason },
      policyName,
      requiredApprovers: approverCount,
      riskClass: input.action,
      runId: run.id,
    },
  });

  return {
    approverCount,
    decision,
    policyName,
    reason,
  };
}
