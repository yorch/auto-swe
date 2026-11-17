import { prisma } from '@auto-swe/shared/db';
import { firstDifferenceFromSeed, SWE_AGENTS } from '@auto-swe/shared/lib/syncBuiltins';
import { activityInfo } from '@temporalio/activity';
import { logWarn } from './activityLog.js';

/** How the node's loop was resolved (`resolveAgentRuntime`): the runtime and where it came from. */
interface ResolvedLoop {
  runtime: string;
  source: string;
}

/** Where the resolved model's credential came from (`ResolvedModelConfig`). */
interface ModelCredential {
  apiBase?: string;
  /** Absent means unknown, which is refused. */
  scope?: 'TEAM' | 'ORGANIZATION' | 'GLOBAL';
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
 *   row fails; and
 * - the credential the agent's model is called with is not one a team could point at a server of
 *   its own (`credentialScope`): its row is GLOBAL, or it is TEAM or ORGANIZATION with no custom
 *   `apiBase` (a team's own vendor key used against the provider's default endpoint cannot steer
 *   the model elsewhere). A custom `apiBase` on a non-GLOBAL credential, or an unknown scope,
 *   refuses. The credential is resolved by scope (a team credential wins over the global one) or
 *   pinned on the agent, so without this a team admin could make the model that drives the
 *   widened workspace their own server's.
 * A refusal for a run that is otherwise an onboarding draft is logged.
 *
 * Not covered: the model id and reasoning level may still vary (an ADMIN-edited GLOBAL row). A
 * TEAM or ORGANIZATION credential with no `apiBase` supplies only the key: its owner does not
 * choose the endpoint or the model, but does control the vendor account the call is billed to
 * and governed by (retention, limits, organisation policies). The row is read here,
 * live by id, while the run's agent comes from a ~30 s cache: a bundle install (ADMIN only) that
 * rewrites the GLOBAL head in place is not noticed by an id comparison.
 */
export async function isOnboardingDraftAgent(
  agentKey: string,
  agentId: string,
  loop: ResolvedLoop,
  credential: ModelCredential
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
  if (!credentialTrusted(credential)) {
    refuse(agentId, 'credentialScope');
    return false;
  }
  const seed = SWE_AGENTS.find((def) => def.key === agentKey);
  const agent = await prisma.agent.findUnique({
    select: {
      channelId: true,
      harnessProfiles: true,
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

/**
 * A GLOBAL credential is the operator's. A TEAM or ORGANIZATION one is trusted only against the
 * provider's default endpoint: with a custom `apiBase` its owner picks the server the model
 * call goes to. A scope that is missing or not recognised is not trusted.
 */
export function credentialTrusted(credential: ModelCredential): boolean {
  if (credential.scope === 'GLOBAL') {
    return true;
  }
  if (credential.scope === 'TEAM' || credential.scope === 'ORGANIZATION') {
    return !credential.apiBase;
  }
  return false;
}

function refuse(agentId: string, condition: string): void {
  logWarn(
    condition === 'runtimePin'
      ? "onboarding draft egress refused: the node's runtime is not the default one"
      : condition === 'credentialScope'
        ? "onboarding draft egress refused: the model's credential is not global and names its own endpoint, or its scope is unknown"
        : 'onboarding draft egress refused: the resolved agent is not the seeded definition',
    { agentId, condition }
  );
}
