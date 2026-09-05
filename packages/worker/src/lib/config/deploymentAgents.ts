import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { STEP_REQUIRED_AGENTS } from './stepRequiredAgents.js';

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

/** Step names reachable from the installed, runnable template versions. */
export async function installedStepNames(): Promise<Set<string>> {
  const templates = await runUnscoped(
    'the boot gate covers the whole deployment: any tenant installed template can run on this worker',
    ['WorkflowTemplate'],
    () =>
      prisma.workflowTemplate.findMany({
        select: { activeVersion: true, experimentVersion: true, id: true },
        where: { status: 'ACTIVE' },
      })
  );

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
    // The real spec type, not a local shape: this is the sole input to the boot
    // gate, so if the `step` discriminant is ever renamed this must stop
    // compiling. A structural stand-in would keep compiling, quietly return no
    // steps, and boot the worker with no LLM-config check at all.
    const nodes = (spec as WorkflowSpec | null)?.nodes;
    if (!nodes) {
      continue;
    }
    for (const node of Object.values(nodes)) {
      if (node?.type === 'step') {
        steps.add(node.step);
      } else if (node?.type === 'eval') {
        // The interpreter dispatches an `eval` node through the `runEvalNode`
        // step, whose judge scorer binds `evalJudge` — the gate must see it.
        steps.add('runEvalNode');
      }
    }
  }
  return steps;
}

/**
 * The step names the boot gate actually walked, captured at boot.
 *
 * `flagUnregisteredAgentUsage` needs this to know whether a spending activity
 * was ever in the gate's scope. Most LLM-spending activities are not steps at
 * all — channel turns, the memory passes, the workflow authoring activities —
 * and `assertConfigReady` covers those by other rules, so judging them against
 * a *step* map would report drift on every healthy deployment.
 *
 * `null` until the gate runs (unit tests, direct activity calls), which the
 * consumer reads as "cannot judge" rather than "not a step".
 */
let gatedSteps: Set<string> | null = null;

/** The step names the boot gate walked, or `null` if it has not run. */
export function gatedStepNames(): Set<string> | null {
  return gatedSteps;
}

/** Empty when nothing runnable is installed — boot then has no agent gate. */
export async function requiredAgentKeysForDeployment(): Promise<string[]> {
  // Independent reads on the worker's pre-poller boot path.
  const [steps, channelCount] = await Promise.all([
    installedStepNames(),
    runUnscoped(
      'a channel in any tenant means this worker can serve channel turns',
      ['SlackChannel'],
      () => prisma.slackChannel.count()
    ),
  ]);
  gatedSteps = steps;
  const keys = new Set<string>();
  for (const step of steps) {
    // Absent (resolves no model) and null (agent comes from the spec) are both
    // "nothing to gate on here"; a dynamic step's agent is checked at template
    // save instead.
    const declared = STEP_REQUIRED_AGENTS[step];
    if (!declared) {
      continue;
    }
    for (const key of declared) {
      keys.add(key);
    }
  }

  // Channel turns do not go through a step node — `ChannelAssistantWorkflow`
  // calls `runAgent` directly, and the seeded channel template is a one-node
  // trace container. So walking specs cannot see this requirement; the presence
  // of a channel is what implies it.
  if (channelCount > 0) {
    keys.add('channelAssistant');
  }

  return [...keys];
}
