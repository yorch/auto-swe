import { ApiError } from '@/lib/api';
import { isRecord } from '@/lib/utils';

/**
 * Pure helpers for the "Describe the goal" flow: the wire types of `/api/v1/run-plans`, input
 * validation, error wording, polling cadence and the preview's outline. Everything the gateway or
 * the model sends is untrusted text; nothing here produces markup, and the components render it
 * as plain text only.
 */

/** Same limit as the gateway's `Intent` schema (`RUN_PLAN_INTENT_MAX_CHARS`). */
export const RUN_PLAN_INTENT_MAX_CHARS = 8000;

export type RunPlanMode = 'delivering' | 'output-only';
export type RunPlanStatus = 'PENDING' | 'APPROVED' | 'LAUNCHED' | 'REJECTED' | 'EXPIRED';
export type NodeMarker = 'core' | 'injected' | 'mandatory' | 'free';

export interface RouteMatch {
  templateId: string;
  name: string;
  description: string | null;
  reason: string;
  score: number;
}

export interface RouteResult {
  matches: RouteMatch[];
  noneFit: boolean;
}

export interface PlanNodeInput {
  key: string;
  /** The path the input is read from; null when it is not a plain `from` binding. */
  from: string | null;
  /** The binding has a fallback value for an empty path (the value itself is never sent). */
  hasDefault?: boolean;
}

export interface PlanNode {
  id: string;
  type: string | null;
  step: string | null;
  marker: NodeMarker;
  region: string;
  /** The agent an `agent` node runs; null otherwise. Older responses omit it. */
  agentRef?: string | null;
  inputs?: PlanNodeInput[];
  /** Context paths the node writes (a `set`'s keys and `storeAs`). */
  writes?: string[];
  /** The node's output reaches the implementer as guidance. */
  feedsImplementer?: boolean;
  /** A message the node authors, cleaned by the gateway; absent when it has none. */
  message?: string;
}

export interface PlanWarning {
  source: string;
  code: string;
  message: string;
  nodeId: string | null;
}

export interface PlanCost {
  totalUsd: number | null;
  unpricedCount: number;
  unpriced: { nodeId: string; reason: string }[];
}

export interface RunPlanView {
  id: string;
  status: RunPlanStatus;
  mode: RunPlanMode;
  agentKey: string | null;
  connectionId: string;
  teamId: string;
  intent: string;
  spec: unknown;
  specHash: string | null;
  nodes: PlanNode[];
  cost: unknown;
  warnings: PlanWarning[];
  agentPins: Record<string, string> | null;
  model: string | null;
  summary: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  launchedWorkflowRunId: string | null;
  /**
   * True once the retention sweep removed the goal and the plan body of a launched plan: `intent`
   * is empty, `nodes` is empty and `spec` is null. The metadata is all that is left.
   */
  scrubbed?: boolean;
  scrubbedAt?: string | null;
}

export interface RunPlanListItem {
  id: string;
  status: RunPlanStatus;
  mode: RunPlanMode;
  agentKey: string | null;
  connectionId: string;
  teamId: string;
  intent: string;
  createdAt: string;
  expiresAt: string;
  totalUsd: number | null;
  /** The goal and plan were removed after the retention period; `intent` is empty. */
  scrubbed?: boolean;
}

/** What the dashboard says wherever it meets a plan whose goal and body were removed. */
export const SCRUBBED_PLAN_NOTICE = 'The goal and plan were removed after the retention period';

export type PlanJob =
  | { status: 'running' }
  | { status: 'done'; planId: string }
  | { status: 'failed'; code: string; message: string; retryable: boolean };

export interface ApprovedPlan {
  planId: string;
  workRequestId: string;
  workflowId?: string;
  temporalWorkflowId?: string;
}

// ── Intent ──────────────────────────────────────────────────────────────────

/** Why the goal cannot be submitted, or null. Over-length is refused, never cut. */
export function intentError(intent: string): string | null {
  if (intent.trim() === '') {
    return 'Describe what you want done';
  }
  if (intent.length > RUN_PLAN_INTENT_MAX_CHARS) {
    return `The goal can be at most ${RUN_PLAN_INTENT_MAX_CHARS.toLocaleString('en-US')} characters; shorten it by ${(intent.length - RUN_PLAN_INTENT_MAX_CHARS).toLocaleString('en-US')}`;
  }
  return null;
}

export function intentCounter(intent: string): string {
  return `${intent.length.toLocaleString('en-US')} / ${RUN_PLAN_INTENT_MAX_CHARS.toLocaleString('en-US')}`;
}

/** The request body for `POST /run-plans`; `agent` only for an output-only plan. */
export function buildCreateBody(input: { intent: string; repoId: string; agent: string }) {
  return {
    ...(input.agent ? { agent: input.agent } : {}),
    intent: input.intent.trim(),
    repoId: input.repoId,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export interface PlanErrorView {
  title: string;
  message: string;
  hint?: string;
  /** Another click on the same action could succeed without changing the input. */
  retryable: boolean;
  /** The plan no longer matches the platform; the person regenerates it. */
  drift?: string;
}

const DRIFT_LABEL: Record<string, string> = {
  agents: 'the agents it uses',
  catalog: 'the workflow building blocks',
  repository: 'the repository',
  settings: 'platform settings',
  spec: 'the stored plan itself',
};

function driftKind(err: unknown): string | null {
  if (err instanceof ApiError && isRecord(err.details) && typeof err.details.drift === 'string') {
    return err.details.drift;
  }
  return null;
}

/**
 * Codes the gateway can send that are deliberately left to the generic status wording: each is a
 * request the dashboard cannot produce (a wrong mode or agent), or a plain 404/403 whose gateway
 * message already says what is wrong. A test checks that every code the gateway's run-plan files
 * name is either mapped below or listed here.
 */
export const GENERIC_PLAN_ERROR_CODES: readonly string[] = [
  'AGENT_NOT_FOUND',
  'AGENT_NOT_LAUNCHABLE',
  'CONNECTION_NOT_FOUND',
  'FORBIDDEN',
  'NOT_A_GIT_REPO',
  'PLAN_AGENT_MISMATCH',
  'PLAN_MODE_INVALID',
  'PLAN_NOT_APPROVED',
  'PLAN_NOT_REJECTABLE',
  'PLAN_SPEC_TOO_DEEP',
  'PLAN_SPEC_TOO_LARGE',
  'RUN_PLAN_JOB_NOT_FOUND',
  'RUN_PLAN_SERVICE_FORBIDDEN',
];

/** Fixed wording by code or status; server text is shown only where it is a fixed gateway string. */
export function describePlanError(err: unknown): PlanErrorView {
  const status = err instanceof ApiError ? err.status : null;
  const code = err instanceof ApiError ? err.code : null;
  const message = err instanceof Error ? err.message : 'The request failed';
  switch (code) {
    case 'PLAN_GENERATION_FAILED':
      return {
        hint: 'Say what the end result should be and which part of the repository it touches.',
        message: 'The platform could not produce a valid plan for that goal. Try rephrasing it.',
        retryable: true,
        title: 'No plan could be generated',
      };
    case 'PLAN_GENERATION_UNAVAILABLE':
      return {
        message: 'Plan generation did not finish. Try again shortly.',
        retryable: true,
        title: 'Generation did not finish',
      };
    case 'PLAN_INPUT_INVALID':
      return {
        hint: 'Check the goal for unusual characters, then try again.',
        message: 'That request cannot be turned into a plan.',
        retryable: false,
        title: 'The goal cannot be used',
      };
    case 'PLAN_AGENTS_UNAVAILABLE':
      return {
        hint: 'Pick a different agent or leave the agent unset.',
        message: 'An agent the plan needs is not available to you on this repository.',
        retryable: false,
        title: 'An agent is unavailable',
      };
    case 'PLAN_KEY_REUSED':
      return {
        hint: 'Start the generation again.',
        message: 'This submission was already used for a different plan.',
        retryable: true,
        title: 'Start again',
      };
    case 'PLAN_JOB_EXPIRED':
      return {
        message: 'That generation finished long ago. Start a new one.',
        retryable: true,
        title: 'Generation expired',
      };
    case 'PLANNED_RUN_TEMPLATE_MISSING':
      return {
        hint: 'Ask an administrator to run the database seed.',
        message: 'Generated plans are not set up on this deployment.',
        retryable: false,
        title: 'Plans are not set up',
      };
    case 'RUN_PLANS_DISABLED':
      return {
        hint: 'An administrator controls this in Platform settings.',
        message: 'Generating plans is turned off for this repository’s team or the platform.',
        retryable: false,
        title: 'Plans are turned off',
      };
    case 'RUN_PLAN_RATE_LIMITED':
      return {
        hint: 'Wait a while before generating or ranking again.',
        message: 'You have reached the hourly limit for plans.',
        retryable: false,
        title: 'Too many plans',
      };
    case 'RUN_PLAN_PENDING_LIMIT':
      return {
        hint: 'Approve or reject a pending plan under My plans first.',
        message: 'You already have the maximum number of pending plans.',
        retryable: false,
        title: 'Too many pending plans',
      };
    case 'RUN_PLAN_ROUTER_UNAVAILABLE':
      return {
        message: 'Templates could not be ranked right now. You can still generate a new plan.',
        retryable: true,
        title: 'Matching is unavailable',
      };
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return {
        message: 'This exact request is already being processed.',
        retryable: false,
        title: 'Already in progress',
      };
    case 'PLAN_NOT_FOUND':
      return {
        message: 'That plan does not exist or is not yours.',
        retryable: false,
        title: 'Plan not found',
      };
    case 'PLAN_EXPIRED':
      return {
        message: 'This plan expired before it was approved. Generate a new one.',
        retryable: false,
        title: 'Plan expired',
      };
    case 'PLAN_NOT_PENDING':
      return {
        message: 'This plan is no longer pending, so it cannot be approved or rejected.',
        retryable: false,
        title: 'Plan already decided',
      };
    case 'PLAN_LAUNCH_FAILED':
      return {
        message:
          'This approval started a run that did not succeed. Create a new plan to try again.',
        retryable: false,
        title: 'The run did not start',
      };
    case 'PLAN_LAUNCH_IN_PROGRESS':
      return {
        hint: 'Check My plans in a moment before trying again.',
        message: 'This approval is still starting its run.',
        retryable: true,
        title: 'The run is still starting',
      };
    case 'IDEMPOTENCY_KEY_MISMATCH':
      return {
        hint: 'Start the action again from the plan.',
        message: 'This approval key was already used for a different plan.',
        retryable: true,
        title: 'Approval key already used',
      };
    case 'PLAN_NOT_LAUNCHABLE':
      return {
        message: 'This plan cannot be launched. Generate a new one.',
        retryable: false,
        title: 'The plan cannot be launched',
      };
    case 'RUN_CONFLICT':
      return {
        message: 'A run for this plan already exists, so nothing new was started.',
        retryable: false,
        title: 'A run already exists',
      };
    case 'REPO_HOST_NOT_ALLOWED':
      return {
        hint: 'Ask an administrator to allow the repository’s host in Platform settings.',
        message: 'The repository’s host is not on the list of hosts this deployment may use.',
        retryable: false,
        title: 'Repository host not allowed',
      };
    case 'AGENT_RUNS_DISABLED':
      return {
        hint: 'An administrator controls this in Platform settings.',
        message: 'Agent runs are turned off, so a plan that runs a library agent cannot start.',
        retryable: false,
        title: 'Agent runs are turned off',
      };
    case 'PLAN_POLICY_FAILED':
      return {
        hint: 'Nothing was started. Generate the plan again from the same goal.',
        message: 'The plan no longer meets the platform’s rules for a plan.',
        retryable: false,
        title: 'The plan breaks the platform’s rules',
      };
    case 'PLAN_SPEC_INVALID':
      return {
        hint: 'Nothing was started. Generate the plan again from the same goal.',
        message: 'The stored plan is not a valid workflow.',
        retryable: false,
        title: 'The plan is not valid',
      };
    case 'PLAN_CATALOG_STALE':
      return driftView('catalog');
    case 'AGENT_RUN_CONCURRENCY_EXCEEDED':
      return {
        hint: 'Runs hold a workspace for their whole duration. Try again when one finishes.',
        message: 'Too many agent runs are in flight.',
        retryable: true,
        title: 'Too many runs in flight',
      };
    case 'ORG_BUDGET_EXCEEDED':
    case 'TEAM_BUDGET_EXCEEDED': {
      const scope = code === 'TEAM_BUDGET_EXCEEDED' ? 'team' : 'organization';
      return {
        hint: 'Ask a lead or administrator to raise the limit or review spend.',
        message: `This was refused because the ${scope} has reached its monthly budget.`,
        retryable: false,
        title: `The ${scope} budget is used up`,
      };
    }
    case 'PLAN_AGENTS_CHANGED':
    case 'PLAN_AGENT_NOT_LAUNCHABLE':
    case 'PLAN_CATALOG_CHANGED':
    case 'PLAN_REPOSITORY_CHANGED':
    case 'PLAN_SETTINGS_CHANGED':
    case 'PLAN_TAMPERED':
      return driftView(driftKind(err) ?? 'spec');
    default:
      break;
  }
  const drift = driftKind(err);
  if (status === 409 && drift) {
    return driftView(drift);
  }
  if (status === 429) {
    return {
      hint: 'Try again in a little while.',
      message: 'Too many requests, or the team is at its limit for concurrent runs.',
      retryable: true,
      title: 'Limit reached',
    };
  }
  if (status === 402) {
    return {
      hint: 'Ask an organization administrator to raise the limit or review spend.',
      message: 'This was refused because a monthly budget has been reached.',
      retryable: false,
      title: 'Monthly budget reached',
    };
  }
  if (status === 403) {
    return {
      hint: 'You need the Engineer role and access to the repository’s team.',
      message,
      retryable: false,
      title: 'Not allowed',
    };
  }
  if (status === 404) {
    return { message, retryable: false, title: 'Not found' };
  }
  return { message, retryable: true, title: 'The request failed' };
}

function driftView(kind: string): PlanErrorView {
  const what = DRIFT_LABEL[kind] ?? 'the platform';
  return {
    drift: kind,
    hint: 'Nothing was started. Regenerate the plan from the same goal to review it again.',
    message: `Something changed since this plan was made (${what}), so it can no longer be approved.`,
    retryable: false,
    title: 'This plan is out of date',
  };
}

/** Describe a failed generation job exactly as the job route reported it. */
export function describeJobFailure(job: {
  code: string;
  message: string;
  retryable: boolean;
}): PlanErrorView {
  const known = describePlanError(new ApiError(job.message, 0, job.code));
  // An unknown code keeps the gateway's fixed job message.
  return known.title === 'The request failed' ? { ...known, retryable: job.retryable } : known;
}

// ── Polling ─────────────────────────────────────────────────────────────────

/** Delay before poll number `attempt` (0-based): 1 s, growing 1.5x, capped at 8 s. */
export function pollDelayMs(attempt: number): number {
  return Math.min(8000, Math.round(1000 * 1.5 ** Math.max(0, attempt)));
}

/** After this long the screen says generation is slow; polling continues until it is stopped. */
export const SLOW_AFTER_MS = 120_000;

// ── Plan parsing ────────────────────────────────────────────────────────────

const REGION_ORDER = ['pre', 'plan', 'core', 'post'] as const;

export interface OutlineGroup {
  region: string;
  title: string;
  hint: string;
  nodes: (PlanNode & { title: string; action: string | null; reads: string | null })[];
}

const REGION_COPY: Record<string, { title: string; hint: string }> = {
  core: {
    hint: 'The shipped implement, review, pull request, CI and human merge process, identical in every delivering plan.',
    title: 'Implement and deliver',
  },
  plan: {
    hint: 'The steps the plan runs, ending with a human review of the output.',
    title: 'Plan steps',
  },
  post: { hint: 'Optional steps after the human merge.', title: 'After the merge' },
  pre: { hint: 'Steps that run before implementation starts.', title: 'Before implementation' },
};

function nodeTitle(spec: unknown, id: string): string {
  const nodes = isRecord(spec) && isRecord(spec.nodes) ? spec.nodes : {};
  const node = isRecord(nodes[id]) ? nodes[id] : {};
  for (const key of ['label', 'title', 'name']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return id;
}

/** Where an input is read from, in words. */
export function describeSource(from: string | null): string {
  if (from === null) {
    return 'a fixed value';
  }
  if (from === 'request.description') {
    return 'the goal';
  }
  const output = /^nodes\.([^.]+)\.output$/.exec(from);
  if (output) {
    return `the output of "${output[1]}"`;
  }
  return `\`${from}\``;
}

/** "runs agent X on the goal": what an agent node does and what it is given, or null. */
export function nodeAction(node: PlanNode): string | null {
  if (node.type !== 'agent' || !node.agentRef) {
    return null;
  }
  const sources = (node.inputs ?? []).map((i) => describeSource(i.from));
  return sources.length > 0
    ? `runs agent ${node.agentRef} on ${sources.join(' and ')}`
    : `runs agent ${node.agentRef}`;
}

/**
 * What a `step` node reads: each input's key and source, with "has fallback value" where the
 * binding carries a default (never the default itself). Null for other nodes or no inputs.
 */
export function nodeReads(node: PlanNode): string | null {
  if (node.type !== 'step' || !node.inputs || node.inputs.length === 0) {
    return null;
  }
  return `reads ${node.inputs
    .map(
      (i) => `${i.key} from ${describeSource(i.from)}${i.hasDefault ? ' (has fallback value)' : ''}`
    )
    .join(', ')}`;
}

/** The badge shown on a node whose output reaches the implementer. */
export const FEEDS_IMPLEMENTER_LABEL = 'Output becomes guidance for the implementer';

/** Nodes in spec order, grouped by region in run order. Titles are plain strings. */
export function outlineGroups(plan: Pick<RunPlanView, 'nodes' | 'spec'>): OutlineGroup[] {
  const known = new Set<string>(REGION_ORDER);
  const groups: OutlineGroup[] = [];
  for (const region of REGION_ORDER) {
    const nodes = plan.nodes
      .filter((n) => (known.has(n.region) ? n.region : 'plan') === region)
      .map((n) => ({
        ...n,
        action: nodeAction(n),
        reads: nodeReads(n),
        title: nodeTitle(plan.spec, n.id),
      }));
    if (nodes.length > 0) {
      groups.push({ ...(REGION_COPY[region] as { title: string; hint: string }), nodes, region });
    }
  }
  return groups;
}

export const MARKER_LABEL: Record<NodeMarker, string> = {
  core: 'Platform-enforced (cannot be changed)',
  free: 'Generated for this request',
  injected: 'Added by the platform',
  mandatory: 'Required by the platform',
};

/** Reads the stored cost estimate tolerantly: a missing field is absent, never a crash. */
export function parseCost(raw: unknown): PlanCost {
  if (!isRecord(raw)) {
    return { totalUsd: null, unpriced: [], unpricedCount: 0 };
  }
  const unpriced = Array.isArray(raw.unpriced)
    ? raw.unpriced.filter(isRecord).map((u) => ({
        nodeId: typeof u.nodeId === 'string' ? u.nodeId : '',
        reason: typeof u.reason === 'string' ? u.reason : '',
      }))
    : [];
  return {
    totalUsd:
      typeof raw.totalUsd === 'number' && Number.isFinite(raw.totalUsd) ? raw.totalUsd : null,
    unpriced,
    unpricedCount: unpriced.length,
  };
}

export function formatUsd(value: number | null): string {
  if (value === null) {
    return 'Not available';
  }
  return value > 0 && value < 0.01 ? '< $0.01' : `$${value.toFixed(2)}`;
}

/** One sentence that keeps a partial estimate from reading as a total. */
export function costNote(cost: PlanCost): string {
  const base = 'Retries and loops are counted once, so the real cost can be higher.';
  return cost.unpricedCount > 0
    ? `${cost.unpricedCount} ${cost.unpricedCount === 1 ? 'step is' : 'steps are'} unpriced and not included. ${base}`
    : base;
}

/** Pins as sorted `agent` / `scope:version` pairs, tolerating a missing or malformed record. */
export function parsePins(raw: unknown): { agent: string; pin: string }[] {
  if (!isRecord(raw)) {
    return [];
  }
  return Object.entries(raw)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([agent, pin]) => ({ agent, pin }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/** Whole minutes left before expiry, or 0 once past. */
export function minutesLeft(expiresAt: string, now: number): number {
  const ms = new Date(expiresAt).getTime() - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export function expiryLabel(expiresAt: string, now: number): string {
  const mins = minutesLeft(expiresAt, now);
  if (mins === 0) {
    return 'Expired';
  }
  if (mins < 60) {
    return `Expires in ${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  return `Expires in ${hours} h ${mins % 60} min`;
}

/** What approving does to the repository, in words, for the confirmation. */
export function deliveryEffect(mode: RunPlanMode): string {
  return mode === 'delivering'
    ? 'A branch is pushed and a draft pull request is opened for review. The platform never merges it; a person does.'
    : 'No pull request is opened. The run produces reviewed text or artifacts, and a person reviews them before it finishes.';
}

/** A route to open the existing workflow launch flow for a ranked template. */
export function workflowLaunchHref(templateId: string, repoId: string): string {
  return `/start?mode=workflow&template=${encodeURIComponent(templateId)}&repo=${encodeURIComponent(repoId)}`;
}
