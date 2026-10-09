import {
  deploymentAgentRequirements,
  installedStepNames,
} from '@auto-swe/shared/lib/deploymentAgents';

/**
 * The agent keys *this deployment* needs at boot, as the shared
 * `deploymentAgentRequirements` computes them — the same set the gateway's
 * readiness check reports against. This module adds only what is the worker's
 * own: remembering which steps the gate walked.
 */
export { installedStepNames };

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
  const { keys, steps } = await deploymentAgentRequirements();
  gatedSteps = steps;
  return keys;
}
