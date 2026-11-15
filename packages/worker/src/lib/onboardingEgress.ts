import { prisma } from '@auto-swe/shared/db';
import { firstDifferenceFromSeed, SWE_AGENTS } from '@auto-swe/shared/lib/syncBuiltins';
import { activityInfo } from '@temporalio/activity';
import { logWarn } from './activityLog.js';

/** How the node's loop was resolved (`resolveAgentRuntime`): the runtime and where it came from. */
interface ResolvedLoop {
  runtime: string;
  source: string;
}

/**
 * Agent keys alone are not authority: team and organization admins can override their
 * definitions, and any version can be edited. The exception holds only when
 * - the node's loop is the default one (`loop.source === 'default'`, runtime `mastra`, which is
 *   what a seeded agent with no runtime of its own resolves to there). A run-start pin made while
 *   an override named another runtime survives that override's deactivation, so a pinned runtime
 *   refuses even when the row now resolved has none; and
 * - the resolved `Agent` row (`agentId`, from `resolveAgent`) has the seed's CONTENT, as
 *   `firstDifferenceFromSeed` judges it: GLOBAL with no owner, the seeded prompt, tools and
 *   skills, and no MCP binding, runtime, harness profile or model inheritance. A pinned older
 *   version or a `key@version` ref resolves to another row and is judged the same way; an absent
 *   row fails.
 * A refusal for a run that is otherwise an onboarding draft is logged.
 *
 * Not covered: the credential the agent's model is called with is resolved by scope (a team or
 * organization provider credential, with its own `apiBase`, wins over the global one), so a team
 * admin can steer which model drives the widened workspace without touching the agent; the check
 * narrows who gets the wider list and is not a strong boundary against a team admin. And the row
 * is read here, live by id, while the run's agent comes from a ~30 s cache: a bundle install
 * (ADMIN only) that rewrites the GLOBAL head in place is not noticed by an id comparison.
 */
export async function isOnboardingDraftAgent(
  agentKey: string,
  agentId: string,
  loop: ResolvedLoop
): Promise<boolean> {
  if (agentKey !== 'repo-onboarder') {
    return false;
  }
  let execution: ReturnType<typeof activityInfo>['workflowExecution'];
  try {
    execution = activityInfo().workflowExecution;
  } catch {
    return false;
  }
  if (!execution?.workflowId || !execution.runId) {
    return false;
  }
  const run = await prisma.workflowRun.findUnique({
    select: {
      template: { select: { name: true, origin: true, teamId: true } },
      templateId: true,
      templateVersion: true,
      temporalRunId: true,
    },
    where: { workflowId: execution.workflowId },
  });
  if (
    !run ||
    run.temporalRunId !== execution.runId ||
    run.template.name !== 'repo-onboarding' ||
    run.template.teamId !== null ||
    run.template.origin !== 'swe-starter'
  ) {
    return false;
  }
  const version = await prisma.workflowTemplateVersion.findUnique({
    select: { createdBy: true, generatedBy: true },
    where: { templateId_version: { templateId: run.templateId, version: run.templateVersion } },
  });
  if (version === null || version.createdBy !== null || version.generatedBy !== null) {
    return false;
  }
  // Trade-off: if the run-start runtime snapshot skipped this key (it swallows per-key errors),
  // the first attempt writes a concrete 'mastra' pin, so later attempts, revisits and resumes read
  // source 'run' and are refused here (logged as runtimePin). That only narrows, never widens.
  if (loop.source !== 'default' || loop.runtime !== 'mastra') {
    refuse(agentId, 'runtimePin');
    return false;
  }
  const seed = SWE_AGENTS.find((def) => def.key === agentKey);
  const agent = await prisma.agent.findUnique({
    select: {
      channelId: true,
      harnessProfile: true,
      inheritsModelFrom: true,
      key: true,
      mcpConnectionId: true,
      orgId: true,
      runtime: true,
      scope: true,
      skillRefs: { select: { skill: { select: { name: true } }, sortOrder: true } },
      systemPrompt: true,
      teamId: true,
      toolKeys: true,
      workflowTemplateId: true,
    },
    where: { id: agentId },
  });
  const failed = seed ? firstDifferenceFromSeed(agent, seed) : 'no seed definition';
  if (failed) {
    refuse(agentId, failed);
    return false;
  }
  return true;
}

function refuse(agentId: string, condition: string): void {
  logWarn(
    condition === 'runtimePin'
      ? "onboarding draft egress refused: the node's runtime is not the default one"
      : 'onboarding draft egress refused: the resolved agent is not the seeded definition',
    { agentId, condition }
  );
}
