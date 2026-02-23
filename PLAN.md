# Autonomous Agentic Engineering System (v19.0 - TDD, CI/CD, & RBAC)

## 1. System Overview & Purpose

This system defines a production-grade, deterministic architecture for an autonomous, agent-driven software engineering workflow. It addresses the "last mile" of engineering automation by moving beyond simple code generation into a fully integrated, self-healing, and self-improving ecosystem.

The system is designed to ingest ambiguous work requests from platforms like Slack or any issue tracker (Jira, Linear, GitHub Issues), validate context through deep codebase awareness, execute precise implementation plans in isolated environments, and continuously refine its own performance through a "Lessons Learned" semantic memory layer.

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

> **Dedicated MVP documents:**
> - **[docs/mvp-architecture.md](docs/mvp-architecture.md)** — MVP architecture, component design, data flow, and design rationale
> - **[docs/mvp-implementation.md](docs/mvp-implementation.md)** — Step-by-step implementation guide with project structure, code, and build order

**Delivers:**
- PostgreSQL + pgvector database with Prisma schema (Users, Teams, TeamMemberships, Repositories, WorkRequests, ActiveWorkflows, PullRequests)
- Team + TeamMembership tables and nullable Repository.teamId FK (tables only — no RBAC enforcement)
- Seed: "Default Team" with admin user and sample repository assigned
- Temporal server + single worker process
- `EngineeringWorkflow` (child workflow only — no parent orchestrator)
- Implementer Agent (Mastra + `claude-opus-4-6`) with bash and GitHub MCP tools
- Local TDD loop (agent writes tests, runs them in DinD, iterates until green)
- `createOrUpdatePullRequest` activity via GitHub API
- Human merge signal webhook (`POST /api/v1/webhooks/git`)
- CLI trigger (`POST /api/v1/work-requests`) with hardcoded ADMIN role
- Docker Compose for local development (Postgres, Temporal, Gateway, Worker)

**Does NOT include:** Multi-repo epics, review network, CI/CD webhook listener, Slack integration, Web UI, RBAC enforcement (including team-scoped RBAC), semantic memory.

**Exit criteria:** An external ticket ID submitted via CLI produces a green PR on a target repository, and the workflow completes when a human merges it.

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
- Team CRUD + membership API endpoints (`/api/v1/teams`, `/api/v1/teams/:id/members`)
- Team-scoped RBAC middleware (`requiredTeamRole`) — dual-layer permission model (platform role + team role)
- Team filtering on existing list endpoints (workflows, repositories, lessons)
- Repository.teamId enforcement (non-null)
- Slack approval gates (role-checked: only LEAD/ADMIN can approve architecture plans)
- Human merge gate with Slack notification

**Exit criteria:** A multi-repo epic submitted via Slack produces PRs across 2+ repositories in dependency order, with Slack-based architectural approval from a LEAD role.

### Phase 4: Semantic Memory + Web Dashboard + Production Hardening

**Goal:** Close the learning loop and provide operational visibility.

**Delivers:**
- Memory Agent that summarizes workflow outcomes (rejections, CI failures, fixes) into `AgentLesson` embeddings
- Embedding pipeline (text-embedding-3-large via OpenAI, HNSW index, cosine similarity search)
- Lesson retrieval injected into Planner and Implementer agent context
- Next.js Web Dashboard (Epic Visualizer, Context Inspector, RBAC Policy Editor, Repository Onboarding, Teams List + Team Detail pages, team selector in sidebar/top bar, team columns in tables)
- KEDA autoscaling for agent worker pods
- Custom Executor Image build pipeline (GitHub Actions + ECR)
- Cost tracking and per-workflow token budget enforcement

**Exit criteria:** The Planner Agent retrieves relevant historical lessons when generating a new plan, and the dashboard shows real-time workflow state for all active epics.

## 3. Architectural Design & Boundaries

The architecture strictly enforces the separation of concerns by bifurcating the system into a **Control Plane** (Orchestration, State, and Memory) and an **Execution Plane** (Ephemeral, stateless agent activities).

> **Critical Boundary:** The Control Plane code and the Execution Plane code are completely distinct from the "Target Repositories." Agents operate in an isolated vacuum, completely unaware of the host system running them.

### 3.1 Extended Component Diagram

```
                               ┌───────────────────────────────────────────┐
                               │           EXTERNAL TRIGGER LAYER          │
                               │  [ Slack App ]  [ Issue Tracker ] [ CLI ]  │
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
│  │   │ (Summarizer) │                       └────────┬────────┘       │  e.g., node-24-   │  │  │
│  │   └──────────────┘                                │                │  internal-reg)    │  │  │
│  │          ▲                                        ▼                └───────────────────┘  │  │
│  │          │                               ┌─────────────────┐                              │  │
│  │          └───────────────────────────────┤ Internal Review │                              │  │
│  │                                          │ Network (x4)    │                              │  │
│  │                                          └─────────────────┘                              │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 4. Tech Stack & Engineering Decisions

| Component | Technology | Decision Rationale & Deep Technical Implications |
|---|---|---|
| HTTP Framework | Fastify 5.x | Rationale: High-performance, schema-first HTTP framework with built-in validation (JSON Schema / Zod via type providers), plugin-based architecture, and encapsulated error handling. ~3x throughput vs Express with lower latency. |
| Package Manager | Yarn 4.x (Berry) | Rationale: Non-zero-installs mode (`nodeLinker: node-modules`) for maximum tool compatibility. `workspace:` protocol for monorepo package references. Corepack-managed for reproducible installs. |
| Orchestration | Temporal.io | Rationale: Handles complex, multi-day parent/child workflows and asynchronous signal waiting (e.g., waiting for GitHub Actions to complete). |
| Agent Framework | Mastra 1.0 (TypeScript) | Rationale: The most robust, pure TS framework for creating deterministic agent networks. |
| Data Access / ORM | Prisma v7.x | Rationale: Rust-free TS-native architecture (90% smaller bundle, 3x faster queries). Provides strict, end-to-end type safety for Postgres with OTel tracing. pgvector columns require raw SQL/TypedSQL (native support pending). |
| Memory Store | PostgreSQL 17 + pgvector | Rationale: Unifies relational metadata and high-dimensional vector embeddings via pgvectorscale and HNSW indexes. |
| Web UI / Dashboard | Next.js 16 + React 19 + Tailwind CSS 4 + shadcn/ui + Radix UI + TanStack Query + Zustand + Recharts | Rationale: Provides a fast, real-time SPA for tracking Temporal workflow states, administrating agent memory, and managing RBAC. shadcn/ui provides accessible, customizable components; TanStack Query handles server state with caching/refetch; Zustand for lightweight client state. |
| Observability | OpenTelemetry (OTel) | Rationale: Traces every token generated, tool called, and reasoning step taken. Exports to Langfuse or SigNoz. |
| Execution Isolation | Kubernetes + KEDA + DinD | Rationale: Workflows launch ephemeral K8s Jobs. DinD allows execution of repository-specific test suites inside custom container images. |
| Tooling Layer | Model Context Protocol (MCP) | Rationale: Standardizes how agents interact with the outside world (GitHub, issue trackers, bash). |

### 4.1 LLM Model Strategy (Best-in-Class Allocation)

| Agent / Task | Model ID | Context Window | Rationale & Strengths | Fallback |
|---|---|---|---|---|
| Context Validator | `gemini-2.5-pro` | 1M tokens | Massive Context: 100% recall up to 530K tokens, 99.7% at 1M. Natively handles text, code, and images in a single pass — ideal for ingesting entire monorepos, issue tracker epics, and documentation simultaneously. 64K output cap enables comprehensive context snapshots in one shot. | `claude-opus-4-6` (1M beta) |
| Planner Agent | `claude-opus-4-6` | 200K (1M beta) | Architectural Reasoning: 80.8% on SWE-Bench Verified — strongest score for real-world multi-file reasoning. Adaptive thinking mode dynamically allocates compute to architecturally complex reasoning steps. Plans more carefully and sustains agentic tasks for longer in large codebases. | `gpt-5` (400K context) |
| Implementer Agent | `claude-opus-4-6` | 200K (1M beta) | Surgical Coding & TDD: 80.8% SWE-Bench, 128K output token limit (writes substantial patches + full test suites in one generation). Best-in-class MCP JSON schema adherence and tool call accuracy. Self-corrects during multi-turn TDD loops. | `gpt-5` |
| Security Auditor | `claude-opus-4-6` | 200K | Adversarial Simulation: Autonomously discovered 500+ validated high-severity vulnerabilities across major OSS libraries with zero hallucinated CVEs. MRCR v2 score of 76% for multi-file diff analysis. Lowest hallucination rate on code review tasks. | `gpt-5` |
| Domain Logic Reviewer | `claude-opus-4-6` | 200K | Deep QA & Edge Cases: MRCR v2 leader for nuanced multi-file reasoning. Adaptive thinking mode enables extended deliberation on ambiguous business logic edge cases. Acts as QA lead. | `gemini-2.5-pro` |
| Performance Reviewer | `gpt-5.2` ¹ | 400K | Algorithmic Specialization: 100% on AIME 2025 — strongest mathematical/algorithmic reasoning benchmark. Deep AST parsing, Big-O analysis, and loop bound correctness. 400K context comfortably holds full file ASTs alongside diffs. | `claude-opus-4-6` |
| Interaction Gateway | `gemini-2.5-flash` ² | 1M tokens | Low Latency Classification: 0.32s time-to-first-token, ~250 tokens/sec, $0.30/M input. 1M context window handles full CI/CD log dumps without truncation. Includes thinking capabilities for ambiguous intent classification. | `gpt-5-mini` |

> **¹ `gpt-5.2` is a placeholder** — This model ID has not been verified against the OpenAI API. When implementing the Performance Reviewer (Phase 2), check the latest available OpenAI model and substitute accordingly. The fallback (`claude-opus-4-6`) is known-good.
>
> **² Gateway Classifier is Phase 3+** — The `gemini-2.5-flash` classifier is not part of the MVP. The MVP gateway has no classification layer.

### 4.2 Cost Management & Rate-Limit Strategy

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

**Provider failover:** If the primary model returns 5 consecutive 429s or 500s within a 10-minute window, the activity automatically switches to the fallback model specified in Section 4.1. This is logged as an OTel event and a Slack audit message.

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

## 5. End-to-End Workflow Lifecycle

The workflow lifecycle uses Temporal's Parent-Child Workflow pattern. The Epic Orchestrator (parent) decomposes cross-repo work into per-repository child workflows. Each child workflow follows a deterministic loop: Implement → Review → PR → CI → Human Merge → Memory Commit.

The agent data flow, typed interfaces, Temporal workflow code, retry policies, and all activity implementations are documented in:

> **[docs/workflow-and-activities.md](docs/workflow-and-activities.md)** — Full TypeScript implementations for the Temporal worker.

**Key design decisions documented there:**
- Typed interfaces for every agent-to-agent handoff (16 interfaces total)
- `proxyActivities` with per-category retry policies (state: 5 retries/30s, agent: 2 retries/30m+heartbeat, GitHub: 4 retries/2m, memory: 3 retries/5m)
- Workflow-level safety bounds (max 3 CI retries, max 3 review retries, 4h CI timeout, 7d merge timeout)
- Activity implementations: `executeImplementation` (K8s workspace + Mastra TDD loop), `runReviewNetwork` (parallel multi-agent review), `createOrUpdatePullRequest`, CI self-healing loop, `commitToMemory`

## 6. Data Architecture & Security

The Prisma schema, embedding pipeline, executor image build pipeline, security guardrails, and docker-compose infrastructure are documented in:

> **[docs/data-and-infra.md](docs/data-and-infra.md)** — Prisma schema, pgvector pipeline, security, and infrastructure.

**Key design decisions documented there:**
- Prisma v7.x schema with 8 models (User, RefreshToken, Repository, WorkRequest, ContextSnapshot, ActiveWorkflow, PullRequest, AgentLesson)
- Embedding pipeline: `text-embedding-3-large` (1536d), HNSW index (m=16, ef_construction=200), cosine similarity with 0.7 threshold
- Executor image lifecycle: ECR registry, `.auto-swe/Dockerfile` convention, GitHub Actions build pipeline, IRSA-based K8s pull credentials
- Workspace isolation: volume sandboxing at `/workspace/target-repo`, JIT credential scoping, SecurityReviewProcessor middleware

## 7. Interaction Gateway & RBAC

The full API specification, authentication implementation, RBAC middleware, and webhook handlers are documented in:

> **[docs/gateway-and-auth.md](docs/gateway-and-auth.md)** — Gateway API spec, JWT/RBAC implementation, Slack OAuth.

**Key design decisions documented there:**
- RS256 JWT signing with K8s Secrets, dual-key rotation window
- Refresh token rotation with family-based reuse detection (theft protection)
- RBAC middleware with role hierarchy (ENGINEER < LEAD < ADMIN)
- 11 API endpoints across 6 resource groups (work requests, epics, workflows, repositories, users, lessons)
- 3 webhook handlers (CI/CD, Git merge, Slack interactive) with HMAC/signature verification
- Slack OAuth 2.0 flow for linking `slack_id` to User records

## 8. Web Interface & Admin Control Center

Built with Next.js and Tailwind CSS, this dashboard consumes the Interaction Gateway API to provide deep visibility and administrative control over the agentic workforce.

- **Epic Visualizer:** A real-time node graph depicting the Parent `CrossRepoEpicWorkflow` and its cascading Child Workflows.
- **Context Inspector:** A read-only view of the immutable `ContextSnapshot`.
- **RBAC Policy Editor (Admins Only):** Interface for mapping new engineers and assigning their roles.
- **Repository Onboarding:** Interface to register new repositories, configure their specific `defaultBranch`, and specify their `executorImage`.

## 9. Agent Operating Instructions (System Prompts)

### 9.1 The Implementer Agent (Surgical Coder & Tester)

**(Model: claude-opus-4-6)**

> "You are a highly constrained Surgical Coder operating within a customized, isolated repository environment. Execute the plan.md exactly as written. TDD MANDATE: Before submitting your code for review, you MUST write corresponding unit/integration tests and execute them using the bash MCP tool. You must iteratively fix your code until your test suite passes. Adhere perfectly to the injected 'Global Guidelines' and refer to the Semantic Registry for any cross-repo API contracts. If your output is rejected by any Review Processor or the external CI/CD pipeline, do not attempt to justify your code. Read the logs and immediately refactor to comply."

### 9.2 The Context Validator (Global Analyst)

**(Model: gemini-2.5-pro)**

> "You are the Global Context Validator. Trace all dependencies across the linked issue tracker tickets and documentation pages. You must extract an exhaustive list of explicit 'Success Criteria' from these sources. These extracted criteria will form the immutable Context Snapshot."

### 9.3 The Epic Planner Agent (System Architect)

**(Model: claude-opus-4-6)**

> "You are the Lead System Architect orchestrating a multi-repo Epic. Analyze the provided ticket, the cross-repo codebase schemas, and the immutable 'Context Snapshot'. Your execution graph must strictly map to the 'Success Criteria'. Carefully review the 'Historical Failures' section to circumvent known integration pitfalls."

### 9.4 The Domain Logic & Correctness Reviewer

**(Model: claude-opus-4-6)**

> "You are the QA and Domain Logic Lead. You have been provided the immutable 'Context Snapshot'. Treat this array as a strict checklist. If you cannot conclusively verify that the PR satisfies every single criterion from the snapshot, reject the code."

### 9.5 The Security Auditor Agent

**(Model: claude-opus-4-6)**

> "You are the merciless Security Auditor. Review the diffs produced by the Implementer Agent. Your sole priority is identifying vulnerabilities. If you find a High or Critical severity issue, reject the code and provide the imperative instruction on how to fix it."
