import type { Node, WorkflowSpec } from './spec.js';

/**
 * Structural diff between two `WorkflowSpec`s.
 *
 * Designed for the version-comparison UI: tells you which nodes were added,
 * removed, or changed between two template versions so the DAG viz can paint
 * the deltas without doing a free-form text diff in the browser.
 *
 * Comparison is value-equality (`JSON.stringify` canonicalized via deterministic
 * key sort) — node-shape only. Top-level metadata (`name`, `description`) is
 * also captured so a rename shows up cleanly.
 *
 * The diff is intentionally per-node, not per-field. A consumer that wants
 * field-level granularity for a single changed node can re-diff the two raw
 * `Node` values from `before.nodes[id]` / `after.nodes[id]`.
 */
export interface SpecDiff {
  /** Node IDs present in `after` but not `before`. */
  addedNodes: string[];
  /** Node IDs present in `before` but not `after`. */
  removedNodes: string[];
  /** Node IDs whose shape differs between the two specs. */
  changedNodes: string[];
  /** Node IDs unchanged across the two specs. */
  unchangedNodes: string[];
  /** Top-level spec-meta changes (entry / name / description / schemaVersion). */
  metaChanges: SpecMetaChange[];
}

export interface SpecMetaChange {
  field: 'entry' | 'name' | 'description' | 'schemaVersion';
  before: unknown;
  after: unknown;
}

/** Canonical JSON stringify with deterministic key sort, so object property
 *  ordering doesn't show up as a spurious change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function nodesEqual(a: Node, b: Node): boolean {
  return canonical(a) === canonical(b);
}

export function diffSpecs(before: WorkflowSpec, after: WorkflowSpec): SpecDiff {
  const beforeIds = new Set(Object.keys(before.nodes));
  const afterIds = new Set(Object.keys(after.nodes));

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const changedNodes: string[] = [];
  const unchangedNodes: string[] = [];

  for (const id of afterIds) {
    if (!beforeIds.has(id)) {
      addedNodes.push(id);
      continue;
    }
    const a = before.nodes[id];
    const b = after.nodes[id];
    if (a && b && nodesEqual(a, b)) unchangedNodes.push(id);
    else changedNodes.push(id);
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) removedNodes.push(id);
  }

  const metaChanges: SpecMetaChange[] = [];
  for (const field of ['entry', 'name', 'description', 'schemaVersion'] as const) {
    if (before[field] !== after[field]) {
      metaChanges.push({ after: after[field], before: before[field], field });
    }
  }

  return {
    addedNodes: addedNodes.sort(),
    changedNodes: changedNodes.sort(),
    metaChanges,
    removedNodes: removedNodes.sort(),
    unchangedNodes: unchangedNodes.sort(),
  };
}

/** Returns true when two specs are structurally identical. */
export function specsEqual(a: WorkflowSpec, b: WorkflowSpec): boolean {
  const d = diffSpecs(a, b);
  return (
    d.addedNodes.length === 0 &&
    d.removedNodes.length === 0 &&
    d.changedNodes.length === 0 &&
    d.metaChanges.length === 0
  );
}
