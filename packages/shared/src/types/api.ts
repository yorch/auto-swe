import type { InputSchema } from '../lib/inputSchema.js';
import type { BudgetTier, WorkflowStatus } from './workflow.js';

export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

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
  _count: { memberships: number; repositories: number };
}

/** Shape returned by GET /api/v1/teams/:id (detail) */
export interface TeamDetail extends TeamSummary {
  memberships: TeamMember[];
  repositories: RepoRef[];
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

export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  slackChannel?: string;
}

export interface CreateWorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
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
  webhookToken: string | null;
  versionCount: number;
  inputSchema?: InputSchema | null;
  team: TeamRef | null;
  lastRun: {
    id: string;
    status: WorkflowRunStatus;
    startedAt: string;
    endedAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateVersionSummary {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
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
}

export interface UpdateWorkflowTemplateBody {
  name?: string;
  description?: string;
  isDefault?: boolean;
  status?: WorkflowTemplateStatus;
  experimentVersion?: number | null;
  experimentSplit?: number | null;
  inputSchema?: InputSchema | null;
}

export interface WorkflowTemplateAnalytics {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  totalCost: number;
  avgCostPerRun: number | null;
  perStepFailureRates: Array<{
    nodeId: string;
    failed: number;
    total: number;
    failureRate: number;
  }>;
  perVersionCounts: Array<{ version: number; count: number }>;
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
  succeeded: number;
  failed: number;
  successRate: number | null;
  totalCost: number;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    successRate: number | null;
    totalCost: number;
  }>;
}

export interface SpecDiffResponse {
  a: { version: number; spec: unknown };
  b: { version: number; spec: unknown };
  diff: {
    addedNodes: string[];
    removedNodes: string[];
    changedNodes: string[];
    unchangedNodes: string[];
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
  status: WorkflowRunStatus;
  startedAt: string;
  endedAt: string | null;
  workRequest: {
    id: string;
    externalTicketId: string;
    description: string;
  } | null;
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
  /** Temporal activity type, e.g. "executeImplementation". */
  nodeId: string;
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
}

/** Shape returned by GET /api/v1/workflow-runs/:id (detail) */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  specSnapshot: unknown;
  contextSnapshot: unknown;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
  templateName: string;
  humanSteps?: HumanStepSummary[];
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
  run: {
    id: string;
    status: string;
    workflowId: string;
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

/** Shape returned by GET /api/v1/admin/access-tokens (platform ADMIN only) */
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
  exists: boolean;
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
  repository: { id: string; organizationName: string; repoName: string };
  /** Explicit template override; null → repo team default at save time. */
  template: { id: string; name: string } | null;
  templateVersion: number | null;
  /** Standing WorkRequest that every fire's WorkflowRun links to. */
  workRequestId: string | null;
  createdBy: { id: string; email: string; name: string | null } | null;
  lastFiredAt: string | null;
  schedule: ScheduledWorkRequestScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Evaluations (P0: captured quality signals) ──

export const EVAL_SIGNAL_SOURCES = [
  'GATE',
  'ASSERT',
  'REVIEW',
  'MERGE',
  'JUDGE',
  'TRAJECTORY',
] as const;
export type EvalSignalSourceValue = (typeof EVAL_SIGNAL_SOURCES)[number];

export const EVAL_SCORE_TYPES = ['BOOLEAN', 'NUMERIC', 'CATEGORICAL'] as const;
export type EvalScoreTypeValue = (typeof EVAL_SCORE_TYPES)[number];

/** One captured eval signal (gate / review verdict / merge), normalized to 0..1. */
export interface EvalResultDto {
  id: string;
  runId: string | null;
  nodeId: string | null;
  agentKey: string | null;
  source: EvalSignalSourceValue;
  scorer: string;
  scoreType: EvalScoreTypeValue;
  value: number;
  passed: boolean | null;
  rationale: string | null;
  metadata: unknown;
  createdAt: string;
}

// ── Eval datasets / cases / runs (P1) ──

/// Scopes offered in the generic config-scope pickers (model config, agent
/// library, evals). The `scope` *column* (Prisma `ConfigScope`) additionally
/// allows `'CHANNEL'` (Claude Tag) — those rows are created from the Slack
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
  candidateRef: string;
  baselineRef: string;
  status: string;
  summary: unknown;
  startedAt: string;
  endedAt: string | null;
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
