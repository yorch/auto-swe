/**
 * Tie agent traces to the graph nodes (and fan-out branches) that produced them.
 *
 * New traces carry `specNodeId` (the node's key in `spec.nodes`) and `recordingId`
 * (that key, prefixed with the fan-out branch path inside a branch:
 * `fan[0]/impl`, `fan[0]/inner[1]/impl`), so linkage is an exact read. Traces
 * recorded before those columns existed carry only `nodeId`, the Temporal
 * activity name, so they fall back to the spec nodes that run that activity.
 * That fallback can name more than one node (two nodes can use the same step) and
 * can never name a branch, so it reports every candidate and flags the result as
 * ambiguous rather than guessing one.
 *
 * Selection is a single string: a spec node id (graph click) or a recording id
 * (a step row). A spec id selects every execution of the node, across all
 * branches; a fan-out's id selects everything that ran inside it; a recording id
 * selects exactly that branch's execution.
 */
import type { AgentTraceRecord } from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow/spec';

/** The Temporal activity a node of each non-`step` type dispatches through. */
const ACTIVITY_OF_NODE_TYPE: Record<string, string> = {
  agent: 'runAgentNode',
  containerStep: 'runContainerStep',
  eval: 'runEvalNode',
  mcp: 'mcpCallTool',
  shell: 'runShellStep',
};

export interface TraceLinker {
  /** Every key in `spec.nodes`. */
  specNodeIds: ReadonlySet<string>;
  /** Activity name to the spec nodes that run it, in spec order. Fallback for old traces. */
  candidatesByActivity: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_LINKER: TraceLinker = {
  candidatesByActivity: new Map(),
  specNodeIds: new Set(),
};

export function buildTraceLinker(spec: WorkflowSpec | null | undefined): TraceLinker {
  if (!spec?.nodes) {
    return EMPTY_LINKER;
  }
  const candidatesByActivity = new Map<string, string[]>();
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    const activity = node.type === 'step' ? node.step : ACTIVITY_OF_NODE_TYPE[node.type];
    if (!activity) {
      continue;
    }
    const list = candidatesByActivity.get(activity);
    if (list) {
      list.push(nodeId);
    } else {
      candidatesByActivity.set(activity, [nodeId]);
    }
  }
  return { candidatesByActivity, specNodeIds: new Set(Object.keys(spec.nodes)) };
}

/**
 * Spec node id for a recording id. Node ids are free-form, so this prefers the
 * longest spec key the recording id ends with (a whole `/`-delimited segment)
 * and only parses the string when the spec cannot say.
 */
export function specNodeIdOfRecording(recordingId: string, linker: TraceLinker): string {
  if (linker.specNodeIds.has(recordingId)) {
    return recordingId;
  }
  let best: string | null = null;
  for (const id of linker.specNodeIds) {
    if (recordingId.endsWith(`/${id}`) && (best === null || id.length > best.length)) {
      best = id;
    }
  }
  if (best !== null) {
    return best;
  }
  return recordingId.slice(recordingId.lastIndexOf('/') + 1);
}

/** Branch path of a recording id (`fan[0]/inner[1]`), or null outside any fan-out. */
export function branchOfRecording(recordingId: string, specNodeId: string): string | null {
  const suffix = `/${specNodeId}`;
  if (!recordingId.endsWith(suffix)) {
    return null;
  }
  return recordingId.slice(0, -suffix.length) || null;
}

/**
 * Fan-out node ids a branch path runs inside, outermost first. Node ids are
 * free-form, so each `id[n]` segment is matched against the spec's ids (longest
 * first) instead of splitting the path on `/`.
 */
function fanOutsOfBranch(branch: string | null, linker: TraceLinker): string[] {
  const found: string[] = [];
  let rest = branch ?? '';
  while (rest) {
    let best: { id: string; len: number } | null = null;
    for (const id of linker.specNodeIds) {
      if (!rest.startsWith(`${id}[`)) {
        continue;
      }
      const index = /^\d+\]/.exec(rest.slice(id.length + 1));
      if (!index) {
        continue;
      }
      const len = id.length + 1 + index[0].length;
      if ((rest.length === len || rest[len] === '/') && (!best || id.length > best.id.length)) {
        best = { id, len };
      }
    }
    if (best) {
      found.push(best.id);
      rest = rest.slice(best.len + 1);
    } else {
      // A segment the spec no longer names: step past it and keep looking.
      const slash = rest.indexOf('/');
      rest = slash === -1 ? '' : rest.slice(slash + 1);
    }
  }
  return found;
}

export interface TraceAttribution {
  /** Node ids the trace may belong to; one when exact. Empty when nothing maps. */
  candidates: readonly string[];
  /** True when the node was recorded; false when inferred from the activity name. */
  exact: boolean;
  /** Inferred from the activity name and naming two or more nodes. Never true when exact. */
  ambiguous: boolean;
  /** Recording id when recorded, else null. */
  recordingId: string | null;
  /** Branch path when recorded inside a fan-out. */
  branch: string | null;
}

export function attributeTrace(t: AgentTraceRecord, linker: TraceLinker): TraceAttribution {
  if (t.specNodeId) {
    const recordingId = t.recordingId ?? t.specNodeId;
    return {
      ambiguous: false,
      branch: branchOfRecording(recordingId, t.specNodeId),
      candidates: [t.specNodeId],
      exact: true,
      recordingId,
    };
  }
  const candidates = linker.candidatesByActivity.get(t.nodeId) ?? [];
  return {
    ambiguous: candidates.length > 1,
    branch: null,
    candidates,
    exact: false,
    recordingId: null,
  };
}

/** Does `selection` (a spec node id or a recording id) pick out this recording? */
export function recordingMatchesSelection(
  recordingId: string,
  selection: string,
  linker: TraceLinker,
  /** The recorded spec node when the caller has it; otherwise inferred from the id. */
  knownSpecId?: string
): boolean {
  if (linker.specNodeIds.has(selection)) {
    const specId = knownSpecId ?? specNodeIdOfRecording(recordingId, linker);
    if (specId === selection) {
      return true;
    }
    return fanOutsOfBranch(branchOfRecording(recordingId, specId), linker).includes(selection);
  }
  // A recording id selects that execution, or everything inside it when it is a
  // fan-out's own recording id (its branches are `<id>[i]/...`).
  return recordingId === selection || recordingId.startsWith(`${selection}[`);
}

/** Does `selection` pick out this trace? Old traces match by candidate node, ambiguous if so. */
export function traceMatchesSelection(
  t: AgentTraceRecord,
  selection: string,
  linker: TraceLinker
): boolean {
  if (t.specNodeId) {
    return recordingMatchesSelection(
      t.recordingId ?? t.specNodeId,
      selection,
      linker,
      t.specNodeId
    );
  }
  const candidates = linker.candidatesByActivity.get(t.nodeId) ?? [];
  const selectedNode = linker.specNodeIds.has(selection)
    ? selection
    : specNodeIdOfRecording(selection, linker);
  return candidates.includes(selectedNode);
}

/**
 * Does this trace belong to one recorded step row (one node execution)? Stricter
 * than selection: it never widens to the node's other branches, and a recorded
 * interpreter attempt must match the row's attempt.
 */
export function traceBelongsToStep(
  t: AgentTraceRecord,
  step: { nodeId: string; attempt: number },
  linker: TraceLinker
): boolean {
  if (t.specNodeId) {
    return (
      (t.recordingId ?? t.specNodeId) === step.nodeId &&
      (t.stepAttempt === null || t.stepAttempt === step.attempt)
    );
  }
  return (linker.candidatesByActivity.get(t.nodeId) ?? []).includes(
    specNodeIdOfRecording(step.nodeId, linker)
  );
}
