import { prisma } from '@auto-swe/shared/db';
import { STEP_REQUIRED_AGENTS } from './stepRequiredAgents.js';
import type { ModelBackedAgentKey } from './types.js';

/**
 * The agent keys *this deployment* actually needs at boot.
 *
 * `requiredAgentKeys()` returns the union over the whole step catalog, which is
 * the SWE library. That made every deployment configure `implementer`,
 * `reviewer`, `planner`, `securityReview`, `validateContext`, `commitToMemory`
 * and `channelAssistant` — with credentials — before the poller would start,
 * including a deployment that runs no software-engineering workflow at all.
 *
 * The set is derived from the specs that can actually execute instead: the
 * active (and experiment) versions of every ACTIVE template, plus
 * `channelAssistant` when the deployment has Slack channels. A step nobody has
 * installed cannot run, so demanding its model is demanding configuration for
 * work that will never happen.
 *
 * What this deliberately does **not** change: agents reached through a
 * template's `agentRef` stay non-fatal here (checked at template save, resolved
 * per node at run time), and a template activated *after* boot is not
 * retroactively gated — that node fails at run time with `ConfigMissingError`,
 * the same as any other late config change.
 */

/** Spec shape this module needs; the full type lives in `@auto-swe/shared/workflow`. */
interface MinimalSpec {
  nodes?: Record<string, { type?: string; step?: string } | null>;
}

/** Step names reachable from the installed, runnable template versions. */
export async function installedStepNames(): Promise<Set<string>> {
  const templates = await prisma.workflowTemplate.findMany({
    select: { activeVersion: true, experimentVersion: true, id: true },
    where: { status: 'ACTIVE' },
  });

  // Both arms of an A/B split can run, so both count as installed.
  const wanted = templates.flatMap((t) =>
    [t.activeVersion, t.experimentVersion]
      .filter((v): v is number => v !== null)
      .map((version) => ({ templateId: t.id, version }))
  );
  if (wanted.length === 0) {
    return new Set();
  }

  const versions = await prisma.workflowTemplateVersion.findMany({
    select: { spec: true },
    where: { OR: wanted },
  });

  const steps = new Set<string>();
  for (const { spec } of versions) {
    const nodes = (spec as MinimalSpec | null)?.nodes;
    if (!nodes) {
      continue;
    }
    for (const node of Object.values(nodes)) {
      if (node?.type === 'step' && typeof node.step === 'string') {
        steps.add(node.step);
      }
    }
  }
  return steps;
}

export interface DeploymentAgentRequirement {
  keys: ModelBackedAgentKey[];
  /** True when nothing runnable is installed — boot proceeds with no agent gate. */
  empty: boolean;
}

export async function requiredAgentKeysForDeployment(): Promise<DeploymentAgentRequirement> {
  const steps = await installedStepNames();
  const keys = new Set<ModelBackedAgentKey>();
  for (const step of steps) {
    for (const key of STEP_REQUIRED_AGENTS[step] ?? []) {
      keys.add(key);
    }
  }

  // Channel turns do not go through a step node — `ChannelAssistantWorkflow`
  // calls `runAgent` directly, and the seeded channel template is a one-node
  // trace container. So walking specs cannot see this requirement; the presence
  // of a channel is what implies it.
  if ((await prisma.slackChannel.count()) > 0) {
    keys.add('channelAssistant');
  }

  return { empty: steps.size === 0 && keys.size === 0, keys: [...keys] };
}
