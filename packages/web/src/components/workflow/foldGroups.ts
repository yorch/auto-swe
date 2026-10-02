/**
 * View-only collapsing of a workflow's `group`s into single cards.
 *
 * Same contract as `foldBookkeeping`: this returns a *display* spec and nothing
 * else. It is never saved, never run, and never offered in the editor, where a
 * hidden node is a node the author cannot change. Callers pass the ids that must
 * stay visible whatever the viewer asked for (a node that failed, is running or
 * pending, carries a diff marker, or is selected), and a group holding any of
 * them is left open.
 *
 * A collapsed group becomes one synthetic card standing where the group's first
 * member stood. Every edge that led into the group now leads to the card; every
 * edge that led out becomes one exit port on the card, per distinct target, so
 * a group with two ways out draws two edges rather than hiding one.
 *
 * Only a group that can be collapsed *honestly* is offered: two or more members,
 * and one connected piece. A group split by a node outside it would fold into a
 * card with edges that appear to skip that node.
 */
import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges, setNodeEdge, splitGroups } from '@auto-swe/shared/workflow';
import type { LayoutEdge } from '@/lib/workflowLayout';
import { nodeDisplayName, nodeGroupOf } from './nodeDisplay';

/** The `step` name of a synthetic card. Never a registered step; never run. */
export const GROUP_STEP = '__group__';

/** Id of the synthetic card for a group label. Not a valid saved node id on purpose. */
export const foldedGroupId = (group: string): string => `group:${group}`;

export interface FoldedGroupExit {
  /** Source-handle id on the card, and the edge's port. */
  port: string;
  /** Node the edge leads to (a real node, or another folded group's card). */
  to: string;
  /** What to call the destination on the card. */
  label: string;
}

export interface FoldedGroup {
  /** The synthetic node id. */
  id: string;
  group: string;
  /** The real nodes the card stands for, in map order. */
  memberIds: string[];
  exits: FoldedGroupExit[];
}

export interface GroupFold {
  spec: WorkflowSpec;
  /** Edges leaving the synthetic cards, to be drawn alongside the spec's own. */
  extraEdges: LayoutEdge[];
  /** The cards in `spec`, by synthetic id. */
  folded: Record<string, FoldedGroup>;
  /** Group labels that may be collapsed (and are not forced open), in first-seen order. */
  collapsible: string[];
}

export function isFoldedGroupNode(node: SpecNode | undefined): boolean {
  return node?.type === 'step' && node.step === GROUP_STEP;
}

/**
 * The groups of `spec` that could be collapsed: two or more members, one
 * connected piece. First-seen order, which is map order.
 */
export function collapsibleGroups(spec: WorkflowSpec): string[] {
  const members = new Map<string, number>();
  for (const node of Object.values(spec.nodes)) {
    const group = nodeGroupOf(node);
    if (group) {
      members.set(group, (members.get(group) ?? 0) + 1);
    }
  }
  const split = splitGroups(spec);
  return [...members].filter(([g, n]) => n >= 2 && !split.has(g)).map(([g]) => g);
}

export function foldGroups(
  spec: WorkflowSpec,
  collapsed: ReadonlySet<string>,
  keep: ReadonlySet<string> = new Set()
): GroupFold {
  const candidates = collapsibleGroups(spec);
  const memberIdsOf = (group: string): string[] =>
    Object.entries(spec.nodes)
      .filter(([, node]) => nodeGroupOf(node) === group)
      .map(([id]) => id);

  // A group the viewer asked to collapse but that holds something they are
  // looking for stays open.
  const open = new Set(
    candidates.filter((g) => collapsed.has(g) && memberIdsOf(g).some((id) => keep.has(id)))
  );
  const collapsing = candidates.filter((g) => collapsed.has(g) && !open.has(g));
  const collapsible = candidates.filter((g) => !open.has(g));
  if (collapsing.length === 0) {
    return { collapsible, extraEdges: [], folded: {}, spec };
  }

  const groupOfNode = new Map<string, string>();
  for (const group of collapsing) {
    for (const id of memberIdsOf(group)) {
      groupOfNode.set(id, group);
    }
  }
  const resolve = (id: string): string => {
    const group = groupOfNode.get(id);
    return group ? foldedGroupId(group) : id;
  };
  const labelOf = (id: string): string => {
    const group = groupOfNode.get(id);
    return group ?? nodeDisplayName(spec.nodes[id], id);
  };

  const folded: Record<string, FoldedGroup> = {};
  for (const group of collapsing) {
    const id = foldedGroupId(group);
    const memberIds = memberIdsOf(group);
    const exits = new Map<string, FoldedGroupExit>();
    for (const memberId of memberIds) {
      for (const [, target] of nodeEdges(spec.nodes[memberId] as SpecNode)) {
        const to = resolve(target);
        if (to !== id && !exits.has(to)) {
          exits.set(to, { label: labelOf(target), port: `exit:${to}`, to });
        }
      }
    }
    folded[id] = { exits: [...exits.values()], group, id, memberIds };
  }

  const nodes: Record<string, SpecNode> = {};
  const placed = new Set<string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    const group = groupOfNode.get(id);
    if (group) {
      const cardId = foldedGroupId(group);
      if (!placed.has(cardId)) {
        placed.add(cardId);
        const card = folded[cardId] as FoldedGroup;
        nodes[cardId] = {
          config: { count: card.memberIds.length },
          group,
          step: GROUP_STEP,
          title: group,
          type: 'step',
        };
      }
      continue;
    }
    let patched = node;
    for (const [field, target] of nodeEdges(node)) {
      const to = resolve(target);
      if (to !== target) {
        patched = setNodeEdge(patched, field, to);
      }
    }
    nodes[id] = patched;
  }

  const extraEdges: LayoutEdge[] = Object.values(folded).flatMap((card) =>
    card.exits.map((exit) => ({
      from: card.id,
      kind: 'next' as const,
      port: exit.port,
      to: exit.to,
    }))
  );

  return {
    collapsible,
    extraEdges,
    folded,
    spec: { ...spec, entry: resolve(spec.entry), nodes: nodes as WorkflowSpec['nodes'] },
  };
}
