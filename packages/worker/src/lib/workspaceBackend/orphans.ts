import { T_AGENT_RUN_ACTIVITY_SECONDS } from '../../workflows/proxyOptions.js';
import { MANAGED_BY_LABEL, WORKSPACE_ROLE_LABEL } from './kubernetes/podSpec.js';

/**
 * What the orphaned-workspace sweep needs from both drivers: the labels that
 * say "this is ours", the age bounds past which a workspace cannot belong to a
 * live activity, and the pure selection of what to remove. The drivers own the
 * I/O (`docker ps`/`rm`, `kubectl get`/`delete`); keeping the decision here
 * makes it testable without either.
 */

/**
 * The most workspaces one sweep removes. Each removal is bounded at 60 s by its
 * driver, so 25 keeps the worst case (about 26 minutes) inside the sweep's
 * 30-minute activity timeout; a larger backlog is picked up by the next sweep.
 */
export const MAX_REAPED_PER_SWEEP = 25;

/** Result of one sweep over a backend's workspaces. */
export interface WorkspaceReapResult {
  /** Workspaces carrying the auto-swe marker that the sweep looked at. */
  scanned: number;
  /** Ids (container ids or pod names) it removed. */
  removed: string[];
  /** Ids it tried to remove, or `'(list)'` when it could not list at all. */
  failed: { id: string; error: string }[];
}

// ── Docker ──────────────────────────────────────────────────────────────────

/** Present on every container the worker creates; the sweep selects on it and nothing else. */
export const DOCKER_WORKSPACE_MARKER_LABEL = 'auto-swe.workspace';
/** Creation time in epoch seconds, written by the worker that created the container. */
export const DOCKER_WORKSPACE_CREATED_LABEL = 'auto-swe.created-at';

/** `docker run` flags that mark a container as an auto-swe workspace and stamp its birth. */
export function workspaceLabelArgs(now: Date = new Date()): string[] {
  return [
    '--label',
    `${DOCKER_WORKSPACE_MARKER_LABEL}=true`,
    '--label',
    `${DOCKER_WORKSPACE_CREATED_LABEL}=${Math.floor(now.getTime() / 1000)}`,
  ];
}

/** Slack on top of the longest activity, for a clock skew between workers and a slow teardown. */
const DOCKER_MAX_AGE_SLACK_SEC = 3600;

/**
 * The oldest a Docker workspace container can legitimately be. A workspace
 * exists inside one activity (`createWorkspace` ... `destroy` in a `finally`),
 * so it can live no longer than that activity's `startToCloseTimeout`. The
 * longest activity that holds one is the agent run step
 * (`T_AGENT_RUN_ACTIVITY`, 6 h: the 4 h wall-clock ceiling plus 2 h of headroom);
 * the others (eval 4 h, shell and container steps 60 m) are shorter, and the
 * 6 h CI poll holds no workspace. An hour of slack covers clock skew between
 * workers. A container older than this belongs to no live activity, whichever
 * worker started it.
 */
export const DOCKER_WORKSPACE_MAX_AGE_MS =
  (T_AGENT_RUN_ACTIVITY_SECONDS + DOCKER_MAX_AGE_SLACK_SEC) * 1000;

/** `docker ps` argv listing every container (running or not) that carries the marker label. */
export function dockerListArgs(): string[] {
  return [
    'ps',
    '--all',
    '--no-trunc',
    '--filter',
    `label=${DOCKER_WORKSPACE_MARKER_LABEL}=true`,
    '--format',
    `{{.ID}}|{{.Names}}|{{.Label "${DOCKER_WORKSPACE_CREATED_LABEL}"}}`,
  ];
}

export interface ListedContainer {
  id: string;
  name: string;
  /** Epoch seconds from the created-at label; null when absent or not a positive integer. */
  createdAtSec: number | null;
}

export function parseDockerListing(stdout: string): ListedContainer[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', created = ''] = line.split('|');
      return {
        createdAtSec: /^[1-9]\d*$/.test(created) ? Number(created) : null,
        id,
        name,
      };
    })
    .filter((c) => c.id !== '');
}

/**
 * The containers past the maximum lifetime, oldest first, so a capped sweep
 * frees the longest-held ones first. One with no usable creation time
 * (or one stamped in the future) is kept: age is the only proof it is not in
 * use, and without it the safe answer is to leave it.
 */
export function selectExpiredContainers(
  containers: ListedContainer[],
  now: Date
): ListedContainer[] {
  return containers
    .filter(
      (c) =>
        c.createdAtSec !== null &&
        c.createdAtSec > 0 &&
        now.getTime() - c.createdAtSec * 1000 > DOCKER_WORKSPACE_MAX_AGE_MS
    )
    .sort((a, b) => (a.createdAtSec ?? 0) - (b.createdAtSec ?? 0));
}

// ── Kubernetes ──────────────────────────────────────────────────────────────

/** How long past its deadline a pod may stay non-terminal before the sweep deletes it. */
export const K8S_POD_REAP_GRACE_MS = 10 * 60 * 1000;

export interface ListedPod {
  metadata: {
    name: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: { activeDeadlineSeconds?: number };
  status?: { phase?: string };
}

/**
 * The pods to delete, oldest first: those carrying both marker labels (re-checked here, not
 * trusted to the selector) that are not already being deleted and either have
 * terminated (`Succeeded`, or `Failed` — which is what a deadline kill is), or
 * are still not terminal past their own `activeDeadlineSeconds` (the
 * configured one when the pod names none) plus a grace period, which means
 * the kubelet failed to enforce it.
 */
export function selectReapablePods(
  pods: ListedPod[],
  now: Date,
  fallbackDeadlineSec: number
): ListedPod[] {
  const createdMs = (pod: ListedPod): number => {
    const t = pod.metadata.creationTimestamp
      ? Date.parse(pod.metadata.creationTimestamp)
      : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const reapable = pods.filter((pod) => {
    const { creationTimestamp, deletionTimestamp, labels, name } = pod.metadata;
    if (
      !name ||
      deletionTimestamp ||
      labels?.[MANAGED_BY_LABEL] !== 'auto-swe' ||
      labels?.[WORKSPACE_ROLE_LABEL] !== 'workspace'
    ) {
      return false;
    }
    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') {
      return true;
    }
    const created = creationTimestamp ? Date.parse(creationTimestamp) : Number.NaN;
    if (Number.isNaN(created)) {
      return false;
    }
    const deadlineSec = pod.spec?.activeDeadlineSeconds ?? fallbackDeadlineSec;
    // `creationTimestamp` is when the object was created, not when the deadline clock
    // started (that is the pod's start time, after scheduling and image pull). The two
    // differ only by the wait for Ready, which `READY_TIMEOUT_SEC` (300 s) bounds under
    // the 10-minute grace, so a pod still inside its deadline is never selected.
    return now.getTime() - created > deadlineSec * 1000 + K8S_POD_REAP_GRACE_MS;
  });
  // Oldest first, so a capped sweep frees the longest-held pods first.
  return reapable.sort((a, b) => createdMs(a) - createdMs(b));
}
