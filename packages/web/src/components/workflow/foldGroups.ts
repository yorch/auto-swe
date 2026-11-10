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
 *
 * ## Macro uses
 *
 * A node may also carry `use`, the id of the macro invocation (the spec's `uses`
 * entry) that produced it. A use folds the same way, under the same rules, into
 * one card titled by the macro (`CI loop · ci`). It is a second dimension of the
 * same fold, asked for by putting {@link macroUseFoldKey}`(useId)` in `collapsed`, so a
 * caller that passes only group labels gets exactly the group fold it always had.
 * A use is usually coarser than a group (one `ciLoop` expansion spans the `CI wait`
 * and `CI loop` groups), so a collapsing use takes its members first, and the
 * groups are then judged — size and connectedness — on the nodes left over.
 */
import type { Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeEdges, setNodeEdge, splitGroups } from '@auto-swe/shared/workflow';
import type { LayoutEdge } from '@/lib/workflowLayout';
import { macroUseDisplayName } from './macroDisplay';
import { nodeDisplayName, nodeGroupOf, nodeUseOf } from './nodeDisplay';

/** The `step` name of a synthetic card. Never a registered step; never run. */
export const GROUP_STEP = '__group__';

/** Id of the synthetic card for a group label. Not a valid saved node id on purpose. */
export const foldedGroupId = (group: string): string => `group:${group}`;

/** Id of the synthetic card for a macro use. Not a valid saved node id on purpose. */
export const foldedUseId = (useId: string): string => `use:${useId}`;

/**
 * The `collapsed` key that folds a macro use. A NUL prefix keeps it apart from
 * every group label an author would type (labels are human text).
 */
const USE_KEY_PREFIX = '\u0000use:';
export const macroUseFoldKey = (useId: string): string => `${USE_KEY_PREFIX}${useId}`;

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
  /** A group label's card, or a macro use's. */
  kind: 'group' | 'use';
  /** The group label, or the use id for a use card. */
  group: string;
  /** The key in `collapsed` that folds this card (expanding removes it). */
  key: string;
  /** What the card is called: the group label, or `CI loop · ci`. */
  title: string;
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
  /**
   * Keys that may be collapsed (and are not forced open): use keys first, then group
   * labels, each in first-seen order.
   */
  collapsible: string[];
}

export function isFoldedGroupNode(node: SpecNode | undefined): boolean {
  return node?.type === 'step' && node.step === GROUP_STEP;
}

/** Labels by `labelOf`, over the nodes not in `skip`, that are 2+ members and one piece. */
function honestLabels(
  spec: WorkflowSpec,
  labelOf: (node: SpecNode) => string | undefined,
  skip: ReadonlySet<string> = new Set()
): string[] {
  const members = new Map<string, number>();
  const nodes: Record<string, SpecNode> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const label = skip.has(id) ? undefined : labelOf(node);
    if (label) {
      members.set(label, (members.get(label) ?? 0) + 1);
    }
    // `splitGroups` reads `group`, so ask it about whichever label this is.
    nodes[id] = { ...node, group: label } as SpecNode;
  }
  if (members.size === 0) {
    return [];
  }
  const split = splitGroups({ ...spec, nodes: nodes as WorkflowSpec['nodes'] });
  return [...members].filter(([l, n]) => n >= 2 && !split.has(l)).map(([l]) => l);
}

/**
 * The groups of `spec` that could be collapsed: two or more members, one
 * connected piece. First-seen order, which is map order.
 */
export function collapsibleGroups(spec: WorkflowSpec): string[] {
  return honestLabels(spec, nodeGroupOf);
}

/** The macro uses of `spec` that could be collapsed, by use id, under the same rules. */
export function collapsibleUses(spec: WorkflowSpec): string[] {
  return honestLabels(spec, nodeUseOf);
}

/**
 * The groups a large graph opens collapsed: every collapsible group when `enabled`, none
 * otherwise. A graph of 50 nodes reads as a handful of phases first, and the viewer expands
 * the one they care about. `foldGroups` still leaves open a group holding something the
 * viewer is looking for, so a failed or running step is never hidden by this default.
 */
export function defaultCollapsedGroups(spec: WorkflowSpec, enabled: boolean): Set<string> {
  return enabled ? new Set(collapsibleGroups(spec)) : new Set();
}

/** {@link defaultCollapsedGroups} plus every collapsible macro use: what the graph opens with. */
export function defaultCollapsed(spec: WorkflowSpec, enabled: boolean): Set<string> {
  return enabled
    ? new Set([...collapsibleUses(spec).map(macroUseFoldKey), ...collapsibleGroups(spec)])
    : new Set();
}

interface Unit {
  kind: 'group' | 'use';
  group: string;
  key: string;
  id: string;
  title: string;
  memberIds: string[];
}

export function foldGroups(
  spec: WorkflowSpec,
  collapsed: ReadonlySet<string>,
  keep: ReadonlySet<string> = new Set()
): GroupFold {
  const holdsKept = (ids: string[]) => ids.some((id) => keep.has(id));
  const membersBy = (
    labelOf: (n: SpecNode) => string | undefined,
    label: string,
    skip?: Set<string>
  ) =>
    Object.entries(spec.nodes)
      .filter(([id, node]) => !skip?.has(id) && labelOf(node) === label)
      .map(([id]) => id);

  // Uses first: a use the viewer asked to collapse but that holds something they are
  // looking for stays open.
  const useCandidates = collapsibleUses(spec);
  const useUnits: Unit[] = [];
  const openUses = new Set<string>();
  for (const useId of useCandidates) {
    const memberIds = membersBy(nodeUseOf, useId);
    if (!collapsed.has(macroUseFoldKey(useId))) {
      continue;
    }
    if (holdsKept(memberIds)) {
      openUses.add(useId);
      continue;
    }
    useUnits.push({
      group: useId,
      id: foldedUseId(useId),
      key: macroUseFoldKey(useId),
      kind: 'use',
      memberIds,
      title: macroUseDisplayName(spec, useId),
    });
  }
  const absorbed = new Set(useUnits.flatMap((u) => u.memberIds));

  // Then the groups, judged on what the collapsing uses left.
  const groupCandidates = honestLabels(spec, nodeGroupOf, absorbed);
  const groupUnits: Unit[] = [];
  const openGroups = new Set<string>();
  for (const group of groupCandidates) {
    const memberIds = membersBy(nodeGroupOf, group, absorbed);
    if (!collapsed.has(group)) {
      continue;
    }
    if (holdsKept(memberIds)) {
      openGroups.add(group);
      continue;
    }
    groupUnits.push({
      group,
      id: foldedGroupId(group),
      key: group,
      kind: 'group',
      memberIds,
      title: group,
    });
  }

  const collapsible = [
    ...useCandidates.filter((u) => !openUses.has(u)).map(macroUseFoldKey),
    ...groupCandidates.filter((g) => !openGroups.has(g)),
  ];
  const units = [...useUnits, ...groupUnits];
  if (units.length === 0) {
    return { collapsible, extraEdges: [], folded: {}, spec };
  }

  const unitOfNode = new Map<string, Unit>();
  for (const unit of units) {
    for (const id of unit.memberIds) {
      unitOfNode.set(id, unit);
    }
  }
  const resolve = (id: string): string => unitOfNode.get(id)?.id ?? id;
  const labelOf = (id: string): string =>
    unitOfNode.get(id)?.title ?? nodeDisplayName(spec.nodes[id], id);

  const folded: Record<string, FoldedGroup> = {};
  for (const unit of units) {
    const exits = new Map<string, FoldedGroupExit>();
    for (const memberId of unit.memberIds) {
      for (const [, target] of nodeEdges(spec.nodes[memberId] as SpecNode)) {
        const to = resolve(target);
        if (to !== unit.id && !exits.has(to)) {
          exits.set(to, { label: labelOf(target), port: `exit:${to}`, to });
        }
      }
    }
    folded[unit.id] = {
      exits: [...exits.values()],
      group: unit.group,
      id: unit.id,
      key: unit.key,
      kind: unit.kind,
      memberIds: unit.memberIds,
      title: unit.title,
    };
  }

  const nodes: Record<string, SpecNode> = {};
  const placed = new Set<string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    const unit = unitOfNode.get(id);
    if (unit) {
      if (!placed.has(unit.id)) {
        placed.add(unit.id);
        nodes[unit.id] = {
          config: { count: unit.memberIds.length },
          ...(unit.kind === 'group' ? { group: unit.group } : {}),
          step: GROUP_STEP,
          title: unit.title,
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
