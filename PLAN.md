# Autonomous Agentic Engineering System (v19.0 - TDD, CI/CD, & RBAC)

## 1. System Overview & Purpose

This system defines a production-grade, deterministic architecture for an autonomous, agent-driven software engineering workflow. It addresses the "last mile" of engineering automation by moving beyond simple code generation into a fully integrated, self-healing, and self-improving ecosystem.

The system is designed to ingest ambiguous work requests from platforms like Slack or Jira, validate context through deep codebase awareness, execute precise implementation plans in isolated environments, and continuously refine its own performance through a "Lessons Learned" semantic memory layer.

### 1.1 Core Value Proposition & System Implications

- **Strict Workspace Isolation (Custom Executors):** Work requests trigger execution in dedicated, ephemeral sandboxes. Agents clone target repositories into custom Docker images pre-configured with internal registries and tools. Agents are physically restricted from accessing the agentic system's host code.
- **Test-Driven & CI/CD Integrated:** Agents are required to write and execute unit/integration tests locally before opening a PR. Furthermore, the system listens to external CI/CD pipelines (e.g., GitHub Actions); if a pipeline fails, the agent wakes up, reads the logs, and pushes a fix.
- **Human-Governed Merges (No Auto-Merge):** The system integrates with existing engineering cultures. It never merges a PR autonomously. It relies entirely on standard branch protection rules, requiring explicit human review and merging.
- **Role-Based Access Control (RBAC):** The system is identity-aware. It maps Slack IDs and API tokens to specific user roles (Admin, Lead, Engineer), ensuring only authorized personnel can approve architectural plans or trigger epic orchestrations.
- **Durable & Resilient Execution:** Leveraging Temporal.io, the system ensures that long-running tasks—which may wait days for human approval—are resilient to infrastructure crashes or transient API rate limits.
- **Continuous Self-Improvement (Episodic Memory):** Through the integration of pgvector mapped via Prisma v7, the system captures the "why" behind every human rejection, CI/CD failure, or security audit, creating a semantic feedback loop.

## 2. Phased Delivery Roadmap

The system is delivered incrementally across four phases. Each phase produces a working, testable system that builds on the previous one. No phase depends on infrastructure that hasn't been delivered yet.

### Phase 1: Single-Repo Agent Loop (MVP)

**Goal:** A single Temporal workflow that accepts a work request, runs an agent to implement code in an isolated workspace, executes tests, opens a PR, and waits for human merge.

**Delivers:**
- PostgreSQL + pgvector database with Prisma schema (Users, Repositories, WorkRequests, ActiveWorkflows, PullRequests)
- Temporal server + single worker process
- `EngineeringWorkflow` (child workflow only — no parent orchestrator)
- Implementer Agent (Mastra + `claude-opus-4-6`) with bash and GitHub MCP tools
- Local TDD loop (agent writes tests, runs them in DinD, iterates until green)
- `createOrUpdatePullRequest` activity via GitHub API
- Human merge signal webhook (`POST /api/v1/webhooks/git`)
- CLI trigger (`POST /api/v1/work-requests`) with hardcoded ADMIN role
- Docker Compose for local development (Postgres, Temporal, Gateway, Worker)

**Does NOT include:** Multi-repo epics, review network, CI/CD webhook listener, Slack integration, Web UI, RBAC enforcement, semantic memory.

**Exit criteria:** A Jira ticket ID submitted via CLI produces a green PR on a target repository, and the workflow completes when a human merges it.

### Phase 2: Review Network + CI/CD Integration

**Goal:** Add the internal review agents and close the CI/CD feedback loop so the agent self-heals on pipeline failures.

**Delivers:**
- Security Auditor, Domain Logic Reviewer, and Performance Reviewer agents
- `runReviewNetwork` activity that orchestrates all reviewers and aggregates verdicts
- `SecurityReviewProcessor` middleware on Implementer write operations
- CI/CD webhook handler (`POST /api/v1/webhooks/ci`) that fires `ciPipelineSignal`
- `fetchCILogs` + `executeCIFixImplementation` activities for the CI fix loop
- Context Validator agent + `ContextSnapshot` persistence
- OTel tracing integration (Langfuse/SigNoz export)

**Exit criteria:** An agent-opened PR that fails CI triggers automatic log reading, code fix, force-push, and re-run — without human intervention — until CI passes.

### Phase 3: Multi-Repo Epics + RBAC + Slack

**Goal:** Support cross-repository work requests orchestrated by a parent workflow, with full RBAC enforcement and Slack-based human-in-the-loop approval.

**Delivers:**
- Epic Orchestrator (parent workflow) with dependency graph execution
- Planner Agent that decomposes epics into per-repo child workflows
- Slack App integration (interactive messages, approval buttons, thread audit trails)
- RBAC middleware on all Gateway endpoints (JWT + Slack ID resolution)
- Slack approval gates (role-checked: only LEAD/ADMIN can approve architecture plans)
- Human merge gate with Slack notification

**Exit criteria:** A multi-repo Jira epic submitted via Slack produces PRs across 2+ repositories in dependency order, with Slack-based architectural approval from a LEAD role.

### Phase 4: Semantic Memory + Web Dashboard + Production Hardening

**Goal:** Close the learning loop and provide operational visibility.

**Delivers:**
- Memory Agent that summarizes workflow outcomes (rejections, CI failures, fixes) into `AgentLesson` embeddings
- Embedding pipeline (text-embedding-3-large via OpenAI, HNSW index, cosine similarity search)
- Lesson retrieval injected into Planner and Implementer agent context
- Next.js Web Dashboard (Epic Visualizer, Context Inspector, RBAC Policy Editor, Repository Onboarding)
- KEDA autoscaling for agent worker pods
- Custom Executor Image build pipeline (GitHub Actions + ECR)
- Cost tracking and per-workflow token budget enforcement

**Exit criteria:** The Planner Agent retrieves relevant historical lessons when generating a new plan, and the dashboard shows real-time workflow state for all active epics.

## 3. Architectural Design & Boundaries

The architecture strictly enforces the separation of concerns by bifurcating the system into a **Control Plane** (Orchestration, State, and Memory) and an **Execution Plane** (Ephemeral, stateless agent activities).

> **Critical Boundary:** The Control Plane code and the Execution Plane code are completely distinct from the "Target Repositories." Agents operate in an isolated vacuum, completely unaware of the host system running them.

### 2.1 Extended Component Diagram

```
                               ┌───────────────────────────────────────────┐
                               │           EXTERNAL TRIGGER LAYER          │
                               │  [ Slack App ]  [ Jira Webhooks ] [ CLI ] │
                               └─────────────────────┬─────────────────────┘
                                                     │ (RBAC Authenticated)
                                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE (High Availability, Long-Lived State)                                             │
│                                                                                                 │
│  ┌─────────────────────────────┐         ┌───────────────────────────────────────────────────┐  │
│  │     Interaction Gateway     │         │        Epic Orchestrator (Parent Workflow)        │  │
│  │ (Auth, RBAC, CI/CD hooks)   │◀───┐    │           (Temporal Durable Workflows)            │  │
│  └──────────────┬──────────────┘    │    └─────────┬──────────────────────────────┬──────────┘  │
│                 │                   │              │ spawns                       │ spawns      │
│  ┌──────────────▼──────────────┐    │    ┌─────────▼───────────────┐    ┌─────────▼────────┐  │
│  │ Domain & Semantic Memory    │    │    │ Repo A Workflow (Child) │    │ Repo B Workflow  │  │
│  │ (Prisma v7 + pgvector)      │    │    └─────────────────────────┘    └──────────────────┘  │
│  └─────────────────────────────┘    │                │                              │           │
│                                     │                │                              │           │
│  ┌─────────────────────────────┐    │                │                              │           │
│  │  Web UI & Admin Dashboard   │────┘                │                              │           │
│  │  (Next.js / React)          │                     │                              │           │
│  └─────────────────────────────┘                     │                              │           │
└──────────────────────────────────────────────────────┼──────────────────────────────┼───────────┘
                                                       │ (Launch K8s Job)             │
                                                       ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ EXECUTION PLANE (Ephemeral, Sandboxed, Scaled via KEDA)                                         │
│                                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Mastra 1.0 Agent Network (Isolated Custom Workspace)                                      │  │
│  │                                                                                           │  │
│  │   ┌──────────────┐     ┌──────────────┐     ┌───────────────┐                             │  │
│  │   │ Context      │────▶│ Planner      │────▶│ Implementer   │ (Uses Scoped MCP Tools)     │  │
│  │   │ Validator    │     │ Agent        │     │ Agent         │───┐                         │  │
│  │   └──────────────┘     └──────────────┘     └───────────────┘   │                         │  │
│  │                                ▲                  │             │                         │  │
│  │                                │         ┌────────▼────────┐    │  ┌───────────────────┐  │  │
│  │   ┌──────────────┐             │         │ Security Review │◀───┘  │ Docker-in-Docker  │  │  │
│  │   │ Memory Agent │             └─────────┤ Processor (HITL)│       │ (Custom Image:    │  │  │
│  │   │ (Summarizer) │                       └────────┬────────┘       │  e.g., node-20-   │  │  │
│  │   └──────────────┘                                │                │  internal-reg)    │  │  │
│  │          ▲                                        ▼                └───────────────────┘  │  │
│  │          │                               ┌─────────────────┐                              │  │
│  │          └───────────────────────────────┤ Internal Review │                              │  │
│  │                                          │ Network (x4)    │                              │  │
│  │                                          └─────────────────┘                              │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Tech Stack & Engineering Decisions

| Component | Technology | Decision Rationale & Deep Technical Implications |
|---|---|---|
| Orchestration | Temporal.io | Rationale: Handles complex, multi-day parent/child workflows and asynchronous signal waiting (e.g., waiting for GitHub Actions to complete). |
| Agent Framework | Mastra 1.0 (TypeScript) | Rationale: The most robust, pure TS framework for creating deterministic agent networks. |
| Data Access / ORM | Prisma v7.x | Rationale: Rust-free TS-native architecture (90% smaller bundle, 3x faster queries). Provides strict, end-to-end type safety for Postgres with OTel tracing. pgvector columns require raw SQL/TypedSQL (native support pending). |
| Memory Store | PostgreSQL 17 + pgvector | Rationale: Unifies relational metadata and high-dimensional vector embeddings via pgvectorscale and HNSW indexes. |
| Web UI / Dashboard | Next.js (React) + Tailwind | Rationale: Provides a fast, real-time SPA for tracking Temporal workflow states, administrating agent memory, and managing RBAC. |
| Observability | OpenTelemetry (OTel) | Rationale: Traces every token generated, tool called, and reasoning step taken. Exports to Langfuse or SigNoz. |
| Execution Isolation | Kubernetes + KEDA + DinD | Rationale: Workflows launch ephemeral K8s Jobs. DinD allows execution of repository-specific test suites inside custom container images. |
| Tooling Layer | Model Context Protocol (MCP) | Rationale: Standardizes how agents interact with the outside world (GitHub, Jira, bash). |

### 3.1 LLM Model Strategy (Best-in-Class Allocation)

| Agent / Task | Model ID | Context Window | Rationale & Strengths | Fallback |
|---|---|---|---|---|
| Context Validator | `gemini-2.5-pro` | 1M tokens | Massive Context: 100% recall up to 530K tokens, 99.7% at 1M. Natively handles text, code, and images in a single pass — ideal for ingesting entire monorepos, Jira epics, and Confluence docs simultaneously. 64K output cap enables comprehensive context snapshots in one shot. | `claude-opus-4-6` (1M beta) |
| Planner Agent | `claude-opus-4-6` | 200K (1M beta) | Architectural Reasoning: 80.8% on SWE-Bench Verified — strongest score for real-world multi-file reasoning. Adaptive thinking mode dynamically allocates compute to architecturally complex reasoning steps. Plans more carefully and sustains agentic tasks for longer in large codebases. | `gpt-5` (400K context) |
| Implementer Agent | `claude-opus-4-6` | 200K (1M beta) | Surgical Coding & TDD: 80.8% SWE-Bench, 128K output token limit (writes substantial patches + full test suites in one generation). Best-in-class MCP JSON schema adherence and tool call accuracy. Self-corrects during multi-turn TDD loops. | `gpt-5` |
| Security Auditor | `claude-opus-4-6` | 200K | Adversarial Simulation: Autonomously discovered 500+ validated high-severity vulnerabilities across major OSS libraries with zero hallucinated CVEs. MRCR v2 score of 76% for multi-file diff analysis. Lowest hallucination rate on code review tasks. | `gpt-5` |
| Domain Logic Reviewer | `claude-opus-4-6` | 200K | Deep QA & Edge Cases: MRCR v2 leader for nuanced multi-file reasoning. Adaptive thinking mode enables extended deliberation on ambiguous business logic edge cases. Acts as QA lead. | `gemini-2.5-pro` |
| Performance Reviewer | `gpt-5.2` | 400K | Algorithmic Specialization: 100% on AIME 2025 — strongest mathematical/algorithmic reasoning benchmark. Deep AST parsing, Big-O analysis, and loop bound correctness. 400K context comfortably holds full file ASTs alongside diffs. | `claude-opus-4-6` |
| Interaction Gateway | `gemini-2.5-flash` | 1M tokens | Low Latency Classification: 0.32s time-to-first-token, ~250 tokens/sec, $0.30/M input. 1M context window handles full CI/CD log dumps without truncation. Includes thinking capabilities for ambiguous intent classification. | `gpt-5-mini` |

### 3.2 Cost Management & Rate-Limit Strategy

Running multiple LLM providers per workflow requires explicit cost controls and rate-limit handling.

#### Per-Workflow Token Budget

Every workflow is assigned a token budget at creation time. The budget is tracked in the `ActiveWorkflow` metadata and decremented after each LLM call.

| Budget Tier | Max Input Tokens | Max Output Tokens | Typical Use Case |
|---|---|---|---|
| STANDARD | 2M | 500K | Single-repo feature or bug fix |
| LARGE | 8M | 2M | Multi-file refactor or cross-repo epic child |
| EPIC | 20M | 5M | Parent epic orchestrator (sum of all children) |

**Enforcement:** Each activity that makes an LLM call reads the remaining budget from the workflow metadata before calling the provider API. If the estimated call would exceed the remaining budget, the activity:
1. Logs a warning with the current spend breakdown
2. Attempts the call with a reduced `max_tokens` output cap
3. If the budget is fully exhausted, fails the activity with `BUDGET_EXCEEDED` error → workflow transitions to `FAILED` with Slack notification

#### Cost Estimation Per Workflow

Based on current provider pricing (February 2026):

| Agent | Model | Avg Input/Call | Avg Output/Call | Calls/Workflow | Est. Cost/Workflow |
|---|---|---|---|---|---|
| Gateway Classifier | `gemini-2.5-flash` | 5K tokens | 500 tokens | 1 | $0.002 |
| Context Validator | `gemini-2.5-pro` | 200K tokens | 20K tokens | 1 | $0.45 |
| Planner | `claude-opus-4-6` | 50K tokens | 10K tokens | 1 | $0.50 |
| Implementer (per TDD iter.) | `claude-opus-4-6` | 80K tokens | 30K tokens | 3 avg | $2.65 |
| Security Auditor | `claude-opus-4-6` | 40K tokens | 5K tokens | 1 | $0.33 |
| Domain Reviewer | `claude-opus-4-6` | 40K tokens | 5K tokens | 1 | $0.33 |
| Performance Reviewer | `gpt-5.2` | 40K tokens | 5K tokens | 1 | $0.14 |
| Memory Summarizer | `claude-opus-4-6` | 20K tokens | 3K tokens | 1 | $0.18 |
| Embedding Generation | `text-embedding-3-large` | 2K tokens | — | 2 | $0.001 |
| **Total (STANDARD, happy path)** | | | | **~11 calls** | **~$4.60** |

**With CI retries (worst case: 3 CI failures + 3 review rejections):** ~$15-20 per workflow.

#### Rate-Limit Handling

Each provider has different rate limits. The system handles them at the Mastra tool-call layer:

| Provider | Rate Limit Strategy |
|---|---|
| Anthropic (`claude-opus-4-6`) | Respect `retry-after` header. Exponential backoff starting at 30s. If 429 persists for >5m, fail activity (Temporal will retry per policy). |
| OpenAI (`gpt-5.2`, `text-embedding-3-large`) | Respect `x-ratelimit-reset-tokens` header. Queue requests with token bucket (10K TPM reserve). |
| Google (`gemini-2.5-pro`, `gemini-2.5-flash`) | Respect `Retry-After` header. Fall back to Vertex AI endpoint if AI Studio quota is exhausted. |

**Provider failover:** If the primary model returns 5 consecutive 429s or 500s within a 10-minute window, the activity automatically switches to the fallback model specified in Section 3.1. This is logged as an OTel event and a Slack audit message.

#### Cost Observability

All LLM calls emit OTel spans with the following attributes:

```typescript
span.setAttributes({
  'llm.model': 'claude-opus-4-6',
  'llm.provider': 'anthropic',
  'llm.input_tokens': usage.input_tokens,
  'llm.output_tokens': usage.output_tokens,
  'llm.cost_usd': calculateCost(model, usage),
  'workflow.id': workflowId,
  'workflow.budget_remaining_tokens': remainingBudget,
});
```

The Web Dashboard (Phase 4) aggregates these spans to display per-workflow and per-agent cost breakdowns.

### 3.3 Agent-to-Agent Data Flow & Typed Interfaces

Every handoff between agents uses a typed interface. No agent receives raw, unstructured output from a predecessor — all inter-agent communication is serialized JSON conforming to these TypeScript types.

```typescript
// ── Workflow Input ──

interface RepoWorkRequest {
  workRequestId: string;           // UUID from WorkRequest table
  repoId: string;                  // UUID from Repository table
  contextSnapshotId: string;       // UUID — immutable snapshot created by Context Validator
  planOverride?: string;           // Optional pre-approved plan (skips Planner)
  slackChannel?: string;           // For audit trail notifications
  parentWorkflowId?: string;       // Set when spawned by Epic Orchestrator
}

// ── Context Validator → Planner ──

interface ContextSnapshot {
  id: string;
  workRequestId: string;
  rawJiraEpic: Record<string, unknown> | null;
  rawConfluence: Record<string, unknown> | null;
  successCriteria: string[];       // Extracted acceptance criteria (immutable once persisted)
  relevantFilePaths: string[];     // Files identified as impacted by the change
  apiContracts: ApiContract[];     // Cross-repo contracts that must be preserved
  historicalLessons: LessonSummary[]; // Retrieved from pgvector similarity search
}

interface ApiContract {
  sourceRepo: string;
  endpoint: string;
  method: string;
  requestSchema: Record<string, unknown>;  // JSON Schema
  responseSchema: Record<string, unknown>;
}

interface LessonSummary {
  lessonId: string;
  summary: string;
  failureType: string;             // 'CI_FAILURE' | 'REVIEW_REJECTION' | 'SECURITY_VIOLATION' | 'MERGE_CONFLICT'
  similarity: number;              // Cosine similarity score (0-1)
}

// ── Planner → Implementer ──

interface ExecutionPlan {
  planId: string;
  steps: PlanStep[];
  testStrategy: TestStrategy;
  estimatedFiles: string[];        // Files the implementer should touch
  constraints: string[];           // Derived from successCriteria + security guidelines
}

interface PlanStep {
  order: number;
  description: string;             // Human-readable instruction
  targetFiles: string[];           // Specific file paths
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  rationale: string;               // Why this step is necessary
  dependsOn: number[];             // References to prior step `order` values
}

interface TestStrategy {
  framework: string;               // 'jest' | 'pytest' | 'go test' | etc. (detected from repo)
  testFiles: string[];             // Where tests should be written
  coverageTargets: string[];       // Functions/modules that must be covered
  runCommand: string;              // e.g., 'npm run test', 'pytest -x'
}

// ── Implementer → Review Network ──

interface CodeResult {
  branch: string;                  // Git branch name (e.g., 'auto/JIRA-1234')
  headSha: string;                 // Latest commit SHA
  diff: string;                    // Unified diff of all changes
  filesChanged: FileChange[];
  testResults: TestRunResult;
  implementationNotes: string;     // Agent's rationale for key decisions
}

interface FileChange {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

interface TestRunResult {
  passed: boolean;
  total: number;
  passing: number;
  failing: number;
  stdout: string;                  // Truncated to 10KB
  duration_ms: number;
}

// ── Review Network (each reviewer produces a ReviewVerdict) ──

interface ReviewVerdict {
  reviewer: 'SECURITY' | 'DOMAIN_LOGIC' | 'PERFORMANCE';
  approved: boolean;
  severity: 'PASS' | 'INFO' | 'WARNING' | 'CRITICAL';
  findings: ReviewFinding[];
}

interface ReviewFinding {
  file: string;
  line?: number;
  category: string;                // e.g., 'SQL_INJECTION', 'MISSING_EDGE_CASE', 'O(N^2)_LOOP'
  description: string;
  suggestedFix: string;            // Imperative instruction for the Implementer
}

interface AggregatedReviewResult {
  approved: boolean;               // true only if ALL reviewers approve
  verdicts: ReviewVerdict[];
  codeResult: CodeResult;          // Passed through for PR creation
  rejectionSummary?: string;       // Concatenated critical findings for Implementer retry
}

// ── Workflow Output ──

interface WorkflowResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  prNumber?: number;
  prUrl?: string;
  totalCIRetries: number;
  totalReviewRetries: number;
  apiContractsChanged: boolean;
  lessonsGenerated: string[];      // UUIDs of AgentLesson records created
}
```

**Data flow summary:**

```
WorkRequest
  → Context Validator  →  ContextSnapshot
  → Planner Agent      →  ExecutionPlan
  → Implementer Agent  →  CodeResult
  → Review Network     →  AggregatedReviewResult
       ├─ (approved)   →  createOrUpdatePullRequest → await CI → await human merge
       └─ (rejected)   →  CodeResult fed back to Implementer with rejectionSummary
  → Memory Agent       →  AgentLesson (persisted with embedding)
```

## 4. End-to-End Workflow Lifecycle (CI/CD & TDD Integrated)

To support work requests spanning different repositories, the system utilizes Temporal's Parent-Child Workflow pattern. The Child workflow has been substantially upgraded to include local Test-Driven Development (TDD) loops, CI/CD pipeline webhooks, and explicit human merge gates.

### 4.1 The Epic Orchestrator (Parent Workflow)

The gateway triggers this master workflow. It evaluates global impact, orchestrates the dependency graph, and waits for all child repos to be successfully merged by human engineers.

### 4.2 The Repo-Specific Workflow (Child Workflow with CI/CD & TDD)

This is the standard, isolated agent loop that operates strictly within the confines of a single repository.

```typescript
import { workflowInfo, defineSignal, setHandler, condition, proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from './activities';

// ── Activity Proxies with Retry Policies & Timeouts ──

// Short-lived, idempotent DB writes. Retry aggressively on transient failures.
const stateActivities = proxyActivities<Pick<typeof activitiesType,
  'updateDomainState' | 'postSlackThreadAudit' | 'notifyHumanGate'
>>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s' },
});

// Long-running LLM agent loops. Must heartbeat to prove liveness.
// Single attempt — retries are handled internally by the TDD loop.
const agentActivities = proxyActivities<Pick<typeof activitiesType,
  'executeImplementation' | 'executeCIFixImplementation' | 'runReviewNetwork'
>>({
  startToCloseTimeout: '30m',     // Agent may run multiple TDD iterations
  heartbeatTimeout: '5m',         // If no heartbeat for 5m, assume agent is stuck
  retry: { maximumAttempts: 2, initialInterval: '30s', backoffCoefficient: 2, maximumInterval: '2m' },
});

// GitHub API calls. Moderate timeout, retry on rate limits (HTTP 429).
const githubActivities = proxyActivities<Pick<typeof activitiesType,
  'createOrUpdatePullRequest' | 'fetchCILogs'
>>({
  startToCloseTimeout: '2m',
  retry: { maximumAttempts: 4, initialInterval: '5s', backoffCoefficient: 3, maximumInterval: '2m' },
});

// Memory commit. Involves LLM summarization + embedding generation + DB write.
const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2, maximumInterval: '1m' },
});

// ── Workflow Signals ──

export const ciPipelineSignal = defineSignal<{ passed: boolean, logsUrl?: string }>('ciPipelineSignal');
export const humanMergeSignal = defineSignal<boolean>('humanMergeSignal');

// ── Workflow Constants ──

const MAX_CI_RETRIES = 3;           // Max times the agent will attempt to fix CI failures
const MAX_REVIEW_RETRIES = 3;       // Max times code cycles through the review network
const CI_SIGNAL_TIMEOUT = '4h';     // Max wait for CI pipeline to report back
const HUMAN_MERGE_TIMEOUT = '7d';   // Max wait for a human to merge the PR

// ── Workflow Implementation ──

export async function EngineeringWorkflow(request: RepoWorkRequest): Promise<WorkflowResult> {
  const { workflowId, parent } = workflowInfo();
  let ciResult: { passed: boolean, logsUrl?: string } | null = null;
  let humanMerged = false;
  let totalCIRetries = 0;
  let totalReviewRetries = 0;

  setHandler(ciPipelineSignal, (payload) => { ciResult = payload; });
  setHandler(humanMergeSignal, () => { humanMerged = true; });

  await stateActivities.updateDomainState(workflowId, 'IMPLEMENTING', request.repoId);

  // 1. Implementation Phase (Includes local TDD Loop)
  let codeResult = await agentActivities.executeImplementation(request.planOverride, request.contextSnapshotId);

  let isReadyForMerge = false;

  while (!isReadyForMerge) {
      await stateActivities.updateDomainState(workflowId, 'IN_REVIEW', request.repoId);

      // 2. Internal Review Loop
      const reviewResult = await agentActivities.runReviewNetwork(codeResult, request.contextSnapshotId);

      if (!reviewResult.approved) {
          totalReviewRetries++;
          if (totalReviewRetries >= MAX_REVIEW_RETRIES) {
              await stateActivities.notifyHumanGate(request.slackChannel, 'Review network rejected code after max retries. Manual intervention required.', 'PR_READY');
              return { status: 'FAILED', totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
          }
          // Feed rejection back to implementer
          codeResult = await agentActivities.executeCIFixImplementation(reviewResult.rejectionSummary!, codeResult);
          continue;
      }

      // 3. Open PR & Await External CI/CD Pipeline
      await stateActivities.updateDomainState(workflowId, 'AWAITING_CI', request.repoId);
      const prData = await githubActivities.createOrUpdatePullRequest(reviewResult);

      // Wait for CI signal with timeout
      const ciSignalReceived = await condition(() => ciResult !== null, CI_SIGNAL_TIMEOUT);
      if (!ciSignalReceived) {
          await stateActivities.postSlackThreadAudit(workflowId, '⏰ CI pipeline did not report within timeout. Marking as failed.');
          return { status: 'TIMED_OUT', prNumber: prData.prNumber, totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
      }

      if (ciResult!.passed) {
          isReadyForMerge = true;
      } else {
          totalCIRetries++;
          if (totalCIRetries >= MAX_CI_RETRIES) {
              await stateActivities.postSlackThreadAudit(workflowId, `❌ CI failed ${MAX_CI_RETRIES} times. Escalating to human.`);
              return { status: 'FAILED', prNumber: prData.prNumber, totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
          }
          // 4. CI/CD Fix Loop
          await stateActivities.postSlackThreadAudit(workflowId, `❌ External CI failed (attempt ${totalCIRetries}/${MAX_CI_RETRIES}). Reading logs and retrying...`);
          const failedLogs = await githubActivities.fetchCILogs(ciResult!.logsUrl);
          codeResult = await agentActivities.executeCIFixImplementation(failedLogs, codeResult);
          ciResult = null;
      }
  }

  // 5. Hand-off to Human Engineers
  await stateActivities.updateDomainState(workflowId, 'AWAITING_HUMAN_MERGE', request.repoId);
  await stateActivities.notifyHumanGate(request.slackChannel, 'PR is green and awaiting human review/merge.', 'PR_READY');

  // Wait for human merge with timeout
  const merged = await condition(() => humanMerged === true, HUMAN_MERGE_TIMEOUT);
  if (!merged) {
      await stateActivities.postSlackThreadAudit(workflowId, '⏰ PR was not merged within 7 days. Workflow expired.');
      return { status: 'TIMED_OUT', totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
  }

  // 6. Memory Commit
  await memoryActivities.commitToMemory(workflowId, request.repoId);

  await stateActivities.updateDomainState(workflowId, 'COMPLETED', request.repoId);
  return { status: 'SUCCESS', apiContractsChanged: true, totalCIRetries, totalReviewRetries, lessonsGenerated: [] };
}
```

**Retry & timeout strategy summary:**

| Activity Category | Timeout | Heartbeat | Max Attempts | Rationale |
|---|---|---|---|---|
| State updates (DB writes, Slack) | 30s | — | 5 | Idempotent, fast. Retry aggressively on transient DB/network errors. |
| Agent loops (implementation, review) | 30m | 5m heartbeat | 2 | Long-running LLM calls. Heartbeat detects stuck agents. Internal TDD loop handles code-level retries. |
| GitHub API (PR creation, log fetch) | 2m | — | 4 | Rate limits (429) are common. Exponential backoff with 3x coefficient accommodates GitHub's reset windows. |
| Memory commit (summarize + embed) | 5m | — | 3 | Involves LLM call + embedding API + DB write. Moderate retry for transient failures. |

**Workflow-level safety bounds:**

| Bound | Value | Behavior on Breach |
|---|---|---|
| Max CI retries | 3 | Workflow fails, escalates to human via Slack |
| Max review retries | 3 | Workflow fails, escalates to human via Slack |
| CI signal timeout | 4 hours | Workflow times out with TIMED_OUT status |
| Human merge timeout | 7 days | Workflow expires with TIMED_OUT status |

### 4.3 Activity Implementations

Each activity referenced by the workflow is a Temporal activity function executed by the worker process. Activities are the boundary between Temporal's deterministic replay and the non-deterministic outside world (LLM calls, Docker, GitHub API, database writes).

#### `executeImplementation` — The Core Agent Loop

This is the most complex activity. It provisions a sandboxed workspace, runs the Mastra agent network, and returns a `CodeResult`.

```typescript
// activities/executeImplementation.ts
import { Mastra } from '@mastra/core';
import { k8sClient } from '../infra/k8s';
import { prisma } from '../db';

export async function executeImplementation(
  planOverride: string | undefined,
  contextSnapshotId: string
): Promise<CodeResult> {
  // 1. Load context snapshot + repository config
  const snapshot = await prisma.contextSnapshot.findUniqueOrThrow({
    where: { id: contextSnapshotId },
    include: { workRequest: { include: { activeWorkflows: { include: { repository: true } } } } }
  });
  const repo = snapshot.workRequest.activeWorkflows[0].repository!;

  // 2. Retrieve relevant historical lessons via pgvector similarity search
  const lessons = await retrieveSimilarLessons(snapshot.successCriteria.join(' '), repo.id);

  // 3. Provision isolated workspace (K8s Job with custom executor image)
  const workspace = await k8sClient.createJob({
    image: repo.executorImage ?? 'node:20-alpine',
    command: ['sleep', 'infinity'],  // Kept alive for agent tool calls
    volumes: [{ name: 'workspace', mountPath: '/workspace/target-repo' }],
    env: {
      GITHUB_TOKEN: await generateScopedInstallationToken(repo),
      REPO_URL: `https://github.com/${repo.organizationName}/${repo.repoName}.git`,
      BRANCH: `auto/${snapshot.workRequest.externalTicketId}`,
    },
  });

  try {
    // 4. Clone repo into workspace
    await workspace.exec('git', ['clone', '--depth=50', '-b', repo.defaultBranch, '$REPO_URL', '.']);
    await workspace.exec('git', ['checkout', '-b', '$BRANCH']);

    // 5. Run Planner Agent (if no plan override provided)
    const plan: ExecutionPlan = planOverride
      ? JSON.parse(planOverride)
      : await runPlannerAgent(snapshot, lessons);

    // 6. Run Implementer Agent with TDD loop
    const mastra = new Mastra({ /* agent config */ });
    const implementer = mastra.getAgent('implementer');

    let testResult: TestRunResult = { passed: false, total: 0, passing: 0, failing: 0, stdout: '', duration_ms: 0 };
    let iteration = 0;
    const MAX_TDD_ITERATIONS = 5;

    while (!testResult.passed && iteration < MAX_TDD_ITERATIONS) {
      // Implementer writes/modifies code and tests based on plan
      await implementer.generate([
        { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({
          plan,
          contextSnapshot: snapshot,
          previousTestResult: iteration > 0 ? testResult : undefined,
          iteration,
        })},
      ], { toolChoice: 'auto' });  // Agent uses MCP tools (writeFile, editFile, bash)

      // Run tests in the DinD sandbox
      const testOutput = await workspace.exec(plan.testStrategy.runCommand);
      testResult = parseTestOutput(testOutput, plan.testStrategy.framework);
      iteration++;
    }

    // 7. Collect diff and build CodeResult
    const diff = await workspace.exec('git', ['diff', repo.defaultBranch]);
    const headSha = await workspace.exec('git', ['rev-parse', 'HEAD']);

    return {
      branch: `auto/${snapshot.workRequest.externalTicketId}`,
      headSha: headSha.trim(),
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Completed in ${iteration} TDD iterations`,
    };
  } finally {
    // 8. Tear down K8s Job (workspace is ephemeral)
    await k8sClient.deleteJob(workspace.jobId);
  }
}
```

#### `runReviewNetwork` — Parallel Multi-Agent Review

Runs all reviewers concurrently via `Promise.allSettled`, then aggregates verdicts.

```typescript
// activities/runReviewNetwork.ts
export async function runReviewNetwork(
  codeResult: CodeResult,
  contextSnapshotId: string
): Promise<AggregatedReviewResult> {
  const snapshot = await prisma.contextSnapshot.findUniqueOrThrow({ where: { id: contextSnapshotId } });

  // Run all reviewers in parallel — each is an independent Mastra agent call
  const [securityVerdict, domainVerdict, perfVerdict] = await Promise.allSettled([
    runSecurityAuditor(codeResult),
    runDomainLogicReviewer(codeResult, snapshot),
    runPerformanceReviewer(codeResult),
  ]).then(results => results.map(r =>
    r.status === 'fulfilled' ? r.value : { reviewer: 'UNKNOWN', approved: false, severity: 'CRITICAL', findings: [{ file: '', category: 'REVIEWER_CRASH', description: (r as PromiseRejectedResult).reason.message, suggestedFix: 'Manual review required' }] } as ReviewVerdict
  ));

  const verdicts = [securityVerdict, domainVerdict, perfVerdict];
  const approved = verdicts.every(v => v.approved);

  return {
    approved,
    verdicts,
    codeResult,
    rejectionSummary: approved ? undefined : verdicts
      .filter(v => !v.approved)
      .flatMap(v => v.findings)
      .map(f => `[${f.category}] ${f.file}:${f.line ?? '?'} — ${f.suggestedFix}`)
      .join('\n'),
  };
}

// Each reviewer follows the same pattern: Mastra agent → structured output → ReviewVerdict
async function runSecurityAuditor(codeResult: CodeResult): Promise<ReviewVerdict> {
  const mastra = new Mastra({ /* config */ });
  const auditor = mastra.getAgent('security-auditor');
  const result = await auditor.generate([
    { role: 'system', content: SECURITY_AUDITOR_PROMPT },
    { role: 'user', content: JSON.stringify({ diff: codeResult.diff, filesChanged: codeResult.filesChanged }) },
  ], { output: ReviewVerdictSchema });  // Zod schema enforces structured output
  return result.object;
}
```

#### `createOrUpdatePullRequest` — GitHub PR Management

```typescript
// activities/createOrUpdatePullRequest.ts
export async function createOrUpdatePullRequest(
  reviewResult: AggregatedReviewResult
): Promise<{ prNumber: number; prUrl: string }> {
  const { codeResult } = reviewResult;
  const repo = await getRepoForBranch(codeResult.branch);
  const token = await generateScopedInstallationToken(repo);
  const octokit = new Octokit({ auth: token });

  // Push the branch
  // (agent has already committed locally in the workspace)
  // The workspace exec pushes via the scoped token

  // Check if PR already exists for this branch
  const existing = await prisma.pullRequest.findFirst({
    where: { repository: { id: repo.id }, workflow: { assignedBranch: codeResult.branch }, status: 'OPEN' },
  });

  if (existing) {
    // Force-push updated branch; PR auto-updates
    await prisma.pullRequest.update({
      where: { id: existing.id },
      data: { headSha: codeResult.headSha, ciStatus: 'PENDING' },
    });
    return { prNumber: existing.prNumber!, prUrl: `https://github.com/${repo.organizationName}/${repo.repoName}/pull/${existing.prNumber}` };
  }

  // Create new PR
  const { data: pr } = await octokit.pulls.create({
    owner: repo.organizationName,
    repo: repo.repoName,
    title: `[Auto] ${codeResult.branch}`,
    body: formatPRBody(reviewResult),
    head: codeResult.branch,
    base: repo.defaultBranch,
  });

  await prisma.pullRequest.create({
    data: {
      prNumber: pr.number,
      headSha: codeResult.headSha,
      status: 'OPEN',
      ciStatus: 'PENDING',
      repository: { connect: { id: repo.id } },
      workflow: { connect: { id: (await getWorkflowForBranch(codeResult.branch)).id } },
    },
  });

  return { prNumber: pr.number, prUrl: pr.html_url };
}
```

#### `fetchCILogs` + `executeCIFixImplementation` — CI Self-Healing

```typescript
// activities/ciFixLoop.ts
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) return 'No logs URL provided by CI webhook';
  const response = await fetch(logsUrl, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
  });
  const fullLog = await response.text();
  // Truncate to last 50KB to fit in LLM context
  return fullLog.slice(-50_000);
}

export async function executeCIFixImplementation(
  ciLogs: string,
  previousCodeResult: CodeResult
): Promise<CodeResult> {
  // Re-uses the same implementation activity but injects CI failure context
  // The agent sees: "Your previous code passed local tests but failed CI. Here are the logs."
  const mastra = new Mastra({ /* config */ });
  const implementer = mastra.getAgent('implementer');

  // Provision workspace, checkout the existing branch, apply fix
  const workspace = await provisionWorkspace(previousCodeResult.branch);
  try {
    await implementer.generate([
      { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({
        mode: 'CI_FIX',
        ciLogs,
        previousDiff: previousCodeResult.diff,
        previousTestResults: previousCodeResult.testResults,
      })},
    ], { toolChoice: 'auto' });

    // Re-run local tests after fix
    const testOutput = await workspace.exec('npm run test');
    const testResult = parseTestOutput(testOutput, 'jest');

    const diff = await workspace.exec('git', ['diff', 'origin/main']);
    const headSha = await workspace.exec('git', ['rev-parse', 'HEAD']);

    return {
      ...previousCodeResult,
      headSha: headSha.trim(),
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `CI fix iteration. Logs analyzed: ${ciLogs.length} chars`,
    };
  } finally {
    await k8sClient.deleteJob(workspace.jobId);
  }
}
```

#### `commitToMemory` — Workflow Summary → pgvector

```typescript
// activities/commitToMemory.ts
export async function commitToMemory(workflowId: string, repoId: string): Promise<void> {
  const workflow = await prisma.activeWorkflow.findUniqueOrThrow({
    where: { temporalWorkflowId: workflowId },
    include: { pullRequests: true, agentLessons: true },
  });

  // Memory Agent summarizes the full workflow lifecycle
  const mastra = new Mastra({ /* config */ });
  const memoryAgent = mastra.getAgent('memory-summarizer');
  const summary = await memoryAgent.generate([
    { role: 'system', content: 'Summarize this engineering workflow into a concise lesson learned. Focus on: what went wrong, what was fixed, and what should be avoided next time.' },
    { role: 'user', content: JSON.stringify(workflow) },
  ], { output: LessonSummarySchema });

  // Generate embedding and store
  const embedding = await generateEmbedding(summary.object.lessonSummary);
  await prisma.$executeRaw`
    INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
    VALUES (gen_random_uuid(), ${workflow.id}::uuid, ${repoId}::uuid, ${summary.object.rationale},
            ${summary.object.lessonSummary}, ${embedding}::vector, ${summary.object.failureType}, ${summary.object.metadata}::jsonb, now())
  `;
}
```

#### Utility Activities

```typescript
// activities/utilities.ts
export async function updateDomainState(workflowId: string, status: string, repoId: string): Promise<void> {
  await prisma.activeWorkflow.update({
    where: { temporalWorkflowId: workflowId },
    data: { currentStatus: status },
  });
}

export async function postSlackThreadAudit(workflowId: string, message: string): Promise<void> {
  const workflow = await prisma.activeWorkflow.findUniqueOrThrow({
    where: { temporalWorkflowId: workflowId },
    include: { workRequest: true },
  });
  if (workflow.workRequest?.slackMessageTs) {
    await slackClient.chat.postMessage({
      channel: workflow.workRequest.slackMessageTs,
      thread_ts: workflow.workRequest.slackMessageTs,
      text: message,
    });
  }
}

export async function notifyHumanGate(
  slackChannel: string | undefined,
  message: string,
  gateType: 'PR_READY' | 'PLAN_APPROVAL'
): Promise<void> {
  if (!slackChannel) return;
  await slackClient.chat.postMessage({
    channel: slackChannel,
    text: message,
    blocks: [{
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View PR' }, action_id: `view_${gateType}` }],
    }],
  });
}
```

## 5. Multi-Repo Data Architecture & State Management (Prisma)

To safely track PRs, handle branch collisions, and orchestrate cross-repo epics, we formalize our database using Prisma v7.

### 5.1 Prisma Data Model (Relational Domain Schema & RBAC)

This schema adds User tracking for RBAC and executorImage to support custom execution environments per repository.

```prisma
// schema.prisma
generator client {
  provider        = "prisma-client"
  previewFeatures = ["tracing"]
  // Note: postgresqlExtensions preview feature is deprecated in v7.x.
  // Extensions are now configured via the Prisma config file.
}

datasource db {
  provider   = "postgresql"
  extensions = [vector]
}

// --- RBAC: User Identity & Roles ---
model User {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email          String    @unique
  slackId        String?   @unique @map("slack_id")
  role           String    @default("ENGINEER") // ADMIN, LEAD, ENGINEER
  isActive       Boolean   @default(true) @map("is_active")

  @@map("users")
}

// --- Repository Configuration ---
model Repository {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationName String           @map("organization_name")
  repoName         String           @map("repo_name")
  defaultBranch    String           @default("main") @map("default_branch")
  mcpServerRef     String           @map("mcp_server_ref")

  // Custom Docker image containing internal tools/certs/npm registries
  executorImage    String?          @default("node:20-alpine") @map("executor_image")
  isActive         Boolean          @default(true) @map("is_active")

  activeWorkflows  ActiveWorkflow[]
  pullRequests     PullRequest[]
  agentLessons     AgentLesson[]

  @@unique([organizationName, repoName])
  @@map("repositories")
}

model WorkRequest {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  externalTicketId String           @map("external_ticket_id")
  requestPayload   String           @map("request_payload")
  slackMessageTs   String?          @map("slack_message_ts")
  isCrossRepo      Boolean          @default(false) @map("is_cross_repo")
  createdAt        DateTime         @default(now()) @map("created_at") @db.Timestamptz

  contextSnapshot  ContextSnapshot?
  activeWorkflows  ActiveWorkflow[]

  @@map("work_requests")
}

model ContextSnapshot {
  id               String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  workRequestId    String       @unique @map("work_request_id") @db.Uuid
  workRequest      WorkRequest  @relation(fields: [workRequestId], references: [id], onDelete: Cascade)

  rawJiraEpic      Json?        @map("raw_jira_epic")
  rawConfluence    Json?        @map("raw_confluence")
  successCriteria  String[]     @map("success_criteria")

  capturedAt       DateTime     @default(now()) @map("captured_at") @db.Timestamptz

  @@map("context_snapshots")
}

model ActiveWorkflow {
  id                 String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  temporalWorkflowId String         @unique @map("temporal_workflow_id")
  parentWorkflowId   String?        @map("parent_workflow_id")

  workRequestId      String?        @map("work_request_id") @db.Uuid
  workRequest        WorkRequest?   @relation(fields: [workRequestId], references: [id])

  repoId             String?        @map("repo_id") @db.Uuid
  repository         Repository?    @relation(fields: [repoId], references: [id])

  // PLANNING, IMPLEMENTING, IN_REVIEW, AWAITING_CI, AWAITING_HUMAN_MERGE, COMPLETED
  currentStatus      String         @map("current_status")
  assignedBranch     String?        @map("assigned_branch")
  updatedAt          DateTime       @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  pullRequests       PullRequest[]
  agentLessons       AgentLesson[]

  @@map("active_workflows")
}

model PullRequest {
  id              String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  workflowId      String?         @map("workflow_id") @db.Uuid
  workflow        ActiveWorkflow? @relation(fields: [workflowId], references: [id])

  repoId          String?         @map("repo_id") @db.Uuid
  repository      Repository?     @relation(fields: [repoId], references: [id])

  prNumber        Int?            @map("pr_number")
  headSha         String          @map("head_sha")
  status          String          // OPEN, MERGED, CONFLICT
  ciStatus        String          @default("PENDING") @map("ci_status")

  @@map("pull_requests")
}

// Appended to schema.prisma (Semantic Memory)
model AgentLesson {
  id              String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  workflowId      String?         @map("workflow_id") @db.Uuid
  workflow        ActiveWorkflow? @relation(fields: [workflowId], references: [id])
  repoId          String?         @map("repo_id") @db.Uuid
  repository      Repository?     @relation(fields: [repoId], references: [id])

  rationale       String
  lessonSummary   String          @map("lesson_summary")
  embedding       Unsupported("vector(1536)")?
  failureType     String?         @map("failure_type")
  metadata        Json?
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz

  @@map("agent_lessons")
}
```

### 5.2 Embedding Pipeline & Semantic Memory Retrieval

The `AgentLesson` table stores vector embeddings alongside structured metadata. This section defines exactly how embeddings are generated, indexed, and retrieved.

#### Embedding Generation

Embeddings are generated at two points in the lifecycle:

1. **On lesson creation** (`commitToMemory` activity, after workflow completion)
2. **On lesson retrieval** (query-time embedding of the search text)

```typescript
// lib/embeddings.ts
import OpenAI from 'openai';

const openai = new OpenAI(); // Uses OPENAI_API_KEY from env

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1536;

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}
```

**Why `text-embedding-3-large`:** At 1536 dimensions it provides the best retrieval accuracy among OpenAI embedding models. The `dimensions` parameter allows future reduction (e.g., 512) for cost/speed tradeoff without re-embedding.

#### Database Index

The HNSW index is created via a Prisma migration (raw SQL, since pgvector is not natively supported by Prisma v7):

```sql
-- migrations/XXXX_add_hnsw_index.sql
CREATE INDEX idx_agent_lessons_embedding
  ON agent_lessons
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

**Index parameters:**
- `m = 16`: Each node connects to 16 neighbors. Balances recall vs. index size.
- `ef_construction = 200`: Build-time beam width. Higher = better recall, slower build. 200 is suitable for <100K lessons.
- `vector_cosine_ops`: Cosine similarity operator class (normalized comparison).

#### Similarity Search (Retrieval)

Used by the Context Validator and Planner agents to inject historical lessons into their context.

```typescript
// lib/lessonRetrieval.ts
import { prisma } from '../db';
import { generateEmbedding } from './embeddings';

interface RetrievedLesson {
  id: string;
  lessonSummary: string;
  failureType: string | null;
  similarity: number;
  createdAt: Date;
}

export async function retrieveSimilarLessons(
  queryText: string,
  repoId: string,
  limit: number = 5,
  similarityThreshold: number = 0.7
): Promise<RetrievedLesson[]> {
  const queryEmbedding = await generateEmbedding(queryText);

  // pgvector cosine distance: 1 - cosine_similarity
  // Lower distance = higher similarity
  const lessons = await prisma.$queryRaw<RetrievedLesson[]>`
    SELECT
      id,
      lesson_summary AS "lessonSummary",
      failure_type AS "failureType",
      1 - (embedding <=> ${queryEmbedding}::vector) AS similarity,
      created_at AS "createdAt"
    FROM agent_lessons
    WHERE repo_id = ${repoId}::uuid
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ${queryEmbedding}::vector) >= ${similarityThreshold}
    ORDER BY embedding <=> ${queryEmbedding}::vector ASC
    LIMIT ${limit}
  `;

  return lessons;
}
```

**Retrieval strategy:**
- **Scope:** Lessons are filtered by `repo_id` first (relational filter), then ranked by cosine similarity. This ensures the Planner only sees lessons relevant to the repository it's working on.
- **Threshold:** 0.7 cosine similarity minimum. Below this, lessons are too dissimilar to be useful and may inject noise.
- **Limit:** Default 5 lessons. This keeps the injected context small (~2-3KB) while covering the most relevant historical failures.
- **Injection point:** Retrieved lessons are included in the `ContextSnapshot.historicalLessons` field and passed to both the Planner and Implementer agents as part of their system context.

#### Embedding Lifecycle

| Event | Action | Who Generates |
|---|---|---|
| Workflow completes (success or failure) | Memory Agent summarizes workflow → `generateEmbedding(summary)` → INSERT into `agent_lessons` | `commitToMemory` activity |
| Human rejects PR with feedback | Feedback text → `generateEmbedding(feedback)` → INSERT into `agent_lessons` with `failureType: 'REVIEW_REJECTION'` | Gateway webhook handler |
| Context Validator runs | `generateEmbedding(successCriteria.join(' '))` → query `agent_lessons` → inject into `ContextSnapshot.historicalLessons` | `executeImplementation` activity |
| Admin deletes lesson | DELETE from `agent_lessons` WHERE id = :id (embedding removed with row) | Gateway API (`DELETE /api/v1/lessons/:id`) |

## 6. Security, Guardrails, & Workspace Isolation

To ensure system stability, the agentic system acts purely as an orchestrator and worker—it must never modify its own source code or bypass human QA workflows.

### 6.1 Ephemeral Workspace & Custom Executors (Anti-Self-Modification)

Jira tickets trigger work strictly within isolated clones of Target Repositories.

- **Custom Executor Images:** Instead of a generic environment, the K8s Job dynamically pulls the pre-configured Docker image specified in `Repository.executorImage`. This allows the agent to immediately execute `npm install` or `mvn test` using internal corporate registries, pre-cached certificates, and specific language versions without complex setup scripting.
- **Volume Sandboxing:** The MCP tools configured for the agent are hard-chrooted to `/workspace/target-repo`. The agent cannot traverse up the file tree to read host node configuration or the agent framework source code.
- **Just-In-Time (JIT) Credential Scoping:** The agent is never provided global admin GitHub tokens. The Control Plane generates a short-lived, repository-scoped Installation Access Token permitting only read/write access to the assigned branch.

### 6.2 The TDD (Test-Driven Development) Loop

LLM code generation can be syntactically perfect but functionally broken.

- The Implementer Agent is strictly instructed to write unit and integration tests based on the repository's native testing framework (e.g., Jest, PyTest) before asking for a review.
- The agent uses its bash MCP tool to run the tests in the DinD sandbox. It reads the standard output/error, and iteratively fixes its own code until the test suite is green.

### 6.3 Mastra Security Review Processor

The `SecurityReviewProcessor` acts as an inescapable, real-time middleware for Implementation agents.

1. **Intercept Phase:** Every Mastra MCP tool call to `writeFile` or `editFile` triggers this output processor.
2. **Audit Phase:** A `claude-opus-4-6` model compares the requested code diff against the "Security Guideline" dataset.
3. **Self-Correction Phase:** If a violation is detected (e.g., SQL Injection risk), the processor denies the write access and returns a retry instruction forcing immediate remediation.

## 7. Interaction Gateway & Role-Based Access Control (RBAC)

The Interaction Gateway exposes a RESTful API to manage the lifecycle of automated workflows. To prevent unauthorized actions, all inbound requests (API or Slack) pass through an RBAC middleware mapped to the `User` Prisma table.

### 7.1 Authentication & Session Strategy

All API requests (except webhooks, which use HMAC signature verification) require a Bearer JWT in the `Authorization` header.

- **Token issuance:** `POST /api/v1/auth/login` accepts email + password or a Slack OAuth callback. Returns a signed JWT (RS256, 1h expiry) containing `{ sub: userId, role: 'ADMIN' | 'LEAD' | 'ENGINEER', slackId?: string }`.
- **Token refresh:** `POST /api/v1/auth/refresh` accepts a refresh token (7d expiry, stored hashed in DB) and returns a new JWT.
- **Slack ID resolution:** When a request arrives from a Slack interactive webhook, the Gateway resolves `slack_id` from the signed Slack payload → looks up the `User` record → extracts the role. No JWT is involved for Slack-originated actions.

### 7.2 RBAC Permission Matrix

| Action | Endpoint | ADMIN | LEAD | ENGINEER |
|---|---|---|---|---|
| Submit work request | `POST /api/v1/work-requests` | Y | Y | Y |
| Trigger epic orchestration | `POST /api/v1/epics` | Y | Y | N |
| Approve architectural plan | `POST /api/v1/workflows/:id/approve` | Y | Y | N |
| View workflow status | `GET /api/v1/workflows/:id` | Y | Y | Y |
| List all workflows | `GET /api/v1/workflows` | Y | Y | Y |
| Terminate workflow | `DELETE /api/v1/workflows/:id` | Y | N | N |
| Retry failed CI | `POST /api/v1/workflows/:id/retry-ci` | Y | Y | N |
| Onboard repository | `POST /api/v1/repositories` | Y | N | N |
| Manage users/roles | `POST /api/v1/users` | Y | N | N |
| Delete memory embeddings | `DELETE /api/v1/lessons/:id` | Y | N | N |
| View agent lessons | `GET /api/v1/lessons` | Y | Y | Y |

### 7.3 Gateway API Specification

All responses follow a standard envelope:

```typescript
interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
  meta?: { page: number; pageSize: number; total: number };
}
```

**Work Requests:**

```
POST /api/v1/work-requests
  Body: { externalTicketId: string, repoIds: string[], slackChannel?: string }
  Response: ApiResponse<{ workRequestId: string, workflowIds: string[] }>
  RBAC: ENGINEER+
```

**Epic Orchestration:**

```
POST /api/v1/epics
  Body: { externalTicketId: string, repoIds: string[], dependencyGraph: { repoId: string, dependsOn: string[] }[] }
  Response: ApiResponse<{ epicWorkflowId: string, childWorkflowIds: Record<string, string> }>
  RBAC: LEAD+
```

**Workflow Management:**

```
GET    /api/v1/workflows                    → ApiResponse<ActiveWorkflow[]>           RBAC: ENGINEER+
GET    /api/v1/workflows/:id                → ApiResponse<ActiveWorkflow & { pullRequests: PullRequest[], agentLessons: AgentLesson[] }>  RBAC: ENGINEER+
POST   /api/v1/workflows/:id/approve        → ApiResponse<{ approved: true }>         RBAC: LEAD+
POST   /api/v1/workflows/:id/retry-ci       → ApiResponse<{ signalSent: true }>       RBAC: LEAD+
DELETE /api/v1/workflows/:id                → ApiResponse<{ terminated: true }>       RBAC: ADMIN
```

**Repository Management:**

```
GET    /api/v1/repositories                 → ApiResponse<Repository[]>               RBAC: ENGINEER+
POST   /api/v1/repositories                 → ApiResponse<Repository>                 RBAC: ADMIN
  Body: { organizationName: string, repoName: string, defaultBranch?: string, mcpServerRef: string, executorImage?: string }
PATCH  /api/v1/repositories/:id             → ApiResponse<Repository>                 RBAC: ADMIN
```

**User Management:**

```
GET    /api/v1/users                        → ApiResponse<User[]>                     RBAC: ADMIN
POST   /api/v1/users                        → ApiResponse<User>                       RBAC: ADMIN
  Body: { email: string, slackId?: string, role: 'ADMIN' | 'LEAD' | 'ENGINEER' }
PATCH  /api/v1/users/:id                    → ApiResponse<User>                       RBAC: ADMIN
```

**Agent Lessons (Memory):**

```
GET    /api/v1/lessons                      → ApiResponse<AgentLesson[]>              RBAC: ENGINEER+
GET    /api/v1/lessons/search               → ApiResponse<AgentLesson[]>              RBAC: ENGINEER+
  Query: { q: string, repoId?: string, limit?: number }  (semantic similarity search)
DELETE /api/v1/lessons/:id                  → ApiResponse<{ deleted: true }>          RBAC: ADMIN
```

### 7.4 Webhook Endpoints

Webhook endpoints use HMAC-SHA256 signature verification (no JWT). The secret is configured per integration.

**1. CI/CD Pipeline Webhook:**

```
POST /api/v1/webhooks/ci
  Headers: X-Hub-Signature-256: sha256=<hmac>
  Body: GitHub Actions check_run or check_suite event payload
  Behavior:
    1. Verify HMAC signature against stored webhook secret
    2. Extract repo, branch, conclusion, and logs_url from payload
    3. Look up ActiveWorkflow by (repoId, assignedBranch)
    4. Fire ciPipelineSignal({ passed: conclusion === 'success', logsUrl })
    5. Return 200 OK (idempotent — duplicate signals are safe)
```

**2. Git Provider Merge Webhook:**

```
POST /api/v1/webhooks/git
  Headers: X-Hub-Signature-256: sha256=<hmac>
  Body: GitHub pull_request event payload (action: 'closed', merged: true)
  Behavior:
    1. Verify HMAC signature
    2. Extract repo, PR number, merge commit SHA
    3. Look up ActiveWorkflow via PullRequest.prNumber + repoId
    4. Fire humanMergeSignal(true)
    5. Update PullRequest.status → 'MERGED'
```

**3. Slack Interactive Webhook:**

```
POST /api/v1/webhooks/slack
  Headers: X-Slack-Signature, X-Slack-Request-Timestamp
  Body: Slack interaction payload (button click, modal submission)
  Behavior:
    1. Verify Slack request signature (v0 signing secret)
    2. Resolve User by slack_id → check role against required action
    3. If role insufficient: return ephemeral error message to Slack
    4. If role sufficient: fire appropriate Temporal signal (approve plan, retry CI, etc.)
    5. Update Slack message to reflect action taken
```

### 7.5 Standard Error Responses

```typescript
// 400 Bad Request
{ error: { code: 'VALIDATION_ERROR', message: 'repoIds must contain at least one repository' } }

// 401 Unauthorized
{ error: { code: 'AUTH_REQUIRED', message: 'Missing or expired Bearer token' } }

// 403 Forbidden
{ error: { code: 'INSUFFICIENT_ROLE', message: 'LEAD role required to approve architectural plans' } }

// 404 Not Found
{ error: { code: 'WORKFLOW_NOT_FOUND', message: 'No active workflow with id abc-123' } }

// 409 Conflict
{ error: { code: 'WORKFLOW_ALREADY_EXISTS', message: 'An active workflow already exists for this branch' } }

// 429 Too Many Requests
{ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Retry after 30s' }, meta: { retryAfter: 30 } }
```

## 8. Web Interface & Admin Control Center

Built with Next.js and Tailwind CSS, this dashboard consumes the Interaction Gateway API to provide deep visibility and administrative control over the agentic workforce.

- **Epic Visualizer:** A real-time node graph depicting the Parent `CrossRepoEpicWorkflow` and its cascading Child Workflows.
- **Context Inspector:** A read-only view of the immutable `ContextSnapshot`.
- **RBAC Policy Editor (Admins Only):** Interface for mapping new engineers and assigning their roles.
- **Repository Onboarding:** Interface to register new repositories, configure their specific `defaultBranch`, and specify their `executorImage`.

## 9. Infrastructure & Deployment (Local Lab)

```yaml
version: '3.8'
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: engineering_system
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"

  temporal:
    image: temporalio/auto-setup:1.25.2
    depends_on:
      - postgres
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=postgres
      - POSTGRES_PWD=password
      - POSTGRES_SEEDS=postgres
    ports:
      - "7233:7233"
      - "8233:8233"

  otel-collector:
    image: otel/opentelemetry-collector:latest
    volumes:
      - ./otel-config.yaml:/etc/otel-config.yaml
    command: ["--config=/etc/otel-config.yaml"]
    ports:
      - "4317:4317"
      - "4318:4318"

  web-dashboard:
    build: ./web
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://interaction-gateway:8080
    depends_on:
      - interaction-gateway

  interaction-gateway:
    build: ./gateway
    ports:
      - "8080:8080"
    depends_on:
      - postgres
      - temporal
    environment:
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/engineering_system
      - TEMPORAL_ADDRESS=temporal:7233

  agent-worker:
    build: ./worker
    environment:
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/engineering_system
      - TEMPORAL_ADDRESS=temporal:7233
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
```

## 10. Agent Operating Instructions (Advanced System Prompts)

### 10.1 The Implementer Agent (Surgical Coder & Tester)

**(Model: claude-opus-4-6)**

> "You are a highly constrained Surgical Coder operating within a customized, isolated repository environment. Execute the plan.md exactly as written. TDD MANDATE: Before submitting your code for review, you MUST write corresponding unit/integration tests and execute them using the bash MCP tool. You must iteratively fix your code until your test suite passes. Adhere perfectly to the injected 'Global Guidelines' and refer to the Semantic Registry for any cross-repo API contracts. If your output is rejected by any Review Processor or the external CI/CD pipeline, do not attempt to justify your code. Read the logs and immediately refactor to comply."

### 10.2 The Context Validator (Global Analyst)

**(Model: gemini-2.5-pro)**

> "You are the Global Context Validator. Trace all dependencies across Jira and Confluence. You must extract an exhaustive list of explicit 'Success Criteria' from these documents. These extracted criteria will form the immutable Context Snapshot."

### 10.3 The Epic Planner Agent (System Architect)

**(Model: claude-opus-4-6)**

> "You are the Lead System Architect orchestrating a multi-repo Epic. Analyze the provided ticket, the cross-repo codebase schemas, and the immutable 'Context Snapshot'. Your execution graph must strictly map to the 'Success Criteria'. Carefully review the 'Historical Failures' section to circumvent known integration pitfalls."

### 10.4 The Domain Logic & Correctness Reviewer

**(Model: claude-opus-4-6)**

> "You are the QA and Domain Logic Lead. You have been provided the immutable 'Context Snapshot'. Treat this array as a strict checklist. If you cannot conclusively verify that the PR satisfies every single criterion from the snapshot, reject the code."

### 10.5 The Security Auditor Agent

**(Model: claude-opus-4-6)**

> "You are the merciless Security Auditor. Review the diffs produced by the Implementer Agent. Your sole priority is identifying vulnerabilities. If you find a High or Critical severity issue, reject the code and provide the imperative instruction on how to fix it."

