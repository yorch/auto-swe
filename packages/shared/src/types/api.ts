import type { InputSchema } from '../lib/inputSchema.js';
import { isAnthropicSpec } from '../lib/modelSpec.js';
import type { ReviewTimeSummary } from '../lib/prEvaluation/reviewerTime.js';
import type { ReviewBatch, ReviewQueueSummary } from '../lib/prEvaluation/reviewQueue.js';
import type { ReviewRouting, RoutingReason } from '../lib/prEvaluation/reviewRouting.js';
import type { PreviewConfig } from '../lib/previewConfig.js';
import type { PullRequestState } from '../lib/pullRequest.js';
import type { RepoSetup } from '../lib/repoSetup.js';
import type { SetupBlocker } from '../lib/setupBlocker.js';
import type { WorkspaceProviderType } from '../lib/workspaceProviders.js';
import type { BudgetTier, WorkflowStatus } from './workflow.js';

export type { BudgetTier } from './workflow.js';

export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

export interface RepoSetupBlockerSummary extends Omit<SetupBlocker, 'step'> {
  id: string;
  step: string | null;
  remedy: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastWorkflowId: string | null;
  resolvedAt: string | null;
}

export interface RepoSetupBlockersResponse {
  blockers: RepoSetupBlockerSummary[];
}

export const RUN_ACTIVITY_KINDS = [
  'step',
  'tool_call',
  'llm_response',
  'activity_event',
  'http_call',
  'human_step',
] as const;
export type RunActivityKind = (typeof RUN_ACTIVITY_KINDS)[number];
export interface RunActivityFilters {
  kinds?: string;
  recordingId?: string;
  specNodeId?: string;
  since?: string;
}
interface RunActivityBase {
  id: string;
  ts: string;
  recordingId: string | null;
  specNodeId: string | null;
  stepAttempt: number | null;
  attempt: number | null;
  agentKey?: string;
  summary: string;
}
export interface HttpCallActivityDetail {
  callId: string;
  source: string;
  purpose: string;
  method: string;
  scheme: string;
  host: string;
  port: number | null;
  path: string;
  status: number | null;
  durationMs: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  blocked: boolean;
  blockReason: string | null;
  error: string | null;
  transcriptId: string | null;
  hasBodies: boolean;
}
export type RunActivityItem = RunActivityBase &
  (
    | { kind: 'http_call'; detail: HttpCallActivityDetail }
    | {
        kind: 'step';
        detail: {
          phase: 'started' | 'ended';
          nodeType: string | null;
          stepName: string | null;
          status: string;
          error: string | null;
        };
      }
    | {
        kind: 'human_step';
        detail: {
          phase: 'requested' | 'resolved';
          humanKind: string;
          status: string;
          resolvedBy: string | null;
          resolvedVia: string | null;
        };
      }
    | {
        kind: 'tool_call' | 'llm_response' | 'activity_event';
        detail: {
          toolName: string | null;
          durationMs: number | null;
          error: string | null;
          model: string | null;
          inputTokens: number | null;
          outputTokens: number | null;
          costUsd: number | null;
        };
      }
  );
export interface RunActivityPage {
  data: RunActivityItem[];
  nextCursor: string | null;
}
export interface WorkflowHttpCallDetail
  extends Omit<HttpCallActivityDetail, 'callId' | 'hasBodies'> {
  id: string;
  runId: string | null;
  workflowId: string;
  temporalRunId: string | null;
  activityType: string | null;
  recordingId: string | null;
  specNodeId: string | null;
  stepAttempt: number | null;
  attempt: number;
  bodiesTruncated: boolean;
  requestBody?: string | null;
  responseBody?: string | null;
  otelTraceId: string | null;
  otelSpanId: string | null;
  teamId: string | null;
  orgId: string | null;
  startedAt: string;
  createdAt: string;
}

// ── User preferences ──

/** Run-detail page layouts, in the order the toggle renders them. */
export const RUN_DETAIL_LAYOUTS = ['A', 'B', 'C'] as const;
export type RunDetailLayout = (typeof RUN_DETAIL_LAYOUTS)[number];

/** The most team slugs a user can pin. */
export const MAX_PINNED_TEAM_SLUGS = 20;

/** Per-user UI preferences (`GET`/`PATCH /api/v1/me/preferences`). */
export interface UserPreferences {
  runDetailLayout?: RunDetailLayout;
  /** Last team the user worked in; a UI hint, resolved through the member-filtered team list. */
  lastTeamSlug?: string | null;
  /** Team slugs the user pinned; a UI hint, not checked against membership. */
  pinnedTeamSlugs?: string[];
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
  /** GitHub host base (e.g. https://github.com or a GHE URL); null = the instance's host */
  githubUrl?: string | null;
}

export interface PullRequestSummary {
  id: string;
  prNumber: number | null;
  status: string;
  ciStatus: string | null;
  /** The PR on its host, resolved by the gateway; null when it cannot be linked. */
  url: string | null;
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
  /** The caller's own role in this team; null when they are not a member (a platform ADMIN's view). */
  myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null;
  orgId: string;
  orgName: string;
}

/** Where a budget stands against its cap. `no_cap` means no limit is set. */
export type BudgetState = 'no_cap' | 'ok' | 'alert' | 'projected_over' | 'over';

/**
 * A budget as an engineer may see it: a percentage and a state, never dollar amounts. `scope` says
 * whose cap binds: the organization's, or the team's own when it sets one.
 */
export interface BudgetStatus {
  scope: 'org' | 'team';
  state: BudgetState;
  /** Month-to-date as a share of the cap, 0 to 100 or more; null when there is no cap. */
  percentUsed: number | null;
  alertThresholdPercent: number | null;
}

/**
 * A team's own monthly cap, as a team ADMIN (or an ORG_ADMIN, or a platform ADMIN) manages it.
 * Dollar amounts appear only here and in the repo's other admin-only budget reads.
 */
export interface TeamBudgetSettings {
  /** The cap in cents; null when the team sets none and only the organization's cap applies. */
  monthlyBudgetUsdCents: number | null;
  /** Alert threshold as a percentage of the cap, 1 to 100; null for the default. */
  budgetAlertThresholdPercent: number | null;
  /** Spend this calendar month (UTC) attributed to the team, in cents. */
  monthSpendUsdCents: number;
}

/** Body of `PATCH /api/v1/teams/:id/budget`; an omitted key is left unchanged. */
export interface UpdateTeamBudgetBody {
  monthlyBudgetUsdCents?: number | null;
  budgetAlertThresholdPercent?: number | null;
}

/** What kind of obligation a "Needs you" row is. */
export type MeNeedsYouKind = 'approval' | 'approval_due_soon' | 'failed_run' | 'pr_merge';

/** One thing that needs the caller, across every team they belong to. */
export interface MeNeedsYouItem {
  /** Stable de-duplication key: a human-step id, or a run id for failures and PRs. */
  key: string;
  kind: MeNeedsYouKind;
  title: string;
  /** The team that owns the repository (or the template's team); null when it has none. */
  teamId: string | null;
  teamSlug: string | null;
  teamName: string | null;
  /** `owner/name` of the repository, when there is one. */
  repoName: string | null;
  runId: string | null;
  /** The request this row belongs to, for linking to `/requests/:id`. */
  requestId: string | null;
  /** ISO deadline for an approval; null otherwise. */
  dueAt: string | null;
  /** ISO time the item became relevant (step created, run ended, PR opened). */
  occurredAt: string;
}

/** The caller's standing in one of their own teams. */
export interface MeSummaryTeam {
  teamId: string;
  slug: string;
  name: string;
  orgId: string;
  orgName: string;
  /** Never null: this list holds only teams the caller belongs to. */
  myRole: 'ADMIN' | 'LEAD' | 'ENGINEER';
  /** Items in `needsYou` that belong to this team. */
  needsYou: number;
  /** The budget that binds work on this team's repositories; null when none is set. */
  budget: BudgetStatus | null;
  /** Runs started by or visible to the caller that are running now, on this team's repositories. */
  running: number;
  queued: number;
}

/** A repository on a team's overview, with how the team relates to it. */
export interface TeamOverviewRepo {
  id: string;
  /** `owner/name`. */
  name: string;
  relation: 'owned' | 'shared';
  /** False when the repository is shared to the team view-only; always true for an owned one. */
  canLaunch: boolean;
  /** The owning team's name when `relation` is `shared`; null when owned. */
  ownerTeamName: string | null;
  /**
   * Where the cap that binds a launch on this repository stands: for a shared repository the OWNING
   * team's tighter cap, which is what its launches are held to. Null when no cap is set, and for an
   * owned repository, whose status is the team's own `budget`.
   */
  launchBudget: BudgetStatus | null;
}

/** One recent request in a team's activity feed. */
export interface TeamOverviewActivityItem {
  requestId: string | null;
  runId: string | null;
  title: string;
  state: 'active' | 'attention' | 'success' | 'failed';
  repoName: string | null;
  launchedByName: string | null;
  occurredAt: string;
}

/**
 * `GET /api/v1/teams/:id/overview`. Fields a lower role may not see are absent from the
 * response (`lead`, `admin`), never nulled.
 */
export interface TeamOverview {
  team: {
    id: string;
    slug: string;
    name: string;
    orgId: string;
    orgName: string;
    /** The caller's own role in this team; null for a platform ADMIN who is not a member. */
    myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null;
  };
  /** Which view the server built: the team role decides it, never the platform role. */
  viewerLevel: 'engineer' | 'lead' | 'admin';
  /** The budget that binds work on this team's repositories; percentage only. Null when none is set. */
  budget: BudgetStatus | null;
  /** The caller's own actionable items on this team's repositories. */
  needsYou: { total: number };
  running: number;
  queued: number;
  /** Requests started in the last 7 days on this team's repositories (owned or shared). */
  last7d: { started: number; succeeded: number; failed: number };
  /** Last 30 days, counting only runs this team owns (owner-attributed). */
  pullRequests: {
    opened: number;
    merged: number;
    closedUnmerged: number;
    mergeRate: number | null;
    timeToMergeP50Hours: number | null;
  };
  activity: TeamOverviewActivityItem[];
  repos: TeamOverviewRepo[];
  /** Present for team LEAD and ADMIN. */
  lead?: {
    /** Failed latest attempts on the team's repositories whose launcher is no longer a member. */
    unownedFailures: number;
    /** Pending approvals whose deadline has passed. */
    staleApprovals: number;
    openPullRequests: number;
  };
  /** Present for team ADMIN (and a platform ADMIN). */
  admin?: {
    /**
     * This calendar month's attributed spend in cents; null when it cannot be computed. Absent when
     * the organization has a cap and the viewer is not an ORG_ADMIN of it (or a platform ADMIN):
     * beside `budget.percentUsed` it would reveal the cap.
     */
    monthCostUsdCents?: number | null;
  };
}

/** `GET /api/v1/me/summary`: the caller's cross-team desk in one response. */
export interface MeSummary {
  teams: MeSummaryTeam[];
  needsYou: {
    /** Total before the item cap; `items` holds the most urgent first. */
    total: number;
    items: MeNeedsYouItem[];
  };
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
  /** False when this team may view the repository but not start work on it. */
  canLaunch: boolean;
  team: { id: string; name: string; slug: string };
}

// ── Repositories ──

/**
 * The gate steps a repository may give its own command (`Connection.gateCommands`), in the order
 * the dashboard lists them. A gate step with no `command` of its own runs this one, else the
 * worker's built-in default; the worker's `GateName` is the same set.
 */
export const REPO_GATE_COMMAND_KEYS = [
  'runLint',
  'runTypecheck',
  'runTests',
  'runBuild',
  'runVulnScan',
  'runPerfBench',
] as const;
export type RepoGateCommandKey = (typeof REPO_GATE_COMMAND_KEYS)[number];
/** A repository's gate commands: only the gates it overrides, each a non-blank command. */
export type RepoGateCommands = Partial<Record<RepoGateCommandKey, string>>;

export type RunEvidenceKind = 'screenshot' | 'video' | 'trace' | 'log';

export interface RunEvidenceDto {
  id: string;
  kind: RunEvidenceKind;
  source: string;
  caption: string | null;
  pageUrl: string | null;
  specNodeId: string | null;
  stepAttempt: number | null;
  width: number | null;
  height: number | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * One check `POST /repositories/:id/executor-image/probe` reports for a
 * candidate executor image (docs/repositories.md — the image contract).
 */
export interface ExecutorImageProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed required check fails the image; optional/informational ones do not. */
  required: boolean;
}

/** The outcome of opening a pull request that adds `.auto-swe/setup.yml` to a repository. */
export type RepoSetupFileProposal =
  | { ok: true; branch: string; prNumber: number; prUrl: string }
  | { ok: false; reason: 'exists' | 'invalid' | 'not_found' | 'no_base'; detail: string };

/**
 * Where a request to open that pull request stands. `queued` until a worker has finished it;
 * `failed` carries the refusal (`exists`, ...) or `error` when the request itself did not finish.
 */
/** A repository setup secret as the API shows it: never the value. */
export interface RepoSetupSecretSummary {
  name: string;
  lastFour: string;
  updatedAt: string;
  /** `repository` (the default) or `team`, granted from the owning team. */
  source?: 'repository' | 'team';
  /** A team entry hidden by a repository secret of the same name, which wins. */
  shadowed?: boolean;
}

/** A team secret as the API shows it: never the value, plus the repositories it is granted to. */
export interface TeamSecretSummary {
  name: string;
  lastFour: string;
  updatedAt: string;
  grantedConnectionIds: string[];
}

export type RepoSetupFileProposalStatus =
  | { status: 'queued' }
  | { status: 'opened'; branch: string; prNumber: number; prUrl: string }
  | {
      status: 'failed';
      reason: 'exists' | 'invalid' | 'not_found' | 'no_base' | 'error';
      detail: string;
    };

export interface ExecutorImageProbeResult {
  image: string;
  /** True when every required check passed. */
  ok: boolean;
  checks: ExecutorImageProbeCheck[];
}

/**
 * What the scheduled dependency scan detected at a repository's root, stored
 * on `Connection.detectedStack` (see `detectStack` in shared/lib). Shown in
 * repository settings as a suggestion, never applied silently.
 */
export interface DetectedStack {
  stacks: Array<'node' | 'python' | 'jvm' | 'go'>;
  primary: 'node' | 'python' | 'jvm' | 'go' | null;
  suggestedGateCommands: RepoGateCommands;
  /** Which curated defaults/ Dockerfile to build, or null when none matches. */
  suggestedDockerfile: 'node' | 'python' | 'jvm' | 'go' | null;
  /**
   * The Node package manager the root's lockfile names, when the root is a Node
   * project with one. Absent on a detection from before this was recorded.
   */
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  /** Yarn's flavour when `packageManager` is yarn and a pin or `.yarnrc.yml` named it; absent when unknown. */
  yarnFlavor?: 'berry' | 'classic';
  /** The root filenames the detection read as signals. */
  evidence: string[];
  /**
   * Per-directory stack signals for monorepos: `path` is the directory
   * ('' = root), `stacks` what its marker files indicate. Sorted by path,
   * capped at 50.
   */
  components?: Array<{
    path: string;
    stacks: Array<'node' | 'python' | 'jvm' | 'go'>;
    /** For a Node component: the manager its own lockfile names, when exactly one does. */
    packageManager?: 'npm' | 'yarn' | 'pnpm';
    yarnFlavor?: 'berry' | 'classic';
  }>;
  /** More than 50 directories had stack signals. */
  componentsTruncated?: boolean;
  /** The tree listing itself was truncated by the provider. */
  treeTruncated?: boolean;
}

export interface RepositoryOnboardingChecklist {
  accessVerified: boolean;
  stackScanned: boolean;
  setupHealthy: boolean;
  onboardingPrOpened: boolean;
  firstRunLaunched: boolean;
  dismissed: boolean;
  onboardingPrUrl: string | null;
}

/** Shape returned by GET /api/v1/repositories */
export interface RepositorySummary {
  id: string;
  /** Connection type discriminator: 'git_repo' | 'api_endpoint' | 'generic' */
  type: string;
  /** Human label for non-git_repo connections; null for git_repo (use org/repo instead) */
  name: string | null;
  /** Type-specific config JSON (for non-git_repo connections) */
  config: unknown;
  /** Whether a write-only API token is stored for the connection (never the token itself). */
  hasApiToken?: boolean;
  organizationName: string | null;
  repoName: string | null;
  defaultBranch: string;
  isActive: boolean;
  consolidationEnabled: boolean;
  executorImage: string | null;
  /** How the executor image was built (for scheduled rebuilds); null when unset. */
  executorImageBuild?: {
    stack: 'node' | 'node-browser' | 'python' | 'jvm' | 'go';
    useRepoDockerfile: boolean;
  } | null;
  /** Whether `.auto-swe/tools.yml` on the base ref is honoured for this repository. */
  toolsFileEnabled?: boolean;
  /** Tools an admin installs into every run's workspace; null when none. */
  tools?: { key: string; version?: string }[] | null;
  /** Catalog tool keys this repository may never install. */
  toolsDeny?: string[];
  /** Per-gate command overrides; null when the repository overrides none. */
  gateCommands?: RepoGateCommands | null;
  /** Validated per-repository application preview recipe. */
  previewConfig?: PreviewConfig | null;
  /** Workspace setup; overrides the repository's `.auto-swe/setup.yml` when set. */
  setup?: RepoSetup | null;
  /** The repository's own PR title format; null inherits the registry's. */
  prTitleFormat?: 'template' | 'conventional' | null;
  /** The repository's own PR title template; null inherits. */
  prTitleTemplate?: string | null;
  /** Stack detected from root manifests by the dependency scan; null until one ran. */
  detectedStack?: DetectedStack | null;
  onboardingChecklist?: RepositoryOnboardingChecklist;
  language: string | null;
  description: string | null;
  team: TeamRef;
  /**
   * Further teams whose members may see and launch on this repository. The
   * owning `team` keeps management. Present on the repository listing.
   */
  /** `canLaunch` false means the sharing team may view the repository but not start work on it. */
  shares?: Array<{ canLaunch: boolean; team: TeamRef }>;
  /**
   * Where the cap that binds a launch on this repository stands, as percent only: the owning team's
   * tighter of its own and its organization's cap. Null when neither is set. Present on the
   * repository listing, for every repository the caller can launch on.
   */
  launchBudget?: BudgetStatus | null;
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
  kind?: 'review' | 'automation' | null;
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
  /** Whether the webhook's calls are signed (`X-AutoSwe-Signature`). The secret itself is
   *  only returned by POST /workflow-templates/:id/webhook/signing-secret/rotate. */
  webhookSigning: WebhookSigningSummary;
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
export interface WebhookSigningSummary {
  /** A signing secret exists. */
  configured: boolean;
  /** The secret's last four characters, as a hint. */
  lastFour: string | null;
  /** When the secret the last rotation replaced stops being accepted; null when none is. */
  previousExpiresAt: string | null;
  /** The template's own switch: refuse unsigned calls. */
  requireSignature: boolean;
}

export interface WorkflowTemplateDetail extends WorkflowTemplateSummary {
  /** Policy (`workflow.templateWebhookRequireSignature`) forces signed calls for this template. */
  webhookSignatureRequiredByPolicy: boolean;
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
  rollupDays: number;
  liveDays: number;
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
  perVersion: Array<{
    version: number;
    runs: number;
    succeeded: number;
    successRate: number | null;
    successRateCi95: [number, number] | null;
    avgCostPerRun: number | null;
    p50DurationMs: number | null;
    prOpened: number;
    prOpen: number;
    prMerged: number;
    mergeRate: number | null;
    mergeRateCi95: [number, number] | null;
  }>;
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
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  totalCost: number;
  estimatedHumanTimeSavedTotal: number | null;
  autonomyRate: number | null;
  humanReviewRate: number | null;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    totalRuns: number;
    successRate: number | null;
    succeeded: number;
    failed: number;
    totalCost: number;
    avgCostPerRun: number;
    autonomyRate: number | null;
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
  seriesTruncated: boolean;
  legacyCostTruncated: boolean;
  rollupDays: number;
  liveDays: number;
  /** Headline figures for the window of equal length just before this one; null when unavailable. */
  previous?: {
    totalRuns: number;
    successRate: number | null;
    totalCost: number;
    estimatedHumanTimeSavedTotal: number | null;
    autonomyRate: number | null;
    humanReviewRate: number | null;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    rollupDays: number;
    liveDays: number;
  } | null;
  /** Runs started per UTC day in the window, oldest first. */
  daily?: Array<{ date: string; completed: number; failed: number; active: number }>;
  /** Wait times of the human steps requested in the window. */
  approvalLatency?: ApprovalLatencySummary;
}

/** How long people took to answer human steps requested in a window. */
export interface ApprovalLatencyStats {
  /** Steps answered by a person, request to answer; the percentiles are null when none was. */
  resolved: { count: number; p50Ms: number | null; p95Ms: number | null };
  /** Steps nobody answered before their deadline. Not in the latency figures. */
  timedOut: number;
  /** Steps closed without an answer (the run ended first). Not in the latency figures. */
  cancelled: number;
  /** Steps still waiting; excluded from the latency, so the figures read lower than the truth. */
  pending: number;
}

/** Human-step wait times in the analytics window: overall, and per template. */
export interface ApprovalLatencySummary extends ApprovalLatencyStats {
  /** True when the row cap cut into the window, so every figure here is partial. */
  isTruncated: boolean;
  /** Templates with the most steps first; capped. */
  perTemplate: Array<ApprovalLatencyStats & { templateId: string; templateName: string }>;
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
  /**
   * The teams that own the repositories and template the request ran on, for a row's team chip.
   * Repositories shared into a team do not add one: the owner is named.
   */
  teams: { id: string; name: string }[];
}

export interface WorkflowStepRecord {
  stepName?: string;
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

/**
 * One change a run made outside the sandbox (`GET /api/v1/workflow-runs/:id/effects`). `detail` and
 * `error` are already redacted and capped; the raw tool input is never stored, only its digest.
 */
export interface RunEffectDto {
  id: string;
  /** `MCP_TOOL` | `PULL_REQUEST` | `GIT_PUSH` | `TRACKER` | `KNOWLEDGE_BASE`. */
  kind: string;
  action: string;
  /** External id, URL, branch or tool name. */
  target: string | null;
  /** `DONE` | `FAILED`. */
  status: string;
  /** `harness_relay` | `mastra_mcp` | `activity`. */
  via: string;
  /** Workflow-spec node the effect happened in; null when it ran outside a tagged step. */
  specNodeId: string | null;
  agentKey: string | null;
  inputDigest: string | null;
  detail: unknown;
  error: string | null;
  createdAt: string;
}

/** Shape returned by GET /api/v1/workflow-runs/:id (detail) */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  /** The team that owns the run's repository, whose members control it; null when it has none. */
  ownerTeam?: { id: string; name: string; slug: string } | null;
  review?: {
    canControl?: boolean;
    fixRetry?: { allowed: boolean; reason?: string; status?: 'queued' };
    reviewable: boolean;
    reason?: string;
    reviewOf?: { runId: string; templateName: string };
    reviews: Array<{
      runId: string;
      workflowId: string;
      status: string;
      templateName: string;
      presetName: string | null;
      approved: boolean | null;
      worstSeverity: string | null;
      startedAt: string;
    }>;
  };
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
  /**
   * True when the run has more traces than one read returns: `traces` is then the
   * newest `MAX_TRACES_PER_READ` of them, not all of them.
   */
  tracesTruncated?: boolean;
  templateName: string;
  /** A run of the hidden Agent Run system template (keyed on its origin, not its name). */
  isAgentRun?: boolean;
  /**
   * The review page of the pull request this run opened, when there is one the caller may open.
   * Null otherwise, and always null for a machine caller.
   */
  pullRequestId?: string | null;
  /**
   * The `workspace.implementerRuntime` value pinned at run start (`mastra` or
   * `claude-code`); null when the run's pinned settings do not carry it.
   */
  implementerRuntime?: string | null;
  /**
   * The runtime the run pinned for each agent that has its own
   * (`{ agentKey: 'mastra' | 'claude-code' | 'pi' }`): at run start, or the first time
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
  /**
   * Whether the caller may answer this step: the run's control rule, not mere visibility. A member of a
   * team the repository is shared to can see a step they cannot answer. Absent on payloads that predate it.
   */
  canAnswer?: boolean;
  /** Every recorded answer with its optional comment, oldest first. */
  responses?: HumanStepResponse[];
  run: {
    id: string;
    status: string;
    workflowId: string;
    /** The request this run belongs to; the request panel is the first place a run opens. */
    workRequestId?: string | null;
    workRequest?: { externalTicketId: string; description: string } | null;
    /** The team that owns the run's repository; null when the run has none. */
    ownerTeam?: { id: string; name: string; slug: string } | null;
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
  /** The owner when this is a person's token; null for a service principal's. */
  user: { id: string; email: string } | null;
  /** The owner when this is a service principal's token; null for a person's. */
  servicePrincipal: { id: string; name: string; team: { id: string; name: string } } | null;
  /** Empty on a person's token, which acts with its user's role. */
  scopes: string[];
}

// ── Service principals ──

/**
 * What a service principal's token may do. A route opts in by declaring the scopes it needs
 * (`config.serviceScopes`); every other route refuses a service token.
 *
 * `runs:agent` is separate from `runs:launch` because an agent run takes a free-form prompt and
 * an agent of the caller's choosing (the implementer, with a shell): a repository grant alone
 * would otherwise let a principal run anything there. `runs:launch` starts only the templates on
 * the principal's template allowlist.
 */
export const SERVICE_TOKEN_SCOPES = [
  'runs:launch',
  'runs:agent',
  'runs:read',
  'runs:cancel',
] as const;
export type ServiceTokenScope = (typeof SERVICE_TOKEN_SCOPES)[number];

/** A service token's longest lifetime, in days. Every service token expires. */
export const SERVICE_TOKEN_MAX_DAYS = 365;

/** Tokens a principal may hold at once (unrevoked, unexpired): one live plus one rotating in. */
export const SERVICE_TOKEN_MAX_LIVE = 2;

/** One row of GET /api/v1/teams/:teamId/service-principals. */
export interface ServicePrincipalSummary {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  disabledAt: string | null;
  maxRunsPerDay: number;
  maxInFlight: number;
  connectionIds: string[];
  templateIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string } | null;
  /** Unrevoked, unexpired tokens. */
  liveTokenCount: number;
}

/** One row of GET …/service-principals/:id/tokens — never the plaintext. */
export interface ServiceTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ServiceTokenScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** POST …/service-principals/:id/tokens: the plaintext appears here exactly once. */
export interface ServiceTokenCreated extends ServiceTokenSummary {
  token: string;
}

// ── Personal access tokens ──

/** One row of GET /api/v1/auth/tokens (the caller's own tokens; never the plaintext). */
export interface PatSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** POST /api/v1/auth/tokens: a new token, whose plaintext appears here exactly once. */
export interface PatCreated {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  token: string;
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
  /** What came of the latest fire: `STARTED`, or a refusal and why. Null before any. */
  lastDecision?: { at: string; outcome: string; reason: string | null } | null;
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
export const IMPLEMENTER_RUNTIMES = ['mastra', 'claude-code', 'pi'] as const;
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
 * own non-Anthropic model cannot ask for it. `pi` calls its model through the
 * worker's own binding, so it drives any model the Mastra loop can. A version that inherits its model
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

/**
 * How hard an Agent version's model reasons before it answers — the values of
 * an Agent version's `reasoning` (and its CHECK constraint). `off` asks for no
 * reasoning; null is "no opinion": the model's own default, or, for a persona
 * that inherits its model, its parent's level. The worker maps a level onto
 * each provider's own option; a provider with no mapping ignores it.
 */
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Narrows a stored reasoning string (an untyped TEXT column) to a known level, else null. */
export function toReasoningLevel(value: unknown): ReasoningLevel | null {
  return (REASONING_LEVELS as readonly unknown[]).includes(value)
    ? (value as ReasoningLevel)
    : null;
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
  /** The toolchain the case runs on; null/absent is node. */
  stack?: 'node' | 'python' | 'jvm' | 'go' | null;
  reference: unknown;
  tags: string[];
  flakeScreened: boolean;
  flakeRuns: number;
  /**
   * The failed screen was recorded because the reference's runs kept being killed
   * or timing out, not because a run failed: the case could not be checked.
   */
  screenEnvironmentFailed?: boolean;
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
  lessons?: {
    id: string;
    content: string;
    failureType: string | null;
    tags: string[];
    source: 'AUTHORED' | 'IMPORTED';
  }[];
  cases: EvalCaseDto[];
  /** The repository whose setup secrets the cases' workspace setup reads; null reads none. */
  setupSecretsRepository: { id: string; name: string } | null;
  /** The owning team of a TEAM dataset; null otherwise. */
  teamId: string | null;
  /** The owning organization of an ORG dataset; null otherwise. */
  orgId: string | null;
}

export interface EvalRunDto {
  candidateMemoryMode?: 'ON' | 'SHADOW' | 'OFF';
  baselineMemoryMode?: 'ON' | 'SHADOW' | 'OFF';
  corpusHash?: string | null;
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
  /**
   * RUNNING | SUCCESS | REGRESSION | FAILED | INCONCLUSIVE. INCONCLUSIVE: the
   * dataset had cases but none flake-screened, so nothing was scored;
   * `summary.inconclusive` says how many await screening.
   */
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

/**
 * POST /platform/evals/:id/rescreen (or /cases/:caseId/rescreen): the cases reset
 * to never-screened, and whether their dataset's flake screen was started. When it
 * was not (Temporal unreachable), the next eval run of the dataset or the
 * re-validation sweep screens them.
 */
export interface EvalRescreenResultDto {
  reset: number;
  screenStarted: boolean;
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
    /** Cases whose reference passed every run of its flake screen. */
    flakeScreened: number;
    /**
     * Cases not quarantined and never flake-screened. The harness does not score
     * them until a screen passes.
     */
    neverScreened: number;
    /** The oldest 50 of them; `neverScreened` is the total. */
    neverScreenedCaseIds: string[];
    /** Cases not quarantined whose flake screen failed. The harness does not score them. */
    screenFailed: number;
    /** The oldest 50 of them; `screenFailed` is the total. */
    screenFailedCaseIds: string[];
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
  /** The team that owns the repository; null when the repository is gone. */
  ownerTeam: { id: string; name: string; slug: string } | null;
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
  /** Review routing for this pull request; omitted where the route does not compute it. */
  review?: PullRequestReviewRouting;
}

/** Whether a pull request needs a person's attention, and where it sits in the review queue. */
export interface PullRequestReviewRouting {
  /** Where the pull request sits among the open ones; null outside the attention order. */
  position: number | null;
  batch: ReviewBatch;
  needsHuman: boolean;
  /** The deciding reason. */
  reason: RoutingReason;
  /** Every reason that holds, strongest first. */
  reasons: RoutingReason[];
  /** A file of the change that matched the repository's always-human paths. */
  matchedPath: string | null;
  /** Null when the pull request has no evaluation at its current head. */
  riskClass: 'LOW' | 'STANDARD' | 'HIGH' | null;
  changedLines: number | null;
}

/** Counts over the open pull requests an attention-ordered list covered. */
export interface PullRequestQueueMeta extends ReviewQueueSummary {
  /**
   * The queue is cut: more open pull requests matched than one read orders (it covers the oldest),
   * or the evaluation read hit its row cap.
   */
  truncated: boolean;
  /**
   * The evaluation read hit its row cap. A pull request whose evaluation was cut off reads as not
   * evaluated, so it asks for a person.
   */
  evaluationsTruncated: boolean;
}

/** Response data of GET /api/v1/pull-requests/review-time. */
export interface PullRequestReviewTimeResponse {
  window: { start: string; end: string; days: number };
  /** Pull requests opened in the window, ready for review, in the caller's scope. */
  overall: ReviewTimeSummary;
  byRepository: {
    repository: { id: string; org: string; name: string };
    summary: ReviewTimeSummary;
  }[];
  /** `teamId` null is work with no persisted team attribution; `Other team` is masked. */
  byTeam: { teamId: string | null; teamName: string; summary: ReviewTimeSummary }[];
  /** The open queue right now over the same scope, not limited to the window. */
  queue: PullRequestQueueMeta;
  /** A row cap cut into the window's pull requests or their evaluations. */
  truncated: boolean;
}

/** Response data of GET/PUT /api/v1/repositories/:id/review-routing. */
export interface RepositoryReviewRouting {
  /** What this repository stores; keys left out inherit. */
  override: Partial<ReviewRouting>;
  /** The routing in force: the settings at the repository's scope with the override applied. */
  effective: ReviewRouting;
}

/** One changed file of the review page. Every string is host or repository text: plain text only. */
export interface PullRequestCockpitFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** Null for a binary file or one whose patch is too large to show. */
  patch: string | null;
  /** Identifies the patch a reviewer marked viewed; null when there is no patch. */
  patchDigest: string | null;
  /** The evaluation flagged the file as one to verify. */
  flagged: boolean;
  why: string | null;
  verify: string | null;
  /** Why the file is safe to skim, when the evaluation proved it; null otherwise. */
  skim: string | null;
}

/** A finding of the review network. Model text: plain text only. */
export interface PullRequestCockpitFinding {
  /** The line is inside the file's patch at the head the page was read at. */
  anchored: boolean;
  category: string;
  description: string;
  file: string;
  line: number | null;
  reviewer: string;
  severity: 'WARNING' | 'CRITICAL';
  suggestedFix: string;
}

export interface PullRequestCockpitEvaluation {
  id: string;
  headSha: string;
  createdAt: string;
  riskClass: 'LOW' | 'STANDARD' | 'HIGH';
  mode: string;
  statusState: string;
  requiredApprovers: number;
  reasons: { code: string; severity: string; message: string; paths: string[] }[];
  claimsToVerify: string[];
  /** Null for an evaluation written before the intent was stored. */
  intent: {
    criteria: string[];
    handled: { note: string; question: string; resolution: 'implemented' | 'left-unchanged' }[];
    openQuestions: string[];
  } | null;
  /** Null for an evaluation written before the evidence was stored. */
  evidence: {
    ci: 'passed' | 'failed' | 'pending' | 'none' | null;
    runUrl: string | null;
    tests: { failing: number; passing: number; total: number } | null;
    ui: { screenshots: number; traces: number; videos: number } | null;
  } | null;
  findings: PullRequestCockpitFinding[];
  /** The evaluation covers a head other than the one the page shows. */
  stale: boolean;
}

export type PullRequestCockpitFiles =
  | {
      type: 'ok';
      /** The head the host reports now. */
      headSha: string;
      /** The host's state for the pull request: `open` or `closed`. */
      state: string;
      /** The host lists more files than are shown. */
      truncated: boolean;
      /** In reading order. */
      items: PullRequestCockpitFile[];
    }
  | {
      type: 'unavailable';
      reason: 'host-not-approved' | 'no-credential' | 'not-found' | 'rate-limited' | 'failed';
    };

/** What the head moved through since the caller last opened the page. */
export interface PullRequestCockpitSinceVisit {
  /** The head the caller saw last. */
  fromHeadSha: string;
  lastVisitedAt: string;
  /** The earlier head is no longer an ancestor of this one: the branch was rewritten. */
  rewritten: boolean;
  /** Oldest first, capped; null when the host could not be asked, so only the move is known. */
  commits: { sha: string; subject: string }[] | null;
  /** How many commits there are in all, which can exceed `commits`. */
  totalCommits: number;
}

/** A line comment the caller has written and not yet sent. */
export interface PullRequestCockpitDraft {
  id: string;
  path: string;
  /** A line of the file's new side. */
  line: number;
  body: string;
  /** The head the line number was taken at. */
  headSha: string;
  createdAt: string;
  /**
   * The file changed since the comment was written, or the line is no longer in its patch, so the
   * comment cannot be sent as it is. False while the files cannot be read: nothing can be said.
   */
  outdated: boolean;
}

/** Whether the caller can send reviews and comments from the page, as themselves. */
export interface PullRequestCockpitWrite {
  /** They have a saved token for this repository that may be used now. */
  available: boolean;
  /**
   * Why not, when not. `disabled`: saved tokens are off on this platform. `no-token`: none saved for
   * this repository. `unusable`: one is saved but may not be used now. `unreadable`: it cannot be
   * decrypted.
   */
  reason: 'disabled' | 'no-token' | 'unreadable' | 'unusable' | null;
  /**
   * They launched a run of this work or requested it, so the platform sets their approval aside; the
   * host may still show it. Known only for the latest run and the requester.
   */
  approvalMayNotCount: boolean;
  /** Sending back starts a run only while feedback automations are on for the repository. */
  feedbackLoopEnabled: boolean;
}

/** Response data of GET /api/v1/pull-requests/:id/cockpit. */
export interface PullRequestCockpit {
  pull: PullRequestListItem & { headSha: string };
  /** The latest evaluation of this pull request; null when none exists. */
  evaluation: PullRequestCockpitEvaluation | null;
  files: PullRequestCockpitFiles;
  /** Paths of the files the caller marked viewed and whose patch has not changed since. */
  viewed: string[];
  /** What the caller can do from the page beyond reading it. */
  write: PullRequestCockpitWrite;
  /** Paths the caller marked viewed whose patch has changed since the mark. */
  changedSinceViewed: string[];
  /** The caller's own unsent line comments, oldest first. */
  drafts: PullRequestCockpitDraft[];
  /** Set only when the caller has opened this page before and the head has moved since. */
  sinceLastVisit: PullRequestCockpitSinceVisit | null;
}

/** Outcome figures for a cohort of pull requests opened in one window. */
export interface PullRequestOutcomeSummary {
  opened: number;
  merged: number;
  closedUnmerged: number;
  open: number;
  /** merged / (merged + closedUnmerged); null while none has resolved. */
  mergeRate: number | null;
  /** Open-to-merge time of the merged PRs; the percentiles are null when none merged. */
  timeToMergeMs: { p50: number | null; p95: number | null; count: number };
  ciStatusCounts: Record<string, number>;
  draftCount: number;
}

/**
 * Response data of GET /api/v1/pr-evaluations/engagement: whether reviewers act on the brief, for
 * the evaluations written in the window. The counts are approximate (see `docs/pr-evaluation.md`).
 */
export interface PrEngagementResponse {
  /** The window the figures cover, in days. */
  windowDays: number;
  /** The window held more evaluations than one read takes, so the figures cover the newest. */
  capped: boolean;
  /** Evaluations in the window. */
  evaluations: number;
  /** Of those, how many a person reviewed. */
  reviewed: number;
  /** Median minutes from the evaluation to the first review; null when none was reviewed. */
  medianMinutesToFirstReview: number | null;
  /** Share of reviewed evaluations with at least one review asking for changes. */
  changeRequestRate: number | null;
  comments: {
    elsewhere: number;
    flagged: number;
    /** Share of all inline comments that landed on a flagged file; null with no comments. */
    flaggedShare: number | null;
    skimmed: number;
    skimmedShare: number | null;
  };
  /** Pull requests opened in the window that someone opened on the review page. */
  pullRequestsViewed: number;
  /** Median minutes from a pull request opening to its first view there; null with none. */
  medianMinutesToFirstView: number | null;
}

/** Response data of GET /api/v1/pull-requests/outcomes. */
export interface PullRequestOutcomesResponse {
  window: { start: string; end: string; days: number };
  current: PullRequestOutcomeSummary;
  /** Null when the row cap cut into the previous window. */
  previous: PullRequestOutcomeSummary | null;
  /** False when the row cap cut into the previous window. */
  previousComplete: boolean;
  /** True when the row cap cut into the current window, so `current` is partial. */
  isTruncated: boolean;
  /** Top 10 repositories by PRs opened in the window. */
  byRepository: {
    repository: { id: string; name: string; org: string };
    summary: PullRequestOutcomeSummary;
  }[];
  byTemplate: Array<{
    templateId: string | null;
    templateName: string;
    opened: number;
    merged: number;
    closedUnmerged: number;
    mergeRate: number | null;
    medianTimeToMergeMs: number | null;
  }>;
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

// ── Harness profiles (`/api/v1/platform/harness-profiles`) ──

export type HarnessProfileStatus = 'OK' | 'DISABLED';

/** Where a profile folder lives; the host, owner and repository are lowercased. */
export interface HarnessProfileSource {
  host: string;
  owner: string;
  repo: string;
  /** Folder holding `profile.json`; empty for the repository root. */
  path: string;
  ref: string;
}

export interface HarnessProfileFileEntry {
  path: string;
  size: number;
  mode: '100644' | '100755';
}

export interface HarnessProfileManifestDto {
  name: string;
  description: string;
  instructions?: string;
  plugins?: string[];
  tools?: Array<'Skill' | 'Agent'>;
}

/** One stored version. File content is never part of it. */
export interface HarnessProfileVersionDto {
  version: number;
  commitSha: string;
  contentHash: string;
  manifest: HarnessProfileManifestDto;
  files: HarnessProfileFileEntry[];
  fileCount: number;
  totalBytes: number;
  /** Everything shown at approval, which the approver acknowledged. */
  warnings: string[];
  approvedById: string | null;
  createdAt: string;
}

export interface HarnessProfileSummary extends HarnessProfileSource {
  id: string;
  name: string;
  description: string;
  status: HarnessProfileStatus;
  latestVersion: number;
  /** The latest version without its file list. */
  latest: Omit<HarnessProfileVersionDto, 'files' | 'manifest'> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessProfileDetail extends HarnessProfileSummary {
  versions: HarnessProfileVersionDto[];
}

/** `POST /harness-profiles/preview` and `/:name/preview-update`: nothing is written. */
export interface HarnessProfilePreview {
  source: HarnessProfileSource;
  /** The exact commit the ref resolved to; create / accept must name it, with `contentHash` and `warningsHash`. */
  sha: string;
  manifest: HarnessProfileManifestDto;
  files: HarnessProfileFileEntry[];
  totalBytes: number;
  contentHash: string;
  /** Structure warnings, then scanner findings. Approval needs `acknowledgeWarnings` when any. */
  warnings: string[];
  /** sha256 over the sorted warnings; create / accept send it with `contentHash` and the 409 `PREVIEW_STALE` answer carries fresh values. */
  warningsHash: string;
  /** Profiles that would collide with this name (case-insensitive); empty for an update. */
  conflicts: Array<{ name: string; status: HarnessProfileStatus }>;
  /** For an update: the version the content already matches, if any. */
  matchesVersion: number | null;
}
