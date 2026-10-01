/**
 * Collapse a run's step records into one status per spec node, for the graph overlay.
 *
 * A step inside a fan-out is recorded under its branch-local id (`fan[0]/impl`,
 * `fan[1]/impl`), but the graph draws a single `impl` node. Two folds happen:
 *
 *   - Within one recording id the latest attempt wins — a retry supersedes the
 *     attempt it retried.
 *   - Across recording ids (branches) the *worst* status wins. Taking the last
 *     branch to report instead lets a passing sibling paint over a failed one, so
 *     the graph shows green for a run whose branch failed.
 */
export interface StepOverlayInput {
  nodeId: string;
  attempt: number;
  status: string;
}

export interface NodeOverlay {
  status: string;
  attempt: number;
}

/** Higher shadows lower. FAILED is what a viewer must never miss. */
const SEVERITY: Record<string, number> = {
  FAILED: 5,
  PASSED: 2,
  PENDING: 3,
  RUNNING: 4,
  SKIPPED: 1,
};

const severity = (status: string): number => SEVERITY[status] ?? 0;

/** Spec node id for a (possibly branch-prefixed) recording id. */
export function specNodeIdOf(recordingId: string): string {
  return recordingId.includes('/') ? (recordingId.split('/').pop() ?? recordingId) : recordingId;
}

export function buildDagOverlay(steps: readonly StepOverlayInput[]): {
  byNodeId: Record<string, NodeOverlay>;
} {
  const latestPerRecording = new Map<string, StepOverlayInput>();
  for (const s of steps) {
    const existing = latestPerRecording.get(s.nodeId);
    if (!existing || s.attempt >= existing.attempt) {
      latestPerRecording.set(s.nodeId, s);
    }
  }

  const byNodeId: Record<string, NodeOverlay> = {};
  for (const s of latestPerRecording.values()) {
    const id = specNodeIdOf(s.nodeId);
    const current = byNodeId[id];
    if (!current || severity(s.status) > severity(current.status)) {
      byNodeId[id] = { attempt: s.attempt, status: s.status };
    }
  }
  return { byNodeId };
}
