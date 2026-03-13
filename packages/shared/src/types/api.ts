import type { WorkflowStatus } from './workflow.js';

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
  budgetTier: string;
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
  organizationName: string;
  repoName: string;
  defaultBranch: string;
  isActive: boolean;
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
export interface LessonSummary {
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
