import { AGENT_RUN_MAX_PROMPT_CHARS } from '@auto-swe/shared/lib/agentRun';
import type { AgentRunLimits } from '@auto-swe/shared/types/api';
import { ApiError } from '@/lib/api';
import { isRecord } from '@/lib/utils';

export { AGENT_RUN_MAX_PROMPT_CHARS } from '@auto-swe/shared/lib/agentRun';

export type AgentRunDeliver = 'none' | 'branch' | 'draft_pr';

export const DELIVER_OPTIONS: { value: AgentRunDeliver; label: string; description: string }[] = [
  {
    description: 'Nothing leaves the sandbox. You get the answer and the diff back.',
    label: 'Show me the result',
    value: 'none',
  },
  {
    description: 'Push the change to a new branch once the safety checks pass.',
    label: 'Push a branch',
    value: 'branch',
  },
  {
    description: 'Push a branch and open a draft pull request. Nothing is ever merged for you.',
    label: 'Open a draft pull request',
    value: 'draft_pr',
  },
];

/** `<key>` floats to the latest version; `<key>@<version>` pins the GLOBAL version. */
export function buildAgentRef(key: string, pinnedVersion: number | null): string {
  return pinnedVersion === null ? key : `${key}@${pinnedVersion}`;
}

export interface AgentRunFormValues {
  agentKey: string;
  /** `null` floats to the latest version. */
  pinnedVersion: number | null;
  prompt: string;
  repoId: string;
  deliver: AgentRunDeliver;
  /** Raw text of the optional caps; blank means "use the platform ceiling". */
  maxSteps: string;
  maxWallClockSeconds: string;
}

export type AgentRunFormErrors = Partial<
  Record<'agentKey' | 'prompt' | 'repoId' | 'maxSteps' | 'maxWallClockSeconds', string>
>;

/** A blank cap is "not set"; anything but a plain positive integer is `NaN` (invalid). */
function parseCap(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') {
    return undefined;
  }
  return /^[1-9][0-9]*$/.test(t) ? Number(t) : Number.NaN;
}

function capError(
  raw: string,
  label: string,
  unit: string,
  bounds: { ceiling: number; min: number }
): string | undefined {
  const n = parseCap(raw);
  if (n === undefined) {
    return undefined;
  }
  if (Number.isNaN(n)) {
    return `${label} must be a whole number`;
  }
  if (n < bounds.min) {
    return `${label} must be at least ${bounds.min} ${unit}`;
  }
  if (n > bounds.ceiling) {
    return `${label} can only lower the platform ceiling of ${bounds.ceiling} ${unit}`;
  }
  return undefined;
}

/**
 * Client-side validation. A convenience only: the gateway re-checks everything
 * (and the worker again), and `limits` may be unavailable or stale, in which
 * case the caps are only checked for being whole numbers.
 */
export function validateAgentRunForm(
  v: AgentRunFormValues,
  limits: AgentRunLimits | undefined
): AgentRunFormErrors {
  const errors: AgentRunFormErrors = {};
  if (!v.agentKey) {
    errors.agentKey = 'Choose an agent';
  }
  if (!v.repoId) {
    errors.repoId = 'Choose a repository';
  }
  if (v.prompt.trim() === '') {
    errors.prompt = 'Tell the agent what to do';
  } else if (v.prompt.length > AGENT_RUN_MAX_PROMPT_CHARS) {
    errors.prompt = `The prompt can be at most ${AGENT_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')} characters`;
  }
  const steps = capError(
    v.maxSteps,
    'Max steps',
    'steps',
    limits
      ? { ceiling: limits.maxSteps.ceiling, min: limits.maxSteps.min }
      : { ceiling: 500, min: 1 }
  );
  if (steps) {
    errors.maxSteps = steps;
  }
  const clock = capError(
    v.maxWallClockSeconds,
    'Time limit',
    'seconds',
    limits
      ? { ceiling: limits.maxWallClockSeconds.ceiling, min: limits.maxWallClockSeconds.min }
      : { ceiling: 14_400, min: 60 }
  );
  if (clock) {
    errors.maxWallClockSeconds = clock;
  }
  return errors;
}

/** The request body for `POST /api/v1/agent-runs`; caps omitted when blank. */
export function buildLaunchBody(v: AgentRunFormValues) {
  return {
    agent: buildAgentRef(v.agentKey, v.pinnedVersion),
    deliver: v.deliver,
    maxSteps: parseCap(v.maxSteps),
    maxWallClockSeconds: parseCap(v.maxWallClockSeconds),
    prompt: v.prompt,
    repoId: v.repoId,
  };
}

/**
 * Idempotency for the launch: one key per distinct submission. Resubmitting
 * the same values (a retry after a dropped connection, a double click) reuses
 * the key, so the gateway answers `RUN_CONFLICT` instead of starting a second
 * run; changing anything, or starting over, mints a fresh one.
 */
/**
 * A fresh random key. `crypto.randomUUID` exists only in secure contexts, and
 * the dashboard may be served over plain http, so fall back to `getRandomValues`
 * (available everywhere).
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface IdempotencyState {
  fingerprint: string;
  key: string;
}

export function idempotencyFor(
  prev: IdempotencyState | null,
  body: object,
  newKey: () => string = newIdempotencyKey
): IdempotencyState {
  const fingerprint = JSON.stringify(body);
  return prev && prev.fingerprint === fingerprint ? prev : { fingerprint, key: newKey() };
}

export interface LaunchErrorView {
  title: string;
  message: string;
  /** What the person can do next, when there is something. */
  hint?: string;
  /** Another click on Launch could succeed without changing anything. */
  retryable: boolean;
  /** The launch may already have started a run (an idempotent resubmission). */
  duplicate?: boolean;
}

/** Explains a failed launch (or re-run) by the gateway's error code. */
export function describeLaunchError(err: unknown): LaunchErrorView {
  const message = err instanceof Error ? err.message : 'The launch failed';
  const status = err instanceof ApiError ? err.status : null;
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'AGENT_RUN_CONCURRENCY_EXCEEDED':
      return {
        hint: 'Runs hold a workspace for their whole duration. Try again when one finishes.',
        message,
        retryable: true,
        title: 'Too many agent runs in flight',
      };
    case 'AGENT_RUNS_DISABLED':
      return {
        hint: 'An administrator can enable them in Platform settings (workspace.agentRunMaxConcurrent*).',
        message,
        retryable: false,
        title: 'Agent runs are turned off',
      };
    case 'CAP_EXCEEDS_CEILING':
      return {
        hint: 'A run can only lower the platform ceilings. Lower the value or leave it blank.',
        message,
        retryable: false,
        title: 'Limit above the platform ceiling',
      };
    case 'AGENT_PIN_SHADOWED':
      return {
        hint: 'Set the Version field to "Latest" (on the details screen) to run your organization’s version of this agent.',
        message,
        retryable: false,
        title: 'That version cannot be pinned',
      };
    case 'AGENT_NOT_LAUNCHABLE':
      return {
        message,
        retryable: false,
        title: 'This agent cannot be launched',
      };
    case 'AGENT_NOT_FOUND':
      return {
        hint: 'It may have been deactivated or replaced. Reload the agent list.',
        message,
        retryable: false,
        title: 'Agent not found',
      };
    case 'RUN_CONFLICT':
      return {
        duplicate: true,
        hint: 'This exact launch was already submitted. Check Runs before launching again.',
        message,
        retryable: false,
        title: 'Already started',
      };
    case 'REPO_HOST_NOT_ALLOWED':
      return { message, retryable: false, title: 'Repository host not approved' };
    case 'NOT_A_GIT_REPO':
      return { message, retryable: false, title: 'Not a git repository' };
    case 'AGENT_RUN_TEMPLATE_MISSING':
      return {
        hint: 'Ask an administrator to run the database seed.',
        message,
        retryable: false,
        title: 'Agent runs are not set up',
      };
    case 'AGENT_RUN_NOT_FOUND':
      return { message, retryable: false, title: 'Agent run not found' };
    default:
      break;
  }
  if (status === 402) {
    return { message, retryable: false, title: 'Monthly budget reached' };
  }
  if (status === 403) {
    return {
      hint: 'You need to be a member of the repository’s team (or one it is shared with).',
      message,
      retryable: false,
      title: 'Not allowed',
    };
  }
  if (status === 404) {
    return { message, retryable: false, title: 'Not found' };
  }
  if (status === 409) {
    return { message, retryable: false, title: 'Cannot launch right now' };
  }
  return { message, retryable: true, title: 'The launch failed' };
}

// ── Run viewer ──────────────────────────────────────────────────────────────

export interface AgentRunOutcome {
  text: string;
  deliver: AgentRunDeliver;
  diff: string;
  diffTruncated: boolean;
  /** `false`: the diff is the agent's own view of its container and is not to be trusted. */
  diffVerified: boolean;
  filesChanged: { path: string; operation: string; linesAdded: number; linesRemoved: number }[];
  gate: 'passed' | 'no_changes' | 'not_applicable' | null;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  headSha: string | null;
  stoppedReason: 'max_steps' | 'wall_clock' | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Reads the terminate result of an agent run, tolerantly: a missing field is absent, never a crash. */
export function parseAgentRunOutcome(result: unknown): AgentRunOutcome | null {
  if (!isRecord(result)) {
    return null;
  }
  const deliver =
    result.deliver === 'branch' || result.deliver === 'draft_pr' ? result.deliver : 'none';
  const files = Array.isArray(result.filesChanged) ? result.filesChanged : [];
  return {
    branch: str(result.branch),
    deliver,
    diff: typeof result.diff === 'string' ? result.diff : '',
    diffTruncated: result.diffTruncated === true,
    diffVerified: result.diffVerified === true,
    filesChanged: files.filter(isRecord).map((f) => ({
      linesAdded: typeof f.linesAdded === 'number' ? f.linesAdded : 0,
      linesRemoved: typeof f.linesRemoved === 'number' ? f.linesRemoved : 0,
      operation: typeof f.operation === 'string' ? f.operation : 'MODIFY',
      path: typeof f.path === 'string' ? f.path : '(unknown)',
    })),
    gate:
      result.gate === 'passed' || result.gate === 'no_changes' || result.gate === 'not_applicable'
        ? result.gate
        : null,
    headSha: str(result.headSha),
    prNumber: typeof result.prNumber === 'number' ? result.prNumber : null,
    prUrl: str(result.prUrl),
    stoppedReason:
      result.stoppedReason === 'max_steps' || result.stoppedReason === 'wall_clock'
        ? result.stoppedReason
        : null,
    text: typeof result.text === 'string' ? result.text : '',
  };
}

export {
  type AgentRunFailureView,
  classifyAgentRunFailure,
} from '@auto-swe/shared/lib/agentRunFailure';

/**
 * What a re-run of this agent run will do, read from the launch payload the run
 * kept (`contextSnapshot.request.payload`), else from its result. `null` when
 * neither says, which callers treat as "may publish".
 */
export function agentRunDeliver(run: {
  contextSnapshot?: unknown;
  result?: unknown;
}): AgentRunDeliver | null {
  const request = isRecord(run.contextSnapshot) ? run.contextSnapshot.request : null;
  const payload = isRecord(request) ? request.payload : null;
  for (const v of [
    isRecord(payload) ? payload.deliver : null,
    isRecord(run.result) ? run.result.deliver : null,
  ]) {
    if (v === 'none' || v === 'branch' || v === 'draft_pr') {
      return v;
    }
  }
  return null;
}

/** The consequence a re-run's confirmation names; `null` for a re-run that publishes nothing. */
export function rerunConsequence(deliver: AgentRunDeliver | null): string | null {
  switch (deliver) {
    case 'none':
      return null;
    case 'branch':
      return 'This starts a new agent run that pushes a new branch to the repository once its checks pass.';
    case 'draft_pr':
      return 'This starts a new agent run that pushes a new branch and opens a new draft pull request once its checks pass.';
    default:
      return 'This starts a new agent run. The original delivery is not recorded, so it may push a new branch or open a draft pull request.';
  }
}
