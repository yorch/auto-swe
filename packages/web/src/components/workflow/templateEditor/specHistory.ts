import type { WorkflowSpec } from '@auto-swe/shared/workflow';

/** How many edits the editor remembers. */
export const HISTORY_LIMIT = 100;
/** Edits to one node within this window of the first one (typing in a field) are one undo step. */
export const COALESCE_MS = 1000;

export interface SpecHistory {
  /** Oldest first; the last entry is what Undo restores. */
  past: WorkflowSpec[];
  /** Nearest first; the first entry is what Redo restores. */
  future: WorkflowSpec[];
  /** When the current run of merged edits began, and the node it edits (null for a structural change). */
  lastAt: number;
  lastKey: string | null;
}

export const EMPTY_HISTORY: SpecHistory = { future: [], lastAt: 0, lastKey: null, past: [] };

/** The one node an edit changed, or null when it changed the graph's shape or several nodes. */
function editedNode(prev: WorkflowSpec, next: WorkflowSpec): string | null {
  if (prev.entry !== next.entry) {
    return null;
  }
  const ids = Object.keys(next.nodes);
  if (ids.length !== Object.keys(prev.nodes).length) {
    return null;
  }
  let changed: string | null = null;
  for (const id of ids) {
    const before = prev.nodes[id];
    const after = next.nodes[id];
    if (!before) {
      return null;
    }
    if (before !== after && JSON.stringify(before) !== JSON.stringify(after)) {
      if (changed !== null) {
        return null;
      }
      changed = id;
    }
  }
  return changed;
}

/** Record that `prev` became `next` through an edit (not through undo or redo). */
export function recordEdit(
  history: SpecHistory,
  prev: WorkflowSpec,
  next: WorkflowSpec,
  now: number
): SpecHistory {
  if (prev === next) {
    return history;
  }
  const key = editedNode(prev, next);
  const coalesce =
    key !== null &&
    key === history.lastKey &&
    now - history.lastAt < COALESCE_MS &&
    history.past.length > 0;
  return {
    future: [],
    lastAt: coalesce ? history.lastAt : now,
    lastKey: key,
    past: coalesce ? history.past : [...history.past, prev].slice(-HISTORY_LIMIT),
  };
}

/** Step back from `current`; null when there is nothing to undo. */
export function undoStep(
  history: SpecHistory,
  current: WorkflowSpec
): { history: SpecHistory; spec: WorkflowSpec } | null {
  const spec = history.past.at(-1);
  if (!spec) {
    return null;
  }
  return {
    history: {
      future: [current, ...history.future],
      lastAt: 0,
      lastKey: null,
      past: history.past.slice(0, -1),
    },
    spec,
  };
}

/** Step forward from `current`; null when there is nothing to redo. */
export function redoStep(
  history: SpecHistory,
  current: WorkflowSpec
): { history: SpecHistory; spec: WorkflowSpec } | null {
  const spec = history.future[0];
  if (!spec) {
    return null;
  }
  return {
    history: {
      future: history.future.slice(1),
      lastAt: 0,
      lastKey: null,
      past: [...history.past, current].slice(-HISTORY_LIMIT),
    },
    spec,
  };
}
