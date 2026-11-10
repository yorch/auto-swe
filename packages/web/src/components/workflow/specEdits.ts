/**
 * Structural spec edits for the workflow editor — deleting a node, renaming a
 * node, clearing one edge.
 *
 * Every one of these has to rewrite the *references* other nodes hold, and the
 * set of reference-bearing fields is not a list this file is allowed to keep:
 * it is `nodeEdges()` in the spec module, which the schema's ref validation and
 * the interpreter's reachability analysis already read from. Editors that kept
 * their own hardcoded field list drifted from it (missing `onApprove`,
 * `onReject`, `onSubmit`, and the indexed `options[i].next` entirely), which
 * left deleted-node references and stale ids behind after a rename. So these
 * helpers walk `nodeEdges()` and write through `setNodeEdge()`, and a new edge
 * field added to the grammar is handled here the day it lands.
 *
 * ## Required edges and the unresolved-branch placeholder
 *
 * Most edge fields are *required* by the schema: `cond.onTrue`/`onFalse`,
 * `signal.onReceive`/`onTimeout`, `fanOut.subgraph`/`join`, every `human*` edge,
 * and each `humanDecision` option's `next`. Only `next` on the step-like nodes
 * is optional. So "just drop the field" is not available: it produces a node
 * that fails `parseWorkflowSpec` on save, and the user sees a schema error about
 * a node they did not touch instead of the delete they asked for.
 *
 * Rather than blocking the delete — a button that does nothing is the most
 * confusing thing a canvas can do, and the inspector has no room to explain
 * which nodes referenced the deleted one — a required edge is retargeted to a
 * shared `terminate` placeholder (`unresolved_branch`, status SKIPPED) created
 * on demand and reused. The delete succeeds, the spec still parses, and every
 * orphaned branch is *drawn* into one obvious node the user can re-point or
 * delete once nothing routes into it. Optional edges are simply cleared.
 *
 * ## Nodes of a macro use
 *
 * A node tagged `use` was expanded from an entry of the spec's `uses` map, and the
 * save path refuses a use whose nodes are not its fresh expansion. Deleting or
 * renaming one such node would always produce that drift, so both are refused
 * here (a no-op, like deleting the entry node) and {@link macroLockReason} says why;
 * the inspector's Macro section offers the two edits that are allowed — re-expand
 * with other arguments, or detach the use so its nodes become ordinary ones.
 * Renaming a node OUTSIDE a use that the use routes to (`passed: 'openPR'`)
 * rewrites the use's arguments as well as its nodes' edges, so the two still agree.
 */

import type { MacroUse, Node as SpecNode, WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  getMacro,
  NodeSchema,
  nodeEdges,
  readNodeEdge,
  setNodeEdge,
} from '@auto-swe/shared/workflow';
import { macroUseDisplayName } from './macroDisplay';
import { nodeUseOf } from './nodeDisplay';

/** Id of the placeholder node orphaned required edges are retargeted to. */
export const UNRESOLVED_NODE_ID = 'unresolved_branch';

/** Shape of that placeholder: a terminate node that ends the branch as SKIPPED. */
const UNRESOLVED_NODE: SpecNode = { status: 'SKIPPED', type: 'terminate' };

/**
 * Does the schema require this edge field to keep a target?
 *
 * Asked of the schema itself rather than a hand-kept table, because a table is
 * exactly what drifts: a required edge field added to any node type would be
 * silently classified optional and cleared into an unparseable spec. The two
 * questions asked here — "can this edge even be cleared?" and "does the node
 * still parse without it?" — are answered by the grammar and by `NodeSchema`.
 */
export function isEdgeFieldRequired(node: SpecNode, field: string): boolean {
  const cleared = setNodeEdge(node, field, null);
  // `setNodeEdge` cannot express clearing a `humanDecision` option's `next` —
  // the option is an array element that must carry a target. An edge that
  // survives clearing is therefore one that must keep one.
  if (readNodeEdge(cleared, field) !== undefined) {
    return true;
  }
  // A node that does not parse *with* the field tells us nothing about the
  // field; fall back to clearing, which is what the editor did before.
  if (!NodeSchema.safeParse(node).success) {
    return false;
  }
  return !NodeSchema.safeParse(cleared).success;
}

/**
 * Rewrite every outgoing edge in `nodes` through `map`. A `null` from `map`
 * means "this target is gone": the edge is cleared if the schema allows it and
 * retargeted to the placeholder if it does not.
 */
export function rewriteEdges(
  nodes: WorkflowSpec['nodes'],
  map: (target: string) => string | null
): WorkflowSpec['nodes'] {
  const out: Record<string, SpecNode> = {};
  let needsPlaceholder = false;

  for (const [id, node] of Object.entries(nodes)) {
    let patched = node;
    for (const [field, target] of nodeEdges(node)) {
      const mapped = map(target);
      if (mapped === target) {
        continue;
      }
      if (mapped === null && isEdgeFieldRequired(node, field)) {
        patched = setNodeEdge(patched, field, UNRESOLVED_NODE_ID);
        needsPlaceholder = true;
      } else {
        patched = setNodeEdge(patched, field, mapped);
      }
    }
    out[id] = patched;
  }

  // Created on demand and reused. If a node already owns the id we route into
  // it as-is rather than clobbering an existing node the user authored.
  if (needsPlaceholder && !out[UNRESOLVED_NODE_ID]) {
    out[UNRESOLVED_NODE_ID] = UNRESOLVED_NODE;
  }
  return out as WorkflowSpec['nodes'];
}

/**
 * Delete `id` and repair every reference to it.
 *
 * Deleting the entry node, or a node that is not in the spec, is a no-op.
 * Deleting the placeholder itself while required edges still point at it
 * re-creates it — those branches have nowhere else to go, so the placeholder
 * only disappears once nothing routes into it.
 */
export function deleteNodeFromSpec(spec: WorkflowSpec, id: string): WorkflowSpec {
  if (id === spec.entry || !spec.nodes[id] || macroLockReason(spec, id)) {
    return spec;
  }
  const { [id]: _removed, ...rest } = spec.nodes;
  return {
    ...spec,
    nodes: rewriteEdges(rest as WorkflowSpec['nodes'], (target) => (target === id ? null : target)),
  };
}

/** Rename `oldId` to `newId`, moving the entry pointer and every reference. */
export function renameNodeInSpec(spec: WorkflowSpec, oldId: string, newId: string): WorkflowSpec {
  if (
    !newId ||
    oldId === newId ||
    !spec.nodes[oldId] ||
    spec.nodes[newId] ||
    macroLockReason(spec, oldId, 'rename')
  ) {
    return spec;
  }
  const moved: Record<string, SpecNode> = {};
  for (const [k, v] of Object.entries(spec.nodes)) {
    moved[k === oldId ? newId : k] = v;
  }
  const uses = renameInUseArgs(spec.uses, oldId, newId);
  return {
    ...spec,
    entry: spec.entry === oldId ? newId : spec.entry,
    nodes: rewriteEdges(moved as WorkflowSpec['nodes'], (target) =>
      target === oldId ? newId : target
    ),
    ...(uses !== spec.uses ? { uses } : {}),
  };
}

/**
 * Why `id` may not be deleted (or, with `action: 'rename'`, renamed) on its own, or
 * null when it may. Either it is a node of a declared macro use, or (delete only) a
 * declared use routes to it through an edge argument: deleting it would leave the
 * arguments naming a node that no longer exists. A rename rewrites those arguments,
 * so it stays allowed. A tag naming no `uses` entry does not lock the node (there
 * is no expansion to drift from; the lint already reports the tag).
 */
export function macroLockReason(
  spec: WorkflowSpec,
  id: string,
  action: 'delete' | 'rename' = 'delete'
): string | null {
  const useId = nodeUseOf(spec.nodes[id]);
  if (useId && spec.uses && Object.hasOwn(spec.uses, useId)) {
    return `'${id}' was generated by the macro use ${macroUseDisplayName(spec, useId)}, so it cannot be deleted or renamed on its own. Detach the use to edit its nodes freely, or re-expand it with different arguments.`;
  }
  if (action === 'delete') {
    const router = routingUseOf(spec, id);
    if (router) {
      return `'${id}' is routed to by use ${macroUseDisplayName(spec, router)}; change its arguments first.`;
    }
  }
  return null;
}

/** The first declared use whose edge arguments (a macro's `edgeArgs`) name `id`. */
function routingUseOf(spec: WorkflowSpec, id: string): string | null {
  for (const [useId, use] of Object.entries(spec.uses ?? {})) {
    for (const path of getMacro(use.macro)?.edgeArgs ?? []) {
      if (readPath(use.args, path) === id) {
        return useId;
      }
    }
  }
  return null;
}

/** Read a dotted path (`fix.handoff.rereview`) of a JSON value. */
function readPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, key)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** A copy of `value` with the dotted path set (every step along it already exists). */
function writePath(
  value: Record<string, unknown>,
  path: string,
  next: unknown
): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined) {
    return value;
  }
  return {
    ...value,
    [head]:
      rest.length === 0
        ? next
        : writePath(value[head] as Record<string, unknown>, rest.join('.'), next),
  };
}

/**
 * The `uses` map with every argument that routes to `oldId` (a macro's `edgeArgs`)
 * pointed at `newId` instead. The same reference when nothing changed.
 */
export function renameInUseArgs(
  uses: WorkflowSpec['uses'],
  oldId: string,
  newId: string,
  /** A use whose arguments are left as they are. */
  except?: string
): WorkflowSpec['uses'] {
  if (!uses) {
    return uses;
  }
  let changed = false;
  const out: Record<string, MacroUse> = {};
  for (const [useId, use] of Object.entries(uses)) {
    if (useId === except) {
      out[useId] = use;
      continue;
    }
    const macro = getMacro(use.macro);
    let args = use.args;
    for (const path of macro?.edgeArgs ?? []) {
      if (readPath(args, path) === oldId) {
        args = writePath(args, path, newId);
      }
    }
    if (args !== use.args) {
      changed = true;
      out[useId] = { ...use, args };
    } else {
      out[useId] = use;
    }
  }
  return changed ? out : uses;
}

/**
 * Point one node's edge at `target`, or drop it when `target` is null — with
 * the same required-field handling as a delete, so clearing a required edge
 * parks it on the placeholder instead of producing an unparseable node.
 */
export function setSpecEdge(
  spec: WorkflowSpec,
  nodeId: string,
  field: string,
  target: string | null
): WorkflowSpec {
  const node = spec.nodes[nodeId];
  if (!node) {
    return spec;
  }
  if (target === null && isEdgeFieldRequired(node, field)) {
    const nodes: Record<string, SpecNode> = {
      ...spec.nodes,
      [nodeId]: setNodeEdge(node, field, UNRESOLVED_NODE_ID),
    };
    if (!nodes[UNRESOLVED_NODE_ID]) {
      nodes[UNRESOLVED_NODE_ID] = UNRESOLVED_NODE;
    }
    return { ...spec, nodes: nodes as WorkflowSpec['nodes'] };
  }
  return {
    ...spec,
    nodes: { ...spec.nodes, [nodeId]: setNodeEdge(node, field, target) },
  };
}
