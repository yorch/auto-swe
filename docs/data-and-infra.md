# Data Layer & Infrastructure

> Extracted from [PLAN.md](../PLAN.md) — Technical implementation detail for data, infra, and security.

> ⚠️ **MULTI-PHASE DOCUMENT** — This document covers data and infrastructure across all phases. Sections are labeled with their target phase. For Phase 1 MVP, use the Prisma schema and Docker Compose from `mvp-implementation.md` — they are the authoritative source. This document extends them with Phase 2-4 additions.

## 1. Prisma Data Model (Relational Domain Schema & RBAC)

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
  url        = env("DATABASE_URL")
  extensions = [vector]
}

// --- RBAC: User Identity & Roles ---
model User {
  id             String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email          String         @unique
  passwordHash   String         @map("password_hash")
  slackId        String?        @unique @map("slack_id")
  role           String         @default("ENGINEER") // ADMIN, LEAD, ENGINEER
  isActive       Boolean        @default(true) @map("is_active")
  createdAt      DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime       @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  refreshTokens  RefreshToken[]

  @@map("users")
}

model RefreshToken {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId         String    @map("user_id") @db.Uuid
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash      String    @unique @map("token_hash")    // SHA-256 hash of the token value
  family         String    @default(dbgenerated("gen_random_uuid()")) // Rotation family for reuse detection
  expiresAt      DateTime  @map("expires_at") @db.Timestamptz
  revokedAt      DateTime? @map("revoked_at") @db.Timestamptz
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([userId])
  @@index([family])
  @@map("refresh_tokens")
}

// --- Repository Configuration ---
model Repository {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationName String           @map("organization_name")
  repoName         String           @map("repo_name")
  defaultBranch    String           @default("main") @map("default_branch")
  githubUrl        String?          @map("github_url")        // e.g., "https://github.acme.com" (null = use GITHUB_URL env or github.com)
  githubApiUrl     String?          @map("github_api_url")    // e.g., "https://github.acme.com/api/v3" (null = use GITHUB_API_URL env or api.github.com)
  mcpServerRef     String?          @map("mcp_server_ref")

  // Custom Docker image containing internal tools/certs/npm registries
  executorImage    String?          @default("node:24-alpine") @map("executor_image")
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
  description      String           @default("")
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

  rawTicketData    Json?        @map("raw_jira_epic")    // External ticket data (Jira, Linear, GitHub Issues, etc.)
  rawDocumentation Json?        @map("raw_confluence")   // External docs (Confluence, Notion, wiki, etc.)
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

## 2. Embedding Pipeline & Semantic Memory Retrieval

> ⚠️ **PHASE 4** — Semantic memory is not part of the MVP. The `AgentLesson` table exists in the schema for forward compatibility but has no code paths in Phase 1.

The `AgentLesson` table stores vector embeddings alongside structured metadata. This section defines exactly how embeddings are generated, indexed, and retrieved.

### Embedding Generation

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

### Database Index

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

### Similarity Search (Retrieval)

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

### Embedding Lifecycle

| Event | Action | Who Generates |
|---|---|---|
| Workflow completes (success or failure) | Memory Agent summarizes workflow → `generateEmbedding(summary)` → INSERT into `agent_lessons` | `commitToMemory` activity |
| Human rejects PR with feedback | Feedback text → `generateEmbedding(feedback)` → INSERT into `agent_lessons` with `failureType: 'REVIEW_REJECTION'` | Gateway webhook handler |
| Context Validator runs | `generateEmbedding(successCriteria.join(' '))` → query `agent_lessons` → inject into `ContextSnapshot.historicalLessons` | `executeImplementation` activity |
| Admin deletes lesson | DELETE from `agent_lessons` WHERE id = :id (embedding removed with row) | Gateway API (`DELETE /api/v1/lessons/:id`) |

## 3. Security, Guardrails, & Workspace Isolation

To ensure system stability, the agentic system acts purely as an orchestrator and worker—it must never modify its own source code or bypass human QA workflows.

### 3.1 Ephemeral Workspace & Custom Executors

Work requests trigger execution strictly within isolated clones of Target Repositories.

- **Custom Executor Images:** Instead of a generic environment, the K8s Job dynamically pulls the pre-configured Docker image specified in `Repository.executorImage`. This allows the agent to immediately execute `npm install` or `mvn test` using internal corporate registries, pre-cached certificates, and specific language versions without complex setup scripting.
- **Volume Sandboxing:** The MCP tools configured for the agent are hard-chrooted to `/workspace/target-repo`. The agent cannot traverse up the file tree to read host node configuration or the agent framework source code.
- **Just-In-Time (JIT) Credential Scoping:** The agent is never provided global admin GitHub tokens. The Control Plane generates a short-lived, repository-scoped Installation Access Token permitting only read/write access to the assigned branch.

### 3.2 Custom Executor Image Build Pipeline

> ⚠️ **PHASE 4** — Custom executor images are not part of the MVP. The MVP uses the default `node:24-alpine` image. This section documents the production build pipeline for later phases.

The `Repository.executorImage` field references a pre-built Docker image. This section defines who builds these images, where they're stored, and how they're kept current.

#### Image Registry

All executor images are stored in a private Amazon ECR (Elastic Container Registry) repository:

```
<aws-account-id>.dkr.ecr.<region>.amazonaws.com/auto-swe/executors/<org>-<repo>
```

Example: `123456789.dkr.ecr.us-east-1.amazonaws.com/auto-swe/executors/acme-payments-api`

#### Image Build Process

Each onboarded repository can optionally include a `.auto-swe/Dockerfile` in its root. If absent, a default image is used.

```dockerfile
# Example: .auto-swe/Dockerfile for a Node.js project with internal registry
FROM node:24-alpine

# Internal corporate CA certificate
COPY .auto-swe/certs/internal-ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Configure npm to use internal registry
RUN npm config set registry https://npm.internal.acme.com

# Pre-install global tools used by the agent
RUN npm install -g typescript jest ts-jest

WORKDIR /workspace/target-repo
```

#### Build Trigger & CI Pipeline

Executor images are built via a GitHub Actions workflow in the **Control Plane repository** (not the target repo):

```yaml
# .github/workflows/build-executor.yml
name: Build Executor Image
on:
  workflow_dispatch:
    inputs:
      repo_id:
        description: 'Repository UUID from the database'
        required: true
  # Also triggered by the Repository Onboarding API
  repository_dispatch:
    types: [build-executor]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # For OIDC → ECR auth
    steps:
      - name: Fetch repo config
        run: |
          # Query the Gateway API for repo details
          REPO=$(curl -s -H "Authorization: Bearer ${{ secrets.GATEWAY_TOKEN }}" \
            "${{ secrets.GATEWAY_URL }}/api/v1/repositories/${{ github.event.inputs.repo_id }}")
          echo "ORG=$(echo $REPO | jq -r '.data.organizationName')" >> $GITHUB_ENV
          echo "REPO_NAME=$(echo $REPO | jq -r '.data.repoName')" >> $GITHUB_ENV

      - name: Checkout target repo
        uses: actions/checkout@v4
        with:
          repository: ${{ env.ORG }}/${{ env.REPO_NAME }}
          token: ${{ secrets.GITHUB_APP_TOKEN }}

      - name: Build and push to ECR
        uses: aws-actions/amazon-ecr-login@v2
      - run: |
          DOCKERFILE=".auto-swe/Dockerfile"
          if [ ! -f "$DOCKERFILE" ]; then
            DOCKERFILE="defaults/Dockerfile.node20"  # Fallback to default
          fi
          IMAGE_TAG="${{ env.ORG }}-${{ env.REPO_NAME }}:$(date +%Y%m%d)-${GITHUB_SHA::8}"
          docker build -f "$DOCKERFILE" -t "$ECR_REGISTRY/auto-swe/executors/$IMAGE_TAG" .
          docker push "$ECR_REGISTRY/auto-swe/executors/$IMAGE_TAG"

      - name: Update repository config
        run: |
          curl -X PATCH -H "Authorization: Bearer ${{ secrets.GATEWAY_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "{\"executorImage\": \"$ECR_REGISTRY/auto-swe/executors/$IMAGE_TAG\"}" \
            "${{ secrets.GATEWAY_URL }}/api/v1/repositories/${{ github.event.inputs.repo_id }}"
```

#### Image Freshness

| Trigger | When | What Happens |
|---|---|---|
| Repository onboarding | `POST /api/v1/repositories` | Gateway fires `repository_dispatch` event → builds initial image |
| Manual rebuild | Admin clicks "Rebuild Image" in Web Dashboard | Gateway fires `workflow_dispatch` → rebuilds from latest `.auto-swe/Dockerfile` |
| Scheduled rebuild | Weekly cron (Sunday 02:00 UTC) | Rebuilds all active repository images to pick up OS/dependency patches |
| Dockerfile change | PR merged to target repo that modifies `.auto-swe/Dockerfile` | GitHub webhook → Gateway detects path change → triggers rebuild |

#### K8s Image Pull Credentials

The agent worker nodes authenticate to ECR using IAM Roles for Service Accounts (IRSA). No long-lived credentials are stored in the cluster:

```yaml
# k8s/agent-worker-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: agent-worker
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/auto-swe-ecr-pull
```

### 3.3 The TDD Loop

LLM code generation can be syntactically perfect but functionally broken.

- The Implementer Agent is strictly instructed to write unit and integration tests based on the repository's native testing framework (e.g., Jest, PyTest) before asking for a review.
- The agent uses its bash MCP tool to run the tests in the DinD sandbox. It reads the standard output/error, and iteratively fixes its own code until the test suite is green.

### 3.4 Mastra Security Review Processor

> ⚠️ **PHASE 2** — The SecurityReviewProcessor is part of the review network, not the MVP.

The `SecurityReviewProcessor` acts as an inescapable, real-time middleware for Implementation agents.

1. **Intercept Phase:** Every Mastra MCP tool call to `writeFile` or `editFile` triggers this output processor.
2. **Audit Phase:** A `claude-opus-4-6` model compares the requested code diff against the "Security Guideline" dataset.
3. **Self-Correction Phase:** If a violation is detected (e.g., SQL Injection risk), the processor denies the write access and returns a retry instruction forcing immediate remediation.

## 4. Infrastructure & Deployment (Local Lab)

> ⚠️ **FULL SYSTEM (Phase 3+)** — This Docker Compose includes all services (OTel, web dashboard). For the MVP, use the Docker Compose in `mvp-implementation.md` which only runs Postgres, Temporal, Gateway, and Worker. Note: the MVP uses service names `gateway` and `worker`; this full-system compose uses `interaction-gateway` and `agent-worker`.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: engineering_system
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Temporal gets its own Postgres instance to avoid schema conflicts with pgvector
  postgres-temporal:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  temporal:
    image: temporalio/auto-setup:1.25.2
    depends_on:
      postgres-temporal:
        condition: service_healthy
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=postgres
      - POSTGRES_PWD=password
      - POSTGRES_SEEDS=postgres-temporal
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
      postgres:
        condition: service_healthy
      temporal:
        condition: service_started
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
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```
