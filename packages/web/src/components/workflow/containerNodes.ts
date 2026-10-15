import {
  isAuthoredCommandNode,
  isContainerCodeNode,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';

/**
 * Nodes the gateway gates as "run team-authored code in a container" on save: `shell`,
 * `containerStep`, and a plain `step` naming a shell-category step. Counted with the shared
 * `isContainerCodeNode` the gateway's `collectShellNodes` uses, so the save-time
 * confirmation counts exactly the set the save gates.
 */
export function countContainerNodes(spec: WorkflowSpec | null | undefined): number {
  return Object.values(spec?.nodes ?? {}).filter(isContainerCodeNode).length;
}

/** Who may save a spec that contains such a node; every save route also needs platform LEAD. */
export const CONTAINER_AUTHORING_RULE =
  'Needs a platform admin, or a team admin who is also at least a platform lead; on a global template, a platform admin.';

/**
 * Nodes that carry a command the author wrote, run in the agent workspace: a gate step's
 * `command`, a `runQualityGates` gate's, an eval `gate` scorer's. Counted with the shared
 * `isAuthoredCommandNode`, the predicate behind the gateway's save-time gate, which asks the same
 * role as container code ({@link CONTAINER_AUTHORING_RULE}).
 */
export function countAuthoredCommandNodes(spec: WorkflowSpec | null | undefined): number {
  return Object.values(spec?.nodes ?? {}).filter(isAuthoredCommandNode).length;
}

/** What the inspector says on a node whose `command` the author wrote. */
export const AUTHORED_COMMAND_NOTE =
  "A command written here runs in the run's workspace, with network access, in place of the repository's gate command.";

/**
 * The save-time summary of a spec's authored code: how many container nodes and how many nodes
 * with authored commands it holds, as one sentence. Empty when it holds neither.
 */
export function describeAuthoredCode(spec: WorkflowSpec | null | undefined): string {
  const containers = countContainerNodes(spec);
  const commands = countAuthoredCommandNodes(spec);
  const parts = [
    containers > 0 ? `${containers} shell or container step${containers === 1 ? '' : 's'}` : '',
    commands > 0 ? `${commands} step${commands === 1 ? '' : 's'} with its own command` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `This version contains ${parts.join(' and ')}.` : '';
}
