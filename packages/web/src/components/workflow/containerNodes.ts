import { isContainerCodeNode, type WorkflowSpec } from '@auto-swe/shared/workflow';

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
