import type { InputSchema } from '../lib/inputSchema.js';
import { isAnthropicSpec } from '../lib/modelSpec.js';
import type { PullRequestState } from '../lib/pullRequest.js';
import type { WorkspaceProviderType } from '../lib/workspaceProviders.js';
import type { BudgetTier, WorkflowStatus } from './workflow.js';

export type { BudgetTier } from './workflow.js';

export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

// ── User preferences ──

/** Run-detail page layouts, in the order the toggle renders them. */
export const RUN_DETAIL_LAYOUTS = ['A', 'B', 'C'] as const;
export type RunDetailLayout = (typeof RUN_DETAIL_LAYOUTS)[number];

// ── Shared reference shapes (minimal projections returned by includes) ──

export interface TeamRef {
  id: string;
  name: string;
  slug: string;
}

export interface RepoRef {
  id: string;
  organizationName: string;
  repoName: string;
  isActive: boolean;
}

// ── Workflows ──

export interface WorkflowRepository {
  id: string;
  organizationName: string;
  repoName: string;
  /** GitHub host base (e.g. https://github.com or a GHE URL); null = github.com */
  githubUrl?: string | null;
}

export interface PullRequestSummary {
  id: string;
  prNumber: number | null;
  status: string;
  ciStatus: string | null;
}

export interface WorkRequestSummary {
  title?: string;
  id: string;
  externalTicketId: string;
  description: string;
}

/** Shape returned by GET /api/v1/workflows (list) */
export interface WorkflowSummary {
  id: string;
  temporalWorkflowId: string;
  currentStatus: WorkflowStatus;
  assignedBranch: string;
  updatedAt: string;
  budgetTier: BudgetTier;
  tokensInputUsed: number;
  tokensOutputUsed: number;
  costUsdAccrued: number;
  repository: WorkflowRepository | null;
  pullRequests: PullRequestSummary[];
}

/** Shape returned by GET /api/v1/workflows/:id (detail — adds workRequest) */
export interface WorkflowDetail extends WorkflowSummary {
  workRequest: WorkRequestSummary | null;
}

// ── Teams ──

export interface TeamMember {
  id: string;
  role: string;
  user: { id: string; email: string; role: string };
}

/** Shape returned by GET /api/v1/teams (list) */
export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  defaultPersonaPrompt: string | null;
  _count: { memberships: number; repositories: number };
}

/** Shape returned by GET /api/v1/teams/:id (detail) */
export interface TeamDetail extends TeamSummary {
  memberships: TeamMember[];
  repositories: RepoRef[];
  /**
   * Repositories other teams have shared with this one: read-only on this
   * team's page. Active rows only, and only those the caller may see.
   */
  sharedRepositories: SharedRepoRef[];
}

/** A repository shared with a team, and the team that owns it. */
export interface SharedRepoRef extends RepoRef {
  team: { id: string; name: string; slug: string };
}

// ── Repositories ──

/** Shape returned by GET /api/v1/repositories */
export interface RepositorySummary {
  id: string;
  /** Connection type discriminator: 'git_repo' | 'api_endpoint' | 'generic' */
  type: string;
  /** Human label for non-git_repo connections; null for git_repo (use org/repo instead) */
  name: string | null;
  /** Type-specific config JSON (for non-git_repo connections) */
  config: unknown;
  organizationName: string | null;
  repoName: string | null;
  defaultBranch: string;
  isActive: boolean;
  consolidationEnabled: boolean;
  executorImage: string | null;
  language: string | null;
  description: string | null;
  team: TeamRef;
  /**
   * Further teams whose members may see and launch on this repository. The
   * owning `team` keeps management. Present on the repository listing.
   */
  shares?: Array<{ team: TeamRef }>;
  _count: { activeWorkflows: number };
}

// ── Users ──

export interface UserMembership {
  id: string;
  role: string;
  team: TeamRef;
}

/** Shape returned by GET /api/v1/users */
export interface UserSummary {
  id: string;
  email: string;
  role: string;
  slackId: string | null;
  isActive: boolean;
  createdAt: string;
  memberships: UserMembership[];
}

// ── Lessons ──

export interface LessonRepository {
  id: string;
  organizationName: string;
  repoName: string;
}

/** Shape returned by GET /api/v1/lessons */
export interface LessonListItem {
  id: string;
  lessonSummary: string;
  rationale: string;
  failureType: string | null;
  metadata: unknown;
  createdAt: string;
  repository: LessonRepository;
}

// ── Auth ──

export interface LoginBody {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshBody {
  refreshToken: string;
}

// ── Work Requests ──

/** Body of POST /api/v1/work-requests — mirrors the gateway's `CreateWorkRequestSchema`. */
export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;
  /** Exactly one connection id today (single-repo work requests). */
  repoIds: string[];
  /** Defaults to STANDARD when omitted. */
  budgetTier?: BudgetTier;
}

export interface CreateWorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
}

/**
 * `POST /work-requests/:id/retry`. The run row is created by the worker once
 * the workflow begins, not by the gateway, so the response names the Temporal
 * workflow id (`WorkflowRunSummary.workflowId`) to look the new run up by.
 */
export interface RetryWorkRequestResponse extends CreateWorkRequestResponse {
  temporalWorkflowId: string;
}

// ── Agent runs ──

/** One launchable library agent, as `GET /api/v1/agent-runs/agents` offers it. */
export interface AgentRunAgent {
  key: string;
  name: string;
  description: string | null;
  /** The scope an unpinned launch resolves at: an org override wins over GLOBAL. */
  scope: 'GLOBAL' | 'ORGANIZATION';
  /** Latest active version at `scope`. */
  version: number;
  /** GLOBAL versions a `key@version` pin can select; empty while an org override shadows the key. */
  pinnableVersions: number[];
}

/** `GET /api/v1/agent-runs/limits`: ceilings, hard bounds and the kill switch. */
export interface AgentRunLimits {
  enabled: boolean;
  concurrency: { global: number; perTeam: number };
  maxSteps: { ceiling: number; min: number; max: number };
  maxWallClockSeconds: { ceiling: number; min: number; max: number };
}

/** `POST /api/v1/agent-runs` and its `/rerun` answer. */
export interface AgentRunLaunchResponse {
  workRequestId: string;
  temporalWorkflowId: string;
  workflowId: string;
  effective: {
    deliver: 'none' | 'branch' | 'draft_pr';
    maxSteps: number;
    maxWallClockSeconds: number;
  };
}

// ── Epics (Phase 3) ──

export interface CreateEpicBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  dependencyGraph: { repoId: string; dependsOn: string[] }[];
}

export interface CreateEpicResponse {
  epicWorkflowId: string;
  childWorkflowIds: Record<string, string>;
}

// ── Workflow Templates / Runs (Phase 4) ──

export const WORKFLOW_TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type WorkflowTemplateStatus = (typeof WORKFLOW_TEMPLATE_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = [
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'SKIPPED',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/**
 * `WorkflowRun` statuses a run never leaves: every status except `RUNNING`.
 * `SKIPPED` is terminal — a run that decided there was nothing to do is over,
 * it is not "still running". The one definition every consumer (dashboard,
 * gateway, CLI, analytics) should read instead of spelling its own set.
 */
export const WORKFLOW_RUN_TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(
  WORKFLOW_RUN_STATUSES.filter((s) => s !== 'RUNNING')
);

/**
 * Terminal `WorkflowRun` statuses that count as a failure. `SKIPPED` is
 * terminal but neither a success nor a failure.
 */
export const WORKFLOW_RUN_FAILURE_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
]);

export function isTerminalWorkflowRunStatus(status: string): boolean {
  return WORKFLOW_RUN_TERMINAL_STATUSES.has(status as WorkflowRunStatus);
}

/**
 * `ActiveWorkflow.currentStatus` values that mean "this execution is over" —
 * the ledger row's vocabulary (`COMPLETED`), not the run's (`SUCCESS`).
 */
export const ACTIVE_WORKFLOW_TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
]);

export function isTerminalActiveWorkflowStatus(status: string): boolean {
  return ACTIVE_WORKFLOW_TERMINAL_STATUSES.has(status as WorkflowStatus);
}

export const WORKFLOW_STEP_RECORD_STATUSES = [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'SKIPPED',
] as const;
export type WorkflowStepRecordStatus = (typeof WORKFLOW_STEP_RECORD_STATUSES)[number];

/** Shape returned by GET /api/v1/workflow-templates (list) */
export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  description: string;
  status: WorkflowTemplateStatus;
  isDefault: boolean;
  activeVersion: number | null;
  experimentVersion: number | null;
  experimentSplit: number | null;
  /** Whether an unauthenticated webhook trigger token exists. The token itself
   *  is only returned by POST /workflow-templates/:id/webhook/regenerate. */
  webhookConfigured: boolean;
  versionCount: number;
  inputSchema?: InputSchema | null;
  workspaceProvider?: WorkspaceProviderType | null;
  estimatedHumanTimeSavedMinutes?: number | null;
  team: TeamRef | null;
  lastRun: {
    id: string;
    status: WorkflowRunStatus;
    startedAt: string;
    endedAt: string | null;
    /** The request the run belongs to; open it first, diagnostics second. */
    workRequestId: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateVersionSummary {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
  generatedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface WorkflowTemplateVersionDetail extends WorkflowTemplateVersionSummary {
  spec: unknown;
}

/** Shape returned by GET /api/v1/workflow-templates/:id (detail) */
export interface WorkflowTemplateDetail extends WorkflowTemplateSummary {
  versions: WorkflowTemplateVersionSummary[];
  activeVersionSpec: WorkflowTemplateVersionDetail | null;
}

export interface CreateWorkflowTemplateBody {
  name: string;
  description?: string;
  teamId?: string | null;
  spec: unknown;
  workspaceProvider?: WorkspaceProviderType | null;
}

export interface UpdateWorkflowTemplateBody {
  name?: string;
  description?: string;
  isDefault?: boolean;
  status?: WorkflowTemplateStatus;
  experimentVersion?: number | null;
  experimentSplit?: number | null;
  inputSchema?: InputSchema | null;
  workspaceProvider?: WorkspaceProviderType | null;
  estimatedHumanTimeSavedMinutes?: number | null;
}

export interface WorkflowTemplateAnalytics {
  isTruncated: boolean;
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  totalCost: number;
  avgCostPerRun: number | null;
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  agentErrorRate: number | null;
  perStepFailureRates: Array<{
    nodeId: string;
    failed: number;
    total: number;
    failureRate: number;
  }>;
  perVersionCounts: Array<{ version: number; count: number }>;
  perOutcome: Array<{ outcomeType: string; runCount: number; totalCost: number }>;
  significanceHint: {
    versionA: number;
    versionB: number;
    nA: number;
    nB: number;
    successRateA: number;
    successRateB: number;
    zScore: number;
    pValue: number;
    isSignificant: boolean;
  } | null;
}

/** Phase-8 cross-template rollup returned by GET /workflow-templates/analytics. */
export interface GlobalAnalyticsResponse {
  windowDays: number;
  totalRuns: number;
  completedRuns: number;
  runningRuns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalCost: number;
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    successRate: number | null;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
  }>;
  perDomain: Array<{
    domain: string;
    totalRuns: number;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
    agentErrorRate: number | null;
    humanErrorRate: number | null;
    errorRateVsHuman: number | null;
    baselineSampleSize: number | null;
  }>;
  perOutcome: Array<{ outcomeType: string; runCount: number; totalCost: number }>;
  isTruncated: boolean;
  /** Headline figures for the window of equal length just before this one; null when unavailable. */
  previous?: {
    totalRuns: number;
    successRate: number | null;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
    autonomyRate: number | null;
    humanReviewRate: number | null;
  } | null;
  /** Runs started per UTC day in the window, oldest first. */
  daily?: Array<{ date: string; completed: number; failed: number; active: number }>;
}

export interface SpecDiffResponse {
  a: { version: number; spec: unknown };
  b: { version: number; spec: unknown };
  diff: {
    addedNodes: string[];
    removedNodes: string[];
    changedNodes: string[];
    unchangedNodes: string[];
    /** Nodes whose only difference is group/title. Optional: an older gateway omits it. */
    presentationOnlyNodes?: string[];
    metaChanges: Array<{ field: string; before: unknown; after: unknown }>;
  };
}

export interface CreateWorkflowVersionBody {
  spec: unknown;
}

export interface PromoteVersionBody {
  version: number;
}

/** Shape returned by GET /api/v1/workflow-runs (list) and template runs */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  templateId: string;
  templateName?: string | null;
  templateVersion: number;
  domain: string | null;
  status: WorkflowRunStatus;
  startedAt: string;
  endedAt: string | null;
  outcomeDomain: string | null;
  outcomeType: string | null;
  costUsdAccrued: number;
  workRequest: {
    title?: string;
    id: string;
    externalTicketId: string;
    description: string;
  } | null;
}

/** One request, represented by its latest visible execution attempt. */
export interface WorkspaceRequestSummary extends WorkflowRunSummary {
  failedExecutionCount: number;
  attemptCount: number;
  isCrossRepo: boolean;
  visibleExecutionCount: number;
  pendingStepCount: number;
  /** Soonest deadline among steps waiting on a person; null when none has one. */
  pendingStepDeadline?: string | null;
  /** The pull request is open and waiting for a human to review and merge it. */
  needsMerge?: boolean;
  stage: string | null;
  reviewUrl: string | null;
  target: string | null;
}

export interface WorkflowStepRecord {
  id: string;
  nodeId: string;
  attempt: number;
  status: WorkflowStepRecordStatus;
  startedAt: string | null;
  endedAt: string | null;
  inputs: unknown;
  outputs: unknown;
  error: string | null;
}

/** One captured tool call, LLM response, or activity event from an agent activity. */
export interface AgentTraceRecord {
  id: string;
  /** Temporal activity type, e.g. "executeImplementation". Not a workflow node id. */
  nodeId: string;
  /** Workflow-spec node (key in `spec.nodes`) the activity ran for; null on older rows. */
  specNodeId: string | null;
  /**
   * The interpreter's id for that execution: the spec key, branch-prefixed inside a
   * fan-out (`fan[0]/impl`). Equals `WorkflowStepRecord.nodeId`. Null on older rows.
   */
  recordingId: string | null;
  /** Interpreter attempt at the node (`onFail.retry` re-dispatches); null on older rows. */
  stepAttempt: number | null;
  agentKey: string;
  /** Temporal activity attempt number (1-based); separates retry attempts. */
  attempt: number;
  seq: number;
  /** "tool_call" | "llm_response" | "activity_event" */
  type: string;
  toolName: string | null;
  inputJson: unknown;
  outputJson: unknown;
  durationMs: number | null;
  error: string | null;
  /** `<provider>/<model>` spec — present on llm_response records. */
  model: string | null;
  /** Input token count — present on llm_response records. */
  inputTokens: number | null;
  /** Output token count — present on llm_response records. */
  outputTokens: number | null;
  /** USD cost — present on llm_response records. */
  costUsd: number | null;
  /** W3C trace-id correlating this record to a Grafana/Tempo span. */
  otelTraceId: string | null;
  /** W3C span-id correlating this record to a Grafana/Tempo span. */
  otelSpanId: string | null;
  createdAt: string;
  /** True when the server cut a payload string; refetch with `?fullTraces=true` for all of it. */
  trimmed: boolean;
}

/** Shape returned by GET /api/v1/workflow-runs/:id (detail) */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  /** Denormalized USD spend for this run, populated by `finalizeWorkflowRun`.
   *  Detail-only — the list projection does not carry it. */
  costUsdAccrued: number;
  /** Denormalized token totals for this run, populated by `finalizeWorkflowRun`. */
  tokensInputTotal: number;
  tokensOutputTotal: number;
  specSnapshot: unknown;
  contextSnapshot: unknown;
  /** Parsed terminate-node result surfaced from `contextSnapshot.result`. */
  result: unknown;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
  templateName: string;
  /** A run of the hidden Agent Run system template (keyed on its origin, not its name). */
  isAgentRun?: boolean;
  /**
   * The `workspace.implementerRuntime` value pinned at run start (`mastra` or
   * `claude-code`); null when the run's pinned settings do not carry it.
   */
  implementerRuntime?: string | null;
  /**
   * The runtime the run pinned for each agent that has its own
   * (`{ agentKey: 'mastra' | 'claude-code' }`): at run start, or the first time
   * the run resolved an agent created later. An agent's own runtime wins over
   * `implementerRuntime`. Agents with no runtime of their own are not listed:
   * they run on `implementerRuntime` (or Mastra, for an agent run).
   */
  agentRuntimes?: Record<string, string>;
  humanSteps?: HumanStepSummary[];
}

/** One recorded answer on a human step, with the answerer's optional note. */
export interface HumanStepResponse {
  action: string;
  byName: string | null;
  comment: string | null;
  resolvedAt: string | null;
  /** A submitted review's text or a chosen decision option; null for other kinds. */
  value?: string | null;
}

/** Shape of a pending human action (humanApproval/Decision/Input/Review node). */
export interface HumanStepSummary {
  id: string;
  runId: string;
  nodeId: string;
  kind: 'APPROVAL' | 'DECISION' | 'INPUT' | 'REVIEW';
  title: string;
  description?: string | null;
  status: 'PENDING' | 'RESOLVED' | 'TIMED_OUT' | 'CANCELLED';
  context?: unknown;
  options?: unknown;
  fields?: unknown;
  requestedAt: string;
  resolvedAt?: string | null;
  timeoutAt?: string | null;
  /** Current number of distinct recorded approvers (APPROVAL steps). */
  currentApprovers?: number;
  /** Total number of distinct approvers required to resolve the step. */
  requiredApprovers?: number;
  /** How many more distinct approvals are still needed. */
  approvalsRemaining?: number;
  /** What the current user already answered on this step, or null. */
  myResponse?: string | null;
  /** Every recorded answer with its optional comment, oldest first. */
  responses?: HumanStepResponse[];
  run: {
    id: string;
    status: string;
    workflowId: string;
    /** The request this run belongs to; the request panel is the first place a run opens. */
    workRequestId?: string | null;
    workRequest?: { externalTicketId: string; description: string } | null;
  };
}

/** Step palette catalog returned by GET /api/v1/workflow-steps/registry */
export interface StepRegistryEntry {
  name: string;
  category: 'agent' | 'gate' | 'control' | 'vcs' | 'shell';
  label: string;
  description: string;
  configFields: ReadonlyArray<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
    enumValues?: readonly string[];
    required?: boolean;
    default?: unknown;
    description?: string;
  }>;
  costHint?: {
    role?: string;
    tokensIn?: number;
    tokensOut?: number;
  };
}

// ── Admin ──

/** Shape returned by GET /api/v1/platform/access-tokens (platform ADMIN only) */
export interface AdminTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  user: { id: string; email: string };
}

// ── Webhooks ──

export interface GitWebhookBody {
  action: string;
  pull_request?: {
    number: number;
    merged: boolean;
    head: { sha: string; ref: string };
    base: { repo: { full_name: string } };
  };
  repository: { full_name: string };
}

export interface CIWebhookBody {
  action: string;
  check_run?: {
    head_sha: string;
    conclusion: string;
    html_url: string;
  };
  repository: { full_name: string };
}

// ── Epics ──

/** One repo's child workflow inside an epic (GET /api/v1/epics/:workflowId). */
export interface EpicChildSummary {
  /** ActiveWorkflow DB UUID — null until the child self-registers its row. */
  workflowId: string | null;
  /** Temporal workflow ID (`<epicWorkflowId>-<repoId>`) — null while PENDING. */
  temporalWorkflowId: string | null;
  repoId: string | null;
  repoName: string | null;
  organizationName: string | null;
  /** ActiveWorkflow.currentStatus, or PENDING when no child row exists yet. */
  status: string;
  /** assignedBranch — always null for self-registered child rows today. */
  branch: string | null;
}

/** Shape returned by GET /api/v1/epics (list items). */
export interface EpicSummary {
  epicWorkflowId: string;
  externalTicketId: string;
  description: string;
  /** Epic ActiveWorkflow.currentStatus, or STARTING before its first state update. */
  status: string;
  repoCount: number;
  workRequestId: string;
  createdAt: string;
  updatedAt: string | null;
  requestedBy: { id: string; email: string; name: string | null } | null;
}

/** Shape returned by GET /api/v1/epics/:workflowId. */
export interface EpicDetail {
  epicWorkflowId: string;
  externalTicketId: string;
  description: string;
  status: string;
  workRequestId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  requestedBy: { id: string; email: string; name: string | null } | null;
  children: EpicChildSummary[];
}

/** Shape returned by POST /api/v1/epics. */
export interface CreateEpicResponse {
  epicWorkflowId: string;
  externalTicketId: string;
  workRequestId: string;
  /** Dashboard path of the epic detail page (PROD-3). */
  detailPath: string;
}

// ── Scheduled work requests ──

/** Live Temporal Schedule status for a scheduled work request. */
export interface ScheduledWorkRequestScheduleStatus {
  /** `null` when the scheduler could not be asked (`unavailable`): not the same as "no schedule". */
  exists: boolean | null;
  /** True when Temporal was not connected, so the live fields below are unknown. */
  unavailable?: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** Shape returned by GET/POST/PATCH /api/v1/scheduled-work-requests. */
export interface ScheduledWorkRequestSummary {
  id: string;
  name: string;
  cronExpression: string;
  description: string;
  externalTicketPrefix: string;
  /** Synthetic ticket ID all fires run under (`<PREFIX>-SCHED-<id8>`). */
  externalTicketId: string;
  budgetTier: string;
  isActive: boolean;
  /** Whether the caller may edit, fire, pause or delete this schedule. */
  canManage: boolean;
  repository: { id: string; organizationName: string; repoName: string };
  /** Explicit template override; null → repo team default at save time. */
  template: { id: string; name: string } | null;
  templateVersion: number | null;
  /** Standing WorkRequest that every fire's WorkflowRun links to. */
  workRequestId: string | null;
  createdBy: { id: string; email: string; name: string | null } | null;
  /**
   * Who every fire launches as — the last person to define what the schedule
   * does. Their own saved GitHub token may be used; null means the platform
   * credential only.
   */
  actsAs: { id: string; email: string; name: string | null } | null;
  /** The team that owns the schedule; null means its team was deleted. */
  team: TeamRef | null;
  lastFiredAt: string | null;
  schedule: ScheduledWorkRequestScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Evaluations (P0: captured quality signals) ──

/**
 * The loops that can drive an agent in a workspace — the values of the
 * run-pinned `workspace.implementerRuntime` setting, an Agent version's own
 * `runtime` (and its CHECK constraint), and an eval run's per-side override.
 */
export const IMPLEMENTER_RUNTIMES = ['mastra', 'claude-code'] as const;
export type ImplementerRuntimeKind = (typeof IMPLEMENTER_RUNTIMES)[number];

/** Narrows a stored runtime string (an untyped TEXT column) to a known runtime, else null. */
export function toImplementerRuntime(value: unknown): ImplementerRuntimeKind | null {
  return (IMPLEMENTER_RUNTIMES as readonly unknown[]).includes(value)
    ? (value as ImplementerRuntimeKind)
    : null;
}

/**
 * Why an Agent version cannot carry this runtime, or null. The `claude-code`
 * harness speaks only the Anthropic Messages API, so a version that names its
 * own non-Anthropic model cannot ask for it. A version that inherits its model
 * is checked when a run resolves it (`HARNESS_UNSUPPORTED_MODEL`), since the
 * parent can change independently. One rule for the agent-library API, bundle
 * install and the SDK's bundle validation.
 */
export function runtimeModelError(
  runtime: string | null | undefined,
  modelSpec: string | null | undefined
): string | null {
  if (runtime !== 'claude-code' || !modelSpec || isAnthropicSpec(modelSpec)) {
    return null;
  }
  return `The claude-code runtime needs an Anthropic model, but this agent's model is '${modelSpec}'. Set the model to anthropic/<model>, or the runtime to mastra.`;
}

export const EVAL_SIGNAL_SOURCES = [
  'GATE',
  'ASSERT',
  'REVIEW',
  'MERGE',
  'JUDGE',
  'TRAJECTORY',
  'POLICY',
  'PII',
  'HUMAN_AUDIT',
] as const;
export type EvalSignalSourceValue = (typeof EVAL_SIGNAL_SOURCES)[number];

export const EVAL_SCORE_TYPES = ['BOOLEAN', 'NUMERIC', 'CATEGORICAL'] as const;
export type EvalScoreTypeValue = (typeof EVAL_SCORE_TYPES)[number];

/** One captured eval signal (gate / review verdict / merge), normalized to 0..1. */
export interface EvalResultDto {
  id: string;
  runId: string | null;
  /** The offline harness run that produced the row; null for online signals. */
  evalRunId: string | null;
  /** The dataset case an offline row scored; null for online signals. */
  caseId: string | null;
  nodeId: string | null;
  agentKey: string | null;
  source: EvalSignalSourceValue;
  scorer: string;
  scoreType: EvalScoreTypeValue;
  value: number;
  passed: boolean | null;
  rationale: string | null;
  /**
   * The implementer runtime that produced the scored output, for offline harness
   * rows (the candidate arm's); null for online signals.
   */
  runtime: ImplementerRuntimeKind | null;
  metadata: unknown;
  createdAt: string;
}

/** Audit trail of autonomous governance decisions and human approvals for a run. */
export interface AutonomyDecisionDto {
  id: string;
  runId: string;
  actorId: string | null;
  event: string;
  policyName: string | null;
  riskClass: string | null;
  requiredApprovers: number | null;
  payload: unknown;
  createdAt: string;
}

// ── Eval datasets / cases / runs (P1) ──

/// Scopes offered in the generic config-scope pickers (model config, agent
/// library, evals). The `scope` *column* (Prisma `ConfigScope`) additionally
/// allows `'CHANNEL'` (channel assistant) — those rows are created from the Slack
/// channel admin surface, not these dropdowns, so CHANNEL is part of the type
/// union below but intentionally absent from this runtime picker list.
export const CONFIG_SCOPES = ['GLOBAL', 'ORGANIZATION', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;
export type ConfigScopeValue = (typeof CONFIG_SCOPES)[number] | 'CHANNEL';

export interface EvalCaseDto {
  id: string;
  datasetId: string;
  input: unknown;
  repoUrl: string;
  baselineSha: string;
  goldenTest: string;
  reference: unknown;
  tags: string[];
  flakeScreened: boolean;
  flakeRuns: number;
  createdAt: string;
}

export interface EvalDatasetSummary {
  id: string;
  slug: string;
  scope: ConfigScopeValue;
  name: string;
  description: string | null;
  caseCount: number;
  createdAt: string;
}

export interface EvalDatasetDetail extends EvalDatasetSummary {
  cases: EvalCaseDto[];
}

export interface EvalRunDto {
  id: string;
  datasetId: string;
  /** The benchmark's name and slug. */
  datasetName?: string;
  datasetSlug?: string;
  candidateRef: string;
  baselineRef: string;
  /**
   * The implementer runtime each side was asked to run on; null means the side
   * runs on what its agent resolves to in the dataset's scope (the Agent's own
   * `runtime`, else `workspace.implementerRuntime`). The runtime each case actually used is on its `EvalResultDto.runtime`
   * (candidate) and `metadata.baselineRuntime`, and summarised in `summary.runtimes`.
   */
  candidateRuntime: ImplementerRuntimeKind | null;
  baselineRuntime: ImplementerRuntimeKind | null;
  status: string;
  /**
   * The runless budget stopped the run before every case ran, so a SUCCESS or
   * REGRESSION covers only the cases that did. Derived from `summary.partial`.
   */
  partial: boolean;
  summary: unknown;
  startedAt: string;
  endedAt: string | null;
}

/** One scorer's daily mean over a trend window (GET /platform/evals/trends). */
export interface EvalScorerTrend {
  scorer: string;
  /** Present when the request set `by`: the column's value for this series; null = rows without one. */
  breakdown?: string | null;
  /** Signals in the whole window. */
  n: number;
  /** Mean normalized score over the whole window. */
  mean: number;
  /** One entry per bucket (`bucketDays` long), oldest first; `mean` is null when it has no signal. */
  daily: Array<{ date: string; n: number; mean: number | null }>;
}

export interface EvalTrendsDto {
  /** The dimension each scorer's series is split by, when the request set one. */
  by?: 'judgeModel' | 'agentKey' | 'runtime';
  /** Days each `daily` entry covers: 1, or 7 for a range over 90 days. */
  bucketDays: 1 | 7;
  windowDays: number;
  since: string;
  until: string;
  scorers: EvalScorerTrend[];
}

/** GET /platform/evals/suite-health: what the stored data says about each benchmark's health. */
export interface EvalSuiteHealthDto {
  datasets: Array<{
    datasetId: string;
    slug: string;
    name: string;
    cases: number;
    /** Cases quarantined by re-validation: their reference stopped passing. */
    quarantined: number;
    flakeScreened: number;
    /** `quarantined / cases`, 0 for an empty dataset. */
    staleRate: number;
  }>;
  /** The Tier-2 gate thresholds. Only the stale rate has a stored measurement. */
  thresholds: { maxFlakeRate: number; maxStaleRate: number; minKappa: number };
}

export interface EvalRubricDto {
  id: string;
  slug: string;
  scope: ConfigScopeValue;
  version: number;
  promptText: string;
  scale: string;
  isBuiltIn: boolean;
  createdAt: string;
}

// ── Pull requests and tickets ──

/** A run as the pull-request and ticket views name it. */
export interface WorkItemRunRef {
  id: string;
  status: WorkflowRunStatus;
}

/** One row of GET /api/v1/pull-requests. `title` is host text: render it as plain text. */
export interface PullRequestListItem {
  id: string;
  /** Null for a row whose repository was removed; only an ADMIN can see one. */
  repository: { id: string; org: string; name: string } | null;
  prNumber: number | null;
  /** The PR on its host; null when it cannot be derived. */
  url: string | null;
  title: string | null;
  status: PullRequestState;
  isDraft: boolean;
  ciStatus: string;
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  ticketId: string | null;
  workRequestId: string | null;
  /** Null when the caller may not see the run. */
  latestRun: WorkItemRunRef | null;
  costUsd: number | null;
}

/** A PR as a ticket group lists it. */
export interface TicketPullRequest {
  id: string;
  repository: { id: string; org: string; name: string } | null;
  prNumber: number | null;
  url: string | null;
  status: PullRequestState;
  isDraft: boolean;
}

/**
 * One row of GET /api/v1/tickets: everything filed under one external ticket id
 * that the caller may see. `title`, `status` and `url` are the tracker's answer
 * when the newest visible request was submitted (untrusted: render as plain
 * text); `url` is set only for an http(s) address.
 */
export interface TicketGroup {
  ticketId: string;
  title: string | null;
  status: string | null;
  url: string | null;
  requestCount: number;
  /** Visible runs by status. */
  runCounts: Partial<Record<WorkflowRunStatus, number>>;
  latestRun: WorkItemRunRef | null;
  /** The newest visible request, where the group's requests and runs are reached. */
  latestWorkRequestId: string;
  pullRequests: TicketPullRequest[];
  costUsd: number;
  lastActivityAt: string;
}
