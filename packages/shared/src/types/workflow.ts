// ── Workflow Types ──

export interface RepoWorkRequest {
  workRequestId: string;
  repoId: string;
  externalTicketId: string;
  description: string;
  requestPayload: string;
  // Phase 2+ fields
  contextSnapshotId?: string;
  planOverride?: string;
  // Phase 3+ fields
  slackChannel?: string;
  parentWorkflowId?: string;
}

export interface CodeResult {
  branch: string;
  headSha: string;
  diff: string;
  filesChanged: FileChange[];
  testResults: TestRunResult;
  implementationNotes: string;
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
  stdout: string;    // Truncated to 10KB
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
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  prNumber?: number;
  prUrl?: string;
  totalCIRetries?: number;
  totalReviewRetries?: number;
  lessonsGenerated?: string[];
}

export type WorkflowStatus =
  | 'VALIDATING_CONTEXT'
  | 'IMPLEMENTING'
  | 'IN_REVIEW'
  | 'AWAITING_CI'
  | 'AWAITING_HUMAN_MERGE'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT';

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
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
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

// ── Budget Tiers (Cost Tracking) ──

export const BUDGET_TIERS = ['STANDARD', 'LARGE', 'EPIC'] as const;
export type BudgetTier = typeof BUDGET_TIERS[number];
