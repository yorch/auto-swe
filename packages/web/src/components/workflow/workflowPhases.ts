/**
 * Phase overview of a workflow: its `group` labels in flow order.
 * Presentation only. A node without a group belongs to no phase.
 */
import { nodeEdges, type Node as SpecNode, type WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeGroupOf } from './nodeDisplay';

/** Node ids in flow order: breadth-first from `entry`, then unreachable nodes in map order. */
function flowOrder(spec: WorkflowSpec): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string) => {
    if (!seen.has(id) && spec.nodes[id]) {
      seen.add(id);
      queue.push(id);
    }
  };
  visit(spec.entry);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    order.push(id);
    for (const [, target] of nodeEdges(spec.nodes[id] as SpecNode)) {
      visit(target);
    }
  }
  for (const id of Object.keys(spec.nodes)) {
    if (!seen.has(id)) {
      order.push(id);
    }
  }
  return order;
}

/** Distinct group labels, ordered by the first node of each reached in flow order. */
export function phasesOf(spec: WorkflowSpec): string[] {
  const phases: string[] = [];
  for (const id of flowOrder(spec)) {
    const group = nodeGroupOf(spec.nodes[id]);
    if (group && !phases.includes(group)) {
      phases.push(group);
    }
  }
  return phases;
}
