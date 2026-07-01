// ── Workflow Types ──

/// Channel assistant (Phase 0): input to the per-mention channel-assistant workflow.
/// Temporal workflow name `'ChannelAssistantWorkflow'`, task queue
/// `'engineering-workflow'`. Produced by the gateway Slack Events route when a
/// user @mentions the bot (or DMs it); consumed by the worker, which resolves
/// the channel's assistant Agent (CHANNEL config tier), generates a reply, and
/// posts it back into the originating thread. Shared so the gateway's Temporal
/// decorator and the worker workflow agree on the shape without a code import.
export interface ChannelAssistantTurnInput {
  /// SlackChannel.id (our row) — drives the CHANNEL config tier + memory scope.
  channelId: string;
  /// Slack channel id (`C…`) the reply is posted into.
  slackChannelId: string;
  /// Thread to reply in: the mention's `ts`, or its `thread_ts` when the
  /// mention is already inside a thread.
  threadTs: string;
  /// The user's message with the bot @mention stripped.
  userText: string;
  /// Slack user id (`U…`) who sent the message (attribution + multiplayer).
  userSlackId: string;
  /// Owning team + org for the resolver cascade + per-channel budget.
  teamId: string;
  orgId: string;
  /// Gap H intent gate: true when this turn is a re-mention-free *continuation*
  /// of a live follow-up session (a plain thread reply), rather than a direct
  /// `@mention`/DM. The turn then runs SKIP-aware — the agent is told to reply
  /// `SKIP` when the latest message isn't actually addressed to it (e.g.
  /// teammates talking among themselves), and the workflow suppresses that reply
  /// so the assistant doesn't inject itself into human-to-human conversation.
  followup?: boolean;
}

export interface RepoWorkRequest {
  workRequestId: string;
  repoId: string;
  externalTicketId: string;
  description: string;
  requestPayload: string;
  budgetTier?: BudgetTier;
  // Phase 2+ fields
  contextSnapshotId?: string;
  planOverride?: string;
  // Phase 3+ fields
  slackChannel?: string;
  parentWorkflowId?: string;
  /// Channel assistant (Phase A): SlackChannel.id (our row) the run originated
  /// from. When set, the run's `agent` nodes resolve the CHANNEL config tier
  /// (per-channel tools/MCP/model) and the run's cost accrues to that channel's
  /// monthly budget. Only set for channel-launched task runs.
  channelId?: string;
}

export interface CodeSecurityFinding {
  file: string;
  label: string;
  line: number;
  match: string;
}

export interface CodeResult {
  branch: string;
  /**
   * Repository the code was written against. Populated by the implementer
   * activities so downstream fix activities can resolve the repo directly
   * instead of guessing from the (non-unique) branch name. Optional for
   * backwards compatibility with context snapshots persisted before it existed.
   */
  repoId?: string;
  codeSecurityFindings?: CodeSecurityFinding[];
  diff: string;
  filesChanged: FileChange[];
  headSha: string;
  implementationNotes: string;
  testResults: TestRunResult;
}

export interface FileChange {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface TestRunResult {
  passed: boolean;
  total: number;
  passing: number;
  failing: number;
  stdout: string; // Truncated to 10KB
  duration_ms: number;
}

// ── Review Network Types (Phase 2) ──

export interface ReviewVerdict {
  reviewer: 'SECURITY' | 'DOMAIN_LOGIC' | 'PERFORMANCE';
  approved: boolean;
  severity: 'PASS' | 'INFO' | 'WARNING' | 'CRITICAL';
  findings: ReviewFinding[];
}

export interface ReviewFinding {
  file: string;
  line?: number;
  category: string;
  description: string;
  suggestedFix: string;
}

export interface AggregatedReviewResult {
  approved: boolean;
  verdicts: ReviewVerdict[];
  codeResult: CodeResult;
  rejectionSummary?: string;
}

// ── Semantic Memory Types (Phase 2) ──

export interface LessonSummary {
  lessonId: string;
  summary: string;
  failureType: string | null;
  similarity: number;
}

export type FailureType =
  | 'CI_FAILURE'
  | 'REVIEW_REJECTION'
  | 'SECURITY_VIOLATION'
  | 'MERGE_CONFLICT';

// ── Workflow Result ──

export interface WorkflowResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED';
  prNumber?: number;
  prUrl?: string;
  totalCIRetries?: number;
  totalReviewRetries?: number;
  lessonsGenerated?: string[];
  /**
   * Populated when status === 'SKIPPED'. Free-form reason the workflow was
   * skipped — typically references the upstream repo that failed
   * ("upstream <repoId> failed") or names the unsatisfied dependencies
   * ("upstream dependency unsatisfied: <deps>") for repos blocked by a chain
   * of failures.
   */
  skippedReason?: string;
}

export type WorkflowStatus =
  | 'VALIDATING_CONTEXT'
  | 'IMPLEMENTING'
  | 'IN_REVIEW'
  | 'AWAITING_CI'
  | 'AWAITING_HUMAN_MERGE'
  | 'PLANNING'
  | 'FANNING_OUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

// ── Epic Orchestrator Types (Phase 3) ──

export interface EpicRequest {
  epicWorkflowId: string;
  externalTicketId: string;
  description: string;
  requestPayload: string;
  workRequestId: string;
  repos: EpicRepoEntry[];
  /** Candidate repo IDs for planner to consider (used when repos[] is empty) */
  repoIds?: string[];
}

export interface EpicRepoEntry {
  repoId: string;
  dependsOn: string[]; // repoIds that must complete before this one starts
}

export interface EpicResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  childResults: Record<string, WorkflowResult>;
}

// ── Epic Planning Types (Phase 3) ──

export interface EpicPlanRequest {
  description: string;
  requestPayload: string;
  repoIds: string[];
  workRequestId: string;
}

export interface RepoInfo {
  repoId: string;
  name: string;
  language: string;
  description: string;
}

export interface PlannedRepo {
  repoId: string;
  description: string;
  dependsOn: string[];
}

// ── Decomposition (Phase 3 — configurable workflows fan-out) ──

/**
 * A feature-level subtask produced by `planDecomposition`. Each subtask is
 * implemented in its own workspace + branch (`<BRANCH_PREFIX>/<ticket>/<id>`)
 * and the resulting branches are merged into the work-request branch before
 * the final PR is opened.
 */
export interface Subtask {
  /**
   * Stable slug used in branch names. Lowercase, kebab-case, max 40 chars.
   * The decomposer is prompted to generate this; the activity validates it.
   */
  id: string;
  title: string;
  description: string;
  /** Optional file-scope hints (relative paths or globs) for the implementer. */
  files?: string[];
}

export interface DecompositionResult {
  subtasks: Subtask[];
  /** Free-form rationale from the decomposer (truncated, stored in WorkflowStep.outputs). */
  rationale?: string;
}

// ── Budget Tiers (Cost Tracking) ──

export const BUDGET_TIERS = ['STANDARD', 'LARGE', 'EPIC'] as const;
export type BudgetTier = (typeof BUDGET_TIERS)[number];

// ── Lesson Consolidation ──

export interface ConsolidateLessonsInput {
  repoId: string;
  /** Minimum cluster size to consolidate. Defaults to 3. */
  minClusterSize?: number;
  /** Cosine similarity threshold for grouping lessons. Defaults to 0.85. */
  similarityThreshold?: number;
}

export interface ConsolidateLessonsResult {
  clustersFound: number;
  clustersConsolidated: number;
  lessonsConsolidated: number;
  lessonsCreated: number;
}

/** Input for the system-wide scheduled consolidation workflow. */
export interface ScheduledConsolidationInput {
  minClusterSize: number;
  similarityThreshold: number;
}

/**
 * Static input for the system-wide scheduled eval-regression workflow. Args are
 * fixed per Temporal's schedule model — the dataset is referenced by slug (not
 * id) so the schedule survives dataset re-seeding; the workflow resolves the
 * slug → dataset and creates a fresh EvalRun row on each fire.
 */
export interface ScheduledEvalInput {
  datasetSlug: string;
  candidateRef: string;
  baselineRef: string;
}

/** Per-repo outcome within a scheduled run. */
export interface ScheduledConsolidationRepoResult {
  repoId: string;
  result: ConsolidateLessonsResult | { error: string };
}

export interface ScheduledConsolidationResult {
  reposProcessed: number;
  repoResults: ScheduledConsolidationRepoResult[];
}

// ── Eval golden-set re-validation schedule ──

/** Mirrors RevalidateResult from evalRevalidate activity. */
export interface RevalidateResult {
  checked: number;
  /** Newly quarantined this run (were passing, now stale). */
  quarantined: number;
  /** Restored this run (were quarantined, now pass again). */
  restored: number;
}

/** Input for the system-wide scheduled re-validation workflow. */
export interface ScheduledRevalidationInput {
  /** Optional slug substring to filter which datasets are re-validated. */
  datasetSlug?: string;
}

export interface ScheduledRevalidationResult {
  datasetsProcessed: number;
  caseResults: { datasetId: string; result: RevalidateResult | { error: string } }[];
}
