/**
 * View-only folding of run bookkeeping out of a workflow graph.
 *
 * `set` nodes (status fields, retry counters) and `updateDomainState` steps each
 * have exactly one way out and do no branching. In the larger templates they are
 * about half the canvas and say nothing a reader needs, so a folded view routes
 * every edge that points at one straight through to where it leads.
 *
 * This produces a *display* spec only. It is never saved, never run, and never
 * shown in the editor, where hiding a node would hide something the author can
 * change. Callers pass the ids that must stay visible regardless (a node that
 * failed, is running, carries a diff marker, or is selected) so folding can never
 * hide the thing the viewer is looking for.
 */
import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges, setNodeEdge } from '@auto-swe/shared/workflow';

/** A node that only records state: one exit, no branching, no external effect. */
export function isBookkeeping(node: SpecNode | undefined): boolean {
  if (!node) {
    return false;
  }
  if (node.type === 'set') {
    return typeof node.next === 'string';
  }
  return node.type === 'step' && node.step === 'updateDomainState' && typeof node.next === 'string';
}

export interface FoldResult {
  spec: WorkflowSpec;
  /** Ids removed from the display spec. */
  hidden: string[];
}

export function foldBookkeeping(
  spec: WorkflowSpec,
  keep: ReadonlySet<string> = new Set()
): FoldResult {
  const foldable = (id: string): boolean =>
    id !== spec.entry && !keep.has(id) && isBookkeeping(spec.nodes[id]);

  // Follow a chain of foldable nodes to the first node that stays. A chain that
  // loops back on itself has no such node, so it is left as it was.
  const resolve = (start: string): string => {
    const seen = new Set<string>();
    let current = start;
    while (foldable(current)) {
      if (seen.has(current)) {
        return start;
      }
      seen.add(current);
      current = (spec.nodes[current] as { next: string }).next;
    }
    return current;
  };

  const hidden = new Set<string>();
  const nodes: Record<string, SpecNode> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (foldable(id) && resolve(id) !== id) {
      hidden.add(id);
      continue;
    }
    let patched = node;
    for (const [field, target] of nodeEdges(node)) {
      const resolved = resolve(target);
      if (resolved !== target) {
        patched = setNodeEdge(patched, field, resolved);
      }
    }
    nodes[id] = patched;
  }

  if (hidden.size === 0) {
    return { hidden: [], spec };
  }
  return { hidden: [...hidden], spec: { ...spec, nodes: nodes as WorkflowSpec['nodes'] } };
}
