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

### 3.2 Agent-to-Agent Data Flow & Typed Interfaces

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
import { workflowInfo, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type * as activities from './activities';

// Signal to receive payload from external CI/CD webhook (e.g. GitHub Actions)
export const ciPipelineSignal = defineSignal<{ passed: boolean, logsUrl?: string }>('ciPipelineSignal');
// Signal to confirm a human has merged the PR
export const humanMergeSignal = defineSignal<boolean>('humanMergeSignal');

export async function EngineeringWorkflow(request: RepoWorkRequest): Promise<WorkflowResult> {
  const { workflowId, parent } = workflowInfo();
  let ciResult: { passed: boolean, logsUrl?: string } | null = null;
  let humanMerged = false;

  setHandler(ciPipelineSignal, (payload) => { ciResult = payload; });
  setHandler(humanMergeSignal, () => { humanMerged = true; });

  await activities.updateDomainState(workflowId, 'IMPLEMENTING', request.repoId);

  // 1. Implementation Phase (Includes local TDD Loop)
  // The Custom Executor Image provisions. Agent writes code AND unit tests.
  // It runs `npm run test` locally and loops until tests pass before returning.
  let codeResult = await activities.executeImplementation(request.planOverride, request.contextSnapshotId);

  let isReadyForMerge = false;

  while (!isReadyForMerge) {
      await activities.updateDomainState(workflowId, 'IN_REVIEW', request.repoId);

      // 2. Internal Review Loop (Security, Style, Domain, Performance)
      const reviewResult = await activities.runReviewNetwork(codeResult, request.contextSnapshotId);

      // 3. Open PR & Await External CI/CD Pipeline
      await activities.updateDomainState(workflowId, 'AWAITING_CI', request.repoId);
      const prData = await activities.createOrUpdatePullRequest(reviewResult);

      // Workflow suspends without consuming resources until Jenkins/GitHub Actions finishes
      await condition(() => ciResult !== null);

      if (ciResult!.passed) {
          isReadyForMerge = true;
      } else {
          // 4. CI/CD Fix Loop
          await activities.postSlackThreadAudit(workflowId, `❌ External CI failed. Reading logs and retrying implementation...`);
          const failedLogs = await activities.fetchCILogs(ciResult!.logsUrl);
          codeResult = await activities.executeCIFixImplementation(failedLogs, codeResult);
          ciResult = null; // Reset for next iteration
      }
  }

  // 5. Hand-off to Human Engineers
  // The agent NEVER calls the merge API. It respects existing branch protection rules.
  await activities.updateDomainState(workflowId, 'AWAITING_HUMAN_MERGE', request.repoId);
  await activities.notifyHumanGate(request.slackChannel, "PR is green and awaiting human review/merge.", 'PR_READY');

  // Workflow suspends until the GitHub webhook confirms a human clicked "Merge"
  await condition(() => humanMerged === true);

  // 6. Memory Commit
  // Summarizes the entire cycle (including CI failures) into pgvector
  await activities.commitToMemory(workflowId, request.repoId);

  await activities.updateDomainState(workflowId, 'COMPLETED', request.repoId);
  return { status: 'SUCCESS', apiContractsChanged: true };
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

### 7.1 RBAC Matrices

- **ADMIN:** Can onboard repositories, modify global guidelines, manually terminate workflows, and delete vector embeddings from the memory layer.
- **LEAD:** Can trigger Epic Workflows, approve architectural plans via Slack/Web, and force a retry on a failed CI/CD pipeline.
- **ENGINEER:** Can view workflow status, read agent thought threads, and review PRs, but cannot bypass the architectural approval gates.

### 7.2 Webhooks (Slack & External CI/CD)

**1. Slack Interactive Webhook (HITL):**

When a user clicks [Approve] on a Slack message, the Gateway checks the user's `slack_id` against the `User` table. If the role is insufficient (e.g., Engineer trying to approve a Core Architecture Epic), the Gateway rejects the request with an ephemeral error message in Slack.

**2. CI/CD Webhook Handler:**

Listens for payload events from GitHub Actions / GitLab CI.

- **Endpoint:** `POST /api/v1/webhooks/ci`
- **Behavior:** If the payload indicates a build failure for an agent-owned branch, the Gateway locates the running Temporal Workflow and fires the `ciPipelineSignal` with `passed: false` and the logs URL, waking the agent up to fix the code.

**3. Git Provider Webhook (Human Merge Gate):**

The system relies on human engineers and existing repository branch protection rules (e.g., "Requires 1 human approval," "Requires passing tests") for the final merge.

- **Behavior:** When a human clicks "Squash and Merge" in the GitHub UI, the webhook fires. The Gateway sends the `humanMergeSignal` to the Temporal workflow, allowing the Epic Orchestrator to officially mark the Epic as 'DONE' and trigger the Memory Agent.

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

