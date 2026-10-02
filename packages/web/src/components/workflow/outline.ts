/**
 * The outline of a workflow: its steps as a flat list in flow order, gathered
 * into sections by `group`.
 *
 * Pure and view-only, like `foldBookkeeping`. Nothing here is saved or run.
 *
 * Flow order is a walk from the entry node that follows each node's edges in
 * the order `nodeEdges` lists them, so a `cond`'s true branch is read before its
 * false branch and a loop's back-edge adds nothing new. Nodes the walk never
 * reaches (a half-edited spec) follow in map order rather than vanishing.
 *
 * Sections: the first time the walk meets a grouped node, that group's whole
 * membership is placed at that point, in flow order; an ungrouped node is its own
 * section with no heading. So the list still reads top to bottom as the flow, and
 * a group is never split across the list.
 */
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges } from '@auto-swe/shared/workflow';
import { nodeGroupOf } from './nodeDisplay';

export interface OutlineSection {
  /** The group label, or null for a lone ungrouped node. */
  group: string | null;
  /** Node ids, in flow order. */
  nodeIds: string[];
}

/** Node ids in flow order: depth-first from the entry, then anything unreached. */
export function flowOrder(spec: WorkflowSpec): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (start: string): void => {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      const node = spec.nodes[id];
      if (seen.has(id) || !node) {
        continue;
      }
      seen.add(id);
      order.push(id);
      // Pushed in reverse so the first edge is popped (read) first.
      const targets = nodeEdges(node).map(([, to]) => to);
      for (let i = targets.length - 1; i >= 0; i--) {
        stack.push(targets[i] as string);
      }
    }
  };
  visit(spec.entry);
  for (const id of Object.keys(spec.nodes)) {
    visit(id);
  }
  return order;
}

export function buildOutline(spec: WorkflowSpec): OutlineSection[] {
  const order = flowOrder(spec);
  const members = new Map<string, string[]>();
  for (const id of order) {
    const group = nodeGroupOf(spec.nodes[id]);
    if (group) {
      members.set(group, [...(members.get(group) ?? []), id]);
    }
  }
  const sections: OutlineSection[] = [];
  const placed = new Set<string>();
  for (const id of order) {
    const group = nodeGroupOf(spec.nodes[id]);
    if (!group) {
      sections.push({ group: null, nodeIds: [id] });
    } else if (!placed.has(group)) {
      placed.add(group);
      sections.push({ group, nodeIds: members.get(group) as string[] });
    }
  }
  return sections;
}

/** Every node id the outline lists, top to bottom — the order arrow keys walk. */
export function outlineIds(sections: readonly OutlineSection[]): string[] {
  return sections.flatMap((s) => s.nodeIds);
}

export type OutlineKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Where keyboard focus goes from `current` for an arrow/Home/End key, among the
 * ids the outline is currently showing (a folded group's members are not in
 * `visibleIds`). Null when there is nowhere to go. With nothing current, a
 * movement key lands on the first row (or, for ArrowUp, the last).
 */
export function nextOutlineId(
  visibleIds: readonly string[],
  current: string | null,
  key: OutlineKey
): string | null {
  if (visibleIds.length === 0) {
    return null;
  }
  if (key === 'Home') {
    return visibleIds[0] ?? null;
  }
  if (key === 'End') {
    return visibleIds[visibleIds.length - 1] ?? null;
  }
  const at = current === null ? -1 : visibleIds.indexOf(current);
  if (at === -1) {
    return key === 'ArrowDown'
      ? (visibleIds[0] ?? null)
      : (visibleIds[visibleIds.length - 1] ?? null);
  }
  return visibleIds[key === 'ArrowDown' ? at + 1 : at - 1] ?? null;
}
