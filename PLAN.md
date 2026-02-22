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

## 2. Architectural Design & Boundaries

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
| Data Access / ORM | Prisma v7 | Rationale: Provides strict, end-to-end type safety for Postgres, mapping directly to pgvector and OTel tracing. |
| Memory Store | PostgreSQL 17 + pgvector | Rationale: Unifies relational metadata and high-dimensional vector embeddings via pgvectorscale and HNSW indexes. |
| Web UI / Dashboard | Next.js (React) + Tailwind | Rationale: Provides a fast, real-time SPA for tracking Temporal workflow states, administrating agent memory, and managing RBAC. |
| Observability | OpenTelemetry (OTel) | Rationale: Traces every token generated, tool called, and reasoning step taken. Exports to Langfuse or SigNoz. |
| Execution Isolation | Kubernetes + KEDA + DinD | Rationale: Workflows launch ephemeral K8s Jobs. DinD allows execution of repository-specific test suites inside custom container images. |
| Tooling Layer | Model Context Protocol (MCP) | Rationale: Standardizes how agents interact with the outside world (GitHub, Jira, bash). |

### 3.1 Unrestricted LLM Model Strategy (Best-in-Class Allocation)

| Agent / Task | Recommended LLM | Rationale & Strengths |
|---|---|---|
| Context Validator | gemini-3-pro | Massive Context: Ingests entire monorepos, multiple microservices, and sprawling Jira epics simultaneously. |
| Planner Agent | gpt-5.1 | Architectural Supremacy: Capable of designing robust, multi-repo architectures and sequential dependency graphs. |
| Implementer Agent | claude-4.6-sonnet | Surgical Coding & Tool Mastery: The absolute best model available for strictly obeying complex MCP JSON schemas and executing TDD loops in bash. |
| Security Auditor | gpt-5.1 | Adversarial Simulation: Acts as a relentless, zero-hallucination processor gate to intercept injection flaws. |
| Domain Logic Reviewer | claude-4.6-opus | Deep QA & Edge Cases: Renowned for nuanced understanding of complex business requirements. Acts as QA lead. |
| Performance Reviewer | gpt-5.2-codex | Algorithmic Specialization: Specialized for deep AST parsing and identifying Big-O inefficiencies. |
| Interaction Gateway | gpt-4.5-mini | Low Latency Classification: Used strictly for classifying incoming intent and parsing CI/CD logs quickly. |

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
  previewFeatures = ["postgresqlExtensions", "tracing"]
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
2. **Audit Phase:** A gpt-5.1 model compares the requested code diff against the "Security Guideline" dataset.
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
    image: temporalio/admin-tools:1.22.0
    depends_on:
      - postgres
    ports:
      - "7233:7233"
      - "8080:8080"

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

  interaction-gateway:
    build: ./gateway
    ports:
      - "8080:8080"
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

**(Model: claude-4.6-sonnet)**

> "You are a highly constrained Surgical Coder operating within a customized, isolated repository environment. Execute the plan.md exactly as written. TDD MANDATE: Before submitting your code for review, you MUST write corresponding unit/integration tests and execute them using the bash MCP tool. You must iteratively fix your code until your test suite passes. Adhere perfectly to the injected 'Global Guidelines' and refer to the Semantic Registry for any cross-repo API contracts. If your output is rejected by any Review Processor or the external CI/CD pipeline, do not attempt to justify your code. Read the logs and immediately refactor to comply."

### 10.2 The Context Validator (Global Analyst)

**(Model: gemini-3-pro)**

> "You are the Global Context Validator. Trace all dependencies across Jira and Confluence. You must extract an exhaustive list of explicit 'Success Criteria' from these documents. These extracted criteria will form the immutable Context Snapshot."

### 10.3 The Epic Planner Agent (System Architect)

**(Model: gpt-5.1)**

> "You are the Lead System Architect orchestrating a multi-repo Epic. Analyze the provided ticket, the cross-repo codebase schemas, and the immutable 'Context Snapshot'. Your execution graph must strictly map to the 'Success Criteria'. Carefully review the 'Historical Failures' section to circumvent known integration pitfalls."

### 10.4 The Domain Logic & Correctness Reviewer

**(Model: claude-4.6-opus)**

> "You are the QA and Domain Logic Lead. You have been provided the immutable 'Context Snapshot'. Treat this array as a strict checklist. If you cannot conclusively verify that the PR satisfies every single criterion from the snapshot, reject the code."

### 10.5 The Security Auditor Agent

**(Model: gpt-5.1)**

> "You are the merciless Security Auditor. Review the diffs produced by the Implementer Agent. Your sole priority is identifying vulnerabilities. If you find a High or Critical severity issue, reject the code and provide the imperative instruction on how to fix it."

