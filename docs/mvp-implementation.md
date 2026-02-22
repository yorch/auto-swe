# MVP Technical Implementation Guide (Phase 1)

> This document provides the complete, step-by-step technical implementation for the MVP. It covers project structure, configuration, every file that needs to be written, and the exact build order. Refer to [mvp-architecture.md](./mvp-architecture.md) for design rationale.

## 1. Project Structure

```
auto-swe/
├── docker-compose.yml
├── .env                          # Local secrets (git-ignored)
├── .env.example                  # Template for .env
├── package.json                  # Root workspace config (pnpm)
├── pnpm-workspace.yaml
├── tsconfig.base.json            # Shared TS config
│
├── packages/
│   ├── shared/                   # Shared types, utilities, Prisma client
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types/
│   │       │   ├── workflow.ts   # RepoWorkRequest, CodeResult, WorkflowResult
│   │       │   └── api.ts        # ApiResponse, request/response DTOs
│   │       ├── prisma/
│   │       │   ├── schema.prisma
│   │       │   └── migrations/
│   │       └── index.ts
│   │
│   ├── gateway/                  # Interaction Gateway (Express.js)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts          # Express app bootstrap
│   │       ├── routes/
│   │       │   ├── workRequests.ts
│   │       │   ├── workflows.ts
│   │       │   └── webhooks.ts
│   │       ├── middleware/
│   │       │   └── validation.ts # Zod schema validation
│   │       ├── services/
│   │       │   └── temporal.ts   # Temporal client wrapper
│   │       └── lib/
│   │           └── github.ts     # HMAC verification
│   │
│   └── worker/                   # Temporal Worker
│       ├── package.json
│       ├── tsconfig.json
│       ├── Dockerfile
│       └── src/
│           ├── index.ts          # Worker bootstrap (register workflows + activities)
│           ├── workflows/
│           │   └── engineering.ts # EngineeringWorkflow
│           ├── activities/
│           │   ├── index.ts      # Activity exports
│           │   ├── executeImplementation.ts
│           │   ├── createOrUpdatePullRequest.ts
│           │   ├── state.ts      # updateDomainState
│           │   └── workspace.ts  # Docker container management
│           └── agents/
│               ├── implementer.ts  # Mastra agent config
│               └── prompts.ts      # System prompts
```

## 2. Build Order

The implementation should proceed in this exact order. Each step produces a testable artifact.

| Step | What | Depends On | Validation |
|---|---|---|---|
| 1 | Monorepo scaffold + toolchain | — | `pnpm install` succeeds |
| 2 | Prisma schema + Docker Compose (Postgres + Temporal) | Step 1 | `pnpm prisma migrate dev` succeeds, `docker compose up` runs |
| 3 | Shared types package | Step 1 | TypeScript compiles |
| 4 | Gateway: Express bootstrap + health endpoint | Steps 1-3 | `curl localhost:8080/health` returns 200 |
| 5 | Gateway: `POST /api/v1/work-requests` | Steps 2-4 | Creates DB records, returns `workRequestId` |
| 6 | Gateway: Temporal client integration | Steps 2, 5 | Work request starts a Temporal workflow |
| 7 | Worker: Bootstrap + register workflow | Steps 2, 3 | Worker connects to Temporal, workflow appears in Temporal Web UI |
| 8 | Worker: `updateDomainState` activity | Steps 2, 7 | Workflow updates `active_workflows.current_status` |
| 9 | Worker: Workspace provisioning (Docker container) | Step 7 | Container created, repo cloned, container destroyed |
| 10 | Worker: Implementer agent (Mastra + claude-opus-4-6) | Steps 7, 9 | Agent generates code in workspace |
| 11 | Worker: TDD loop | Steps 9, 10 | Agent runs tests, iterates on failures |
| 12 | Worker: `createOrUpdatePullRequest` activity | Steps 2, 7 | PR created on GitHub |
| 13 | Worker: `humanMergeSignal` handler | Step 7 | Workflow waits for signal, completes on receipt |
| 14 | Gateway: `POST /api/v1/webhooks/git` | Steps 6, 13 | Merge webhook fires signal, workflow completes |
| 15 | End-to-end test | All | Ticket in → PR out → merge → workflow COMPLETED |

## 3. Step-by-Step Implementation

### Step 1: Monorepo Scaffold

**pnpm-workspace.yaml:**
```yaml
packages:
  - 'packages/*'
```

**package.json (root):**
```json
{
  "name": "auto-swe",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "dev:gateway": "pnpm --filter gateway dev",
    "dev:worker": "pnpm --filter worker dev",
    "db:migrate": "pnpm --filter shared prisma migrate dev",
    "db:generate": "pnpm --filter shared prisma generate",
    "db:seed": "pnpm --filter shared prisma db seed"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

**tsconfig.base.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**.env.example:**
```bash
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/engineering_system

# Temporal
TEMPORAL_ADDRESS=localhost:7233

# LLM (Implementer Agent)
ANTHROPIC_API_KEY=sk-ant-...

# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=whsec_...
```

### Step 2: Prisma Schema + Docker Compose

**packages/shared/src/prisma/schema.prisma:**
```prisma
generator client {
  provider        = "prisma-client"
  previewFeatures = ["tracing"]
  output          = "../generated/prisma"
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}

model User {
  id             String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email          String         @unique
  passwordHash   String         @map("password_hash")
  slackId        String?        @unique @map("slack_id")
  role           String         @default("ENGINEER")
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
  tokenHash      String    @unique @map("token_hash")
  family         String    @default(dbgenerated("gen_random_uuid()"))
  expiresAt      DateTime  @map("expires_at") @db.Timestamptz
  revokedAt      DateTime? @map("revoked_at") @db.Timestamptz
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([userId])
  @@index([family])
  @@map("refresh_tokens")
}

model Repository {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationName String           @map("organization_name")
  repoName         String           @map("repo_name")
  defaultBranch    String           @default("main") @map("default_branch")
  mcpServerRef     String           @map("mcp_server_ref")
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
  status          String
  ciStatus        String          @default("PENDING") @map("ci_status")

  @@map("pull_requests")
}

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

**packages/shared/src/prisma/seed.ts:**
```typescript
import { PrismaClient } from '../generated/prisma';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Seed admin user (MVP: hardcoded, no login flow)
  await prisma.user.upsert({
    where: { email: 'admin@auto-swe.local' },
    update: {},
    create: {
      email: 'admin@auto-swe.local',
      passwordHash: await bcrypt.hash('admin', 12),
      role: 'ADMIN',
    },
  });

  console.log('Seed complete: admin user created');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

**docker-compose.yml:**
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
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  temporal:
    image: temporalio/auto-setup:1.25.2
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=postgres
      - POSTGRES_PWD=password
      - POSTGRES_SEEDS=postgres
    ports:
      - "7233:7233"
      - "8233:8233"

  gateway:
    build:
      context: .
      dockerfile: packages/gateway/Dockerfile
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
      - GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}
      - PORT=8080

  worker:
    build:
      context: .
      dockerfile: packages/worker/Dockerfile
    depends_on:
      postgres:
        condition: service_healthy
      temporal:
        condition: service_started
    environment:
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/engineering_system
      - TEMPORAL_ADDRESS=temporal:7233
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # DinD access

volumes:
  pgdata:
```

### Step 3: Shared Types

**packages/shared/src/types/workflow.ts:**
```typescript
// ── MVP Workflow Types ──
// Subset of the full system types — only what Phase 1 needs.

export interface RepoWorkRequest {
  workRequestId: string;
  repoId: string;
  externalTicketId: string;
  requestPayload: string;
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

export interface WorkflowResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  prNumber?: number;
  prUrl?: string;
}

export type WorkflowStatus =
  | 'IMPLEMENTING'
  | 'AWAITING_HUMAN_MERGE'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT';
```

**packages/shared/src/types/api.ts:**
```typescript
export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

export interface CreateWorkRequestBody {
  externalTicketId: string;
  repoIds: string[];
}

export interface CreateWorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
}

export interface GitWebhookBody {
  action: string;
  pull_request?: {
    number: number;
    merged: boolean;
    head: { sha: string; ref: string };
    base: { repo: { full_name: string } };
  };
}
```

### Step 4: Gateway Bootstrap

**packages/gateway/package.json:**
```json
{
  "name": "gateway",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^5.0.0",
    "zod": "^3.24.0",
    "@temporalio/client": "^1.11.0",
    "shared": "workspace:*"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

**packages/gateway/src/index.ts:**
```typescript
import express from 'express';
import { workRequestRouter } from './routes/workRequests';
import { workflowRouter } from './routes/workflows';
import { webhookRouter } from './routes/webhooks';

const app = express();
const PORT = process.env.PORT ?? 8080;

// Webhooks need raw body for HMAC verification
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.use('/api/v1/work-requests', workRequestRouter);
app.use('/api/v1/workflows', workflowRouter);
app.use('/api/v1/webhooks', webhookRouter);

app.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
```

### Step 5: Work Request Endpoint

**packages/gateway/src/routes/workRequests.ts:**
```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from 'shared/generated/prisma';
import { startWorkflow } from '../services/temporal';

const prisma = new PrismaClient();
const router = Router();

const CreateWorkRequestSchema = z.object({
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateWorkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0].message },
    });
  }

  const { externalTicketId, repoIds } = parsed.data;

  // Verify repository exists
  const repo = await prisma.repository.findUnique({ where: { id: repoIds[0] } });
  if (!repo || !repo.isActive) {
    return res.status(404).json({
      error: { code: 'REPO_NOT_FOUND', message: `Repository ${repoIds[0]} not found or inactive` },
    });
  }

  // Create work request
  const workRequest = await prisma.workRequest.create({
    data: {
      externalTicketId,
      requestPayload: JSON.stringify(req.body),
    },
  });

  // Generate Temporal workflow ID (deterministic for idempotency)
  const temporalWorkflowId = `eng-${externalTicketId}-${repo.repoName}`;
  const branch = `auto/${externalTicketId}`;

  // Create ActiveWorkflow record
  const activeWorkflow = await prisma.activeWorkflow.create({
    data: {
      temporalWorkflowId,
      workRequestId: workRequest.id,
      repoId: repo.id,
      currentStatus: 'IMPLEMENTING',
      assignedBranch: branch,
    },
  });

  // Start Temporal workflow
  try {
    await startWorkflow(temporalWorkflowId, {
      workRequestId: workRequest.id,
      repoId: repo.id,
      externalTicketId,
      requestPayload: JSON.stringify(req.body),
    });
  } catch (err: any) {
    // If workflow already exists (idempotent retry), that's fine
    if (err.name === 'WorkflowExecutionAlreadyStartedError') {
      return res.status(409).json({
        error: { code: 'WORKFLOW_ALREADY_EXISTS', message: `Workflow already running for ${externalTicketId}` },
      });
    }
    throw err;
  }

  return res.status(201).json({
    data: {
      workRequestId: workRequest.id,
      workflowIds: [activeWorkflow.id],
    },
  });
});

export { router as workRequestRouter };
```

### Step 6: Temporal Client Integration

**packages/gateway/src/services/temporal.ts:**
```typescript
import { Client, Connection } from '@temporalio/client';
import type { RepoWorkRequest } from 'shared/types/workflow';

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    client = new Client({ connection });
  }
  return client;
}

export async function startWorkflow(
  workflowId: string,
  request: RepoWorkRequest,
): Promise<void> {
  const c = await getClient();
  await c.workflow.start('EngineeringWorkflow', {
    taskQueue: 'engineering-workflow',
    workflowId,
    args: [request],
  });
}

export async function signalWorkflow(
  workflowId: string,
  signalName: string,
  args: unknown[] = [],
): Promise<void> {
  const c = await getClient();
  const handle = c.workflow.getHandle(workflowId);
  await handle.signal(signalName, ...args);
}
```

### Step 7: Worker Bootstrap

**packages/worker/package.json:**
```json
{
  "name": "worker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@temporalio/worker": "^1.11.0",
    "@temporalio/workflow": "^1.11.0",
    "@temporalio/activity": "^1.11.0",
    "@mastra/core": "^1.0.0",
    "@octokit/rest": "^21.0.0",
    "shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

**packages/worker/src/index.ts:**
```typescript
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'engineering-workflow',
    workflowsPath: require.resolve('./workflows/engineering'),
    activities,
  });

  console.log('Worker started, polling task queue: engineering-workflow');
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
```

### Step 8–13: Workflow + Activities

**packages/worker/src/workflows/engineering.ts:**
```typescript
import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities';
import type { RepoWorkRequest, WorkflowResult } from 'shared/types/workflow';

// ── Activity Proxies ──

const stateActivities = proxyActivities<
  Pick<typeof activitiesType, 'updateDomainState'>
>({
  startToCloseTimeout: '30s',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

const agentActivities = proxyActivities<
  Pick<typeof activitiesType, 'executeImplementation'>
>({
  startToCloseTimeout: '30m',
  heartbeatTimeout: '5m',
  retry: {
    maximumAttempts: 2,
    initialInterval: '30s',
    backoffCoefficient: 2,
    maximumInterval: '2m',
  },
});

const githubActivities = proxyActivities<
  Pick<typeof activitiesType, 'createOrUpdatePullRequest'>
>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 4,
    initialInterval: '5s',
    backoffCoefficient: 3,
    maximumInterval: '2m',
  },
});

// ── Signals ──

export const humanMergeSignal = defineSignal<[boolean]>('humanMergeSignal');

// ── Constants ──

const HUMAN_MERGE_TIMEOUT = '7d';

// ── Workflow ──

export async function EngineeringWorkflow(
  request: RepoWorkRequest,
): Promise<WorkflowResult> {
  let humanMerged = false;

  setHandler(humanMergeSignal, () => {
    humanMerged = true;
  });

  // 1. Implement
  await stateActivities.updateDomainState(request.workRequestId, 'IMPLEMENTING');

  const codeResult = await agentActivities.executeImplementation(request);

  // 2. Open PR
  const prData = await githubActivities.createOrUpdatePullRequest(
    request,
    codeResult,
  );

  // 3. Wait for human merge
  await stateActivities.updateDomainState(
    request.workRequestId,
    'AWAITING_HUMAN_MERGE',
  );

  const merged = await condition(() => humanMerged, HUMAN_MERGE_TIMEOUT);

  if (!merged) {
    await stateActivities.updateDomainState(request.workRequestId, 'TIMED_OUT');
    return {
      status: 'TIMED_OUT',
      prNumber: prData.prNumber,
      prUrl: prData.prUrl,
    };
  }

  // 4. Complete
  await stateActivities.updateDomainState(request.workRequestId, 'COMPLETED');

  return {
    status: 'SUCCESS',
    prNumber: prData.prNumber,
    prUrl: prData.prUrl,
  };
}
```

**packages/worker/src/activities/state.ts:**
```typescript
import { PrismaClient } from 'shared/generated/prisma';

const prisma = new PrismaClient();

export async function updateDomainState(
  workRequestId: string,
  status: string,
): Promise<void> {
  await prisma.activeWorkflow.updateMany({
    where: { workRequestId },
    data: { currentStatus: status },
  });
}
```

**packages/worker/src/activities/workspace.ts:**
```typescript
import { execSync, ExecSyncOptions } from 'child_process';
import crypto from 'crypto';

export interface Workspace {
  containerId: string;
  exec: (command: string) => string;
  destroy: () => void;
}

const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  timeout: 120_000, // 2 minutes per command
  maxBuffer: 10 * 1024 * 1024, // 10MB
};

export function createWorkspace(
  repoUrl: string,
  branch: string,
  defaultBranch: string,
  githubToken: string,
  image: string = 'node:20-alpine',
): Workspace {
  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;

  // Start container
  const authedUrl = repoUrl.replace(
    'https://',
    `https://x-access-token:${githubToken}@`,
  );

  execSync(
    `docker run -d --name ${containerName} ${image} sleep infinity`,
    EXEC_OPTS,
  );

  const exec = (command: string): string => {
    return execSync(
      `docker exec ${containerName} sh -c '${command.replace(/'/g, "'\\''")}'`,
      EXEC_OPTS,
    ) as string;
  };

  // Clone repo
  exec(`git clone --depth=50 -b ${defaultBranch} ${authedUrl} /workspace/target-repo`);
  exec(`cd /workspace/target-repo && git checkout -b ${branch}`);

  return {
    containerId: containerName,
    exec: (command: string) => {
      return execSync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c '${command.replace(/'/g, "'\\''")}'`,
        EXEC_OPTS,
      ) as string;
    },
    destroy: () => {
      try {
        execSync(`docker rm -f ${containerName}`, EXEC_OPTS);
      } catch {
        // Container may already be gone
      }
    },
  };
}
```

**packages/worker/src/activities/executeImplementation.ts:**
```typescript
import { heartbeat } from '@temporalio/activity';
import { Mastra } from '@mastra/core';
import { PrismaClient } from 'shared/generated/prisma';
import type { RepoWorkRequest, CodeResult, TestRunResult } from 'shared/types/workflow';
import { createWorkspace } from './workspace';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts';

const prisma = new PrismaClient();
const MAX_TDD_ITERATIONS = 5;

export async function executeImplementation(
  request: RepoWorkRequest,
): Promise<CodeResult> {
  // Load repository config
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const repoUrl = `https://github.com/${repo.organizationName}/${repo.repoName}.git`;
  const branch = `auto/${request.externalTicketId}`;
  const githubToken = process.env.GITHUB_TOKEN!;

  // Provision workspace
  const workspace = createWorkspace(
    repoUrl,
    branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:20-alpine',
  );

  try {
    heartbeat('workspace provisioned');

    // Detect test framework from workspace
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Initialize Mastra agent
    const mastra = new Mastra({});
    const implementer = mastra.getAgent('implementer');

    let testResult: TestRunResult = {
      passed: false,
      total: 0,
      passing: 0,
      failing: 0,
      stdout: '',
      duration_ms: 0,
    };

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      await implementer.generate(
        [
          { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              request: request.requestPayload,
              iteration,
              previousTestResult: iteration > 0 ? testResult : undefined,
            }),
          },
        ],
        { toolChoice: 'auto' },
      );

      // Run tests
      try {
        const startTime = Date.now();
        const testOutput = workspace.exec(testCommand);
        testResult = parseTestOutput(testOutput, Date.now() - startTime);

        if (testResult.passed) break;
      } catch (err: any) {
        testResult = {
          passed: false,
          total: 0,
          passing: 0,
          failing: 1,
          stdout: err.stdout?.slice(-10_000) ?? err.message,
          duration_ms: 0,
        };
      }
    }

    // Commit changes
    workspace.exec('git add -A');
    workspace.exec(`git commit -m "auto: implement ${request.externalTicketId}"`);

    // Collect results
    const diff = workspace.exec(`git diff ${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    // Push branch
    workspace.exec(`git push origin ${branch}`);

    return {
      branch,
      headSha,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Completed in ${Math.min(testResult.passed ? 0 : MAX_TDD_ITERATIONS, MAX_TDD_ITERATIONS)} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    };
  } finally {
    workspace.destroy();
  }
}

function detectTestCommand(packageJsonStr: string): string {
  try {
    const pkg = JSON.parse(packageJsonStr);
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return 'npm test';
    }
  } catch {}
  return 'npm test';
}

function parseTestOutput(output: string, durationMs: number): TestRunResult {
  // Simple heuristic — works for Jest and most Node test runners
  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);

  const passing = passMatch ? parseInt(passMatch[1]) : 0;
  const failing = failMatch ? parseInt(failMatch[1]) : 0;

  return {
    passed: failing === 0 && passing > 0,
    total: passing + failing,
    passing,
    failing,
    stdout: output.slice(-10_000),
    duration_ms: durationMs,
  };
}

function parseDiffToFileChanges(diff: string) {
  const files: { path: string; operation: 'CREATE' | 'MODIFY' | 'DELETE'; language: string; linesAdded: number; linesRemoved: number }[] = [];
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match;
  while ((match = fileRegex.exec(diff)) !== null) {
    const path = match[2];
    const ext = path.split('.').pop() ?? '';
    const section = diff.slice(match.index, diff.indexOf('diff --git', match.index + 1) === -1 ? undefined : diff.indexOf('diff --git', match.index + 1));
    const added = (section.match(/^\+[^+]/gm) || []).length;
    const removed = (section.match(/^-[^-]/gm) || []).length;
    const isNew = section.includes('new file mode');
    const isDeleted = section.includes('deleted file mode');

    files.push({
      path,
      operation: isNew ? 'CREATE' : isDeleted ? 'DELETE' : 'MODIFY',
      language: ext,
      linesAdded: added,
      linesRemoved: removed,
    });
  }
  return files;
}
```

**packages/worker/src/activities/createOrUpdatePullRequest.ts:**
```typescript
import { Octokit } from '@octokit/rest';
import { PrismaClient } from 'shared/generated/prisma';
import type { RepoWorkRequest, CodeResult } from 'shared/types/workflow';

const prisma = new PrismaClient();

export async function createOrUpdatePullRequest(
  request: RepoWorkRequest,
  codeResult: CodeResult,
): Promise<{ prNumber: number; prUrl: string }> {
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Check if PR already exists
  const existingPR = await prisma.pullRequest.findFirst({
    where: {
      repoId: repo.id,
      workflow: { workRequestId: request.workRequestId },
      status: 'OPEN',
    },
  });

  if (existingPR) {
    // Update existing PR record
    await prisma.pullRequest.update({
      where: { id: existingPR.id },
      data: { headSha: codeResult.headSha },
    });

    return {
      prNumber: existingPR.prNumber!,
      prUrl: `https://github.com/${repo.organizationName}/${repo.repoName}/pull/${existingPR.prNumber}`,
    };
  }

  // Create new PR
  const { data: pr } = await octokit.pulls.create({
    owner: repo.organizationName,
    repo: repo.repoName,
    title: `[auto-swe] ${request.externalTicketId}`,
    body: formatPRBody(request, codeResult),
    head: codeResult.branch,
    base: repo.defaultBranch,
  });

  // Track in database
  const workflow = await prisma.activeWorkflow.findFirst({
    where: { workRequestId: request.workRequestId },
  });

  await prisma.pullRequest.create({
    data: {
      prNumber: pr.number,
      headSha: codeResult.headSha,
      status: 'OPEN',
      ciStatus: 'PENDING',
      repoId: repo.id,
      workflowId: workflow?.id,
    },
  });

  return { prNumber: pr.number, prUrl: pr.html_url };
}

function formatPRBody(request: RepoWorkRequest, codeResult: CodeResult): string {
  const testStatus = codeResult.testResults.passed
    ? `All tests passing (${codeResult.testResults.passing}/${codeResult.testResults.total})`
    : `Tests failing (${codeResult.testResults.passing}/${codeResult.testResults.total} passing)`;

  return [
    `## auto-swe: ${request.externalTicketId}`,
    '',
    `**Test Status:** ${testStatus}`,
    `**Files Changed:** ${codeResult.filesChanged.length}`,
    '',
    '### Changes',
    ...codeResult.filesChanged.map(
      (f) => `- \`${f.path}\` (${f.operation}, +${f.linesAdded}/-${f.linesRemoved})`,
    ),
    '',
    '### Agent Notes',
    codeResult.implementationNotes,
    '',
    '---',
    '_Generated by [auto-swe](https://github.com/auto-swe) Phase 1 MVP_',
  ].join('\n');
}
```

### Step 14: Git Merge Webhook

**packages/gateway/src/routes/webhooks.ts:**
```typescript
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { PrismaClient } from 'shared/generated/prisma';
import { signalWorkflow } from '../services/temporal';

const prisma = new PrismaClient();
const router = Router();

// POST /api/v1/webhooks/git
router.post('/git', async (req: Request, res: Response) => {
  // Verify GitHub HMAC signature
  const signature = req.headers['x-hub-signature-256'] as string;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret || !signature) {
    return res.status(401).json({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(req.body as Buffer).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Invalid signature' } });
  }

  const payload = JSON.parse((req.body as Buffer).toString());

  // Only handle merged pull_request events
  if (
    payload.action !== 'closed' ||
    !payload.pull_request?.merged
  ) {
    return res.status(200).json({ data: { ignored: true } });
  }

  const prNumber = payload.pull_request.number;
  const repoFullName = payload.repository.full_name;
  const [org, repoName] = repoFullName.split('/');

  // Find the tracked PR
  const pullRequest = await prisma.pullRequest.findFirst({
    where: {
      prNumber,
      repository: { organizationName: org, repoName },
      status: 'OPEN',
    },
    include: { workflow: true },
  });

  if (!pullRequest?.workflow) {
    return res.status(200).json({ data: { ignored: true, reason: 'No tracked workflow for this PR' } });
  }

  // Update PR status
  await prisma.pullRequest.update({
    where: { id: pullRequest.id },
    data: { status: 'MERGED' },
  });

  // Signal the Temporal workflow
  await signalWorkflow(
    pullRequest.workflow.temporalWorkflowId,
    'humanMergeSignal',
    [true],
  );

  return res.status(200).json({ data: { signalSent: true, workflowId: pullRequest.workflow.temporalWorkflowId } });
});

export { router as webhookRouter };
```

**packages/gateway/src/routes/workflows.ts:**
```typescript
import { Router, Request, Response } from 'express';
import { PrismaClient } from 'shared/generated/prisma';

const prisma = new PrismaClient();
const router = Router();

// GET /api/v1/workflows
router.get('/', async (_req: Request, res: Response) => {
  const workflows = await prisma.activeWorkflow.findMany({
    include: { repository: true, pullRequests: true },
    orderBy: { updatedAt: 'desc' },
  });
  return res.json({ data: workflows });
});

// GET /api/v1/workflows/:id
router.get('/:id', async (req: Request, res: Response) => {
  const workflow = await prisma.activeWorkflow.findUnique({
    where: { id: req.params.id },
    include: { repository: true, pullRequests: true, workRequest: true },
  });
  if (!workflow) {
    return res.status(404).json({
      error: { code: 'WORKFLOW_NOT_FOUND', message: `No workflow with id ${req.params.id}` },
    });
  }
  return res.json({ data: workflow });
});

export { router as workflowRouter };
```

### Step 10 (Agent): Implementer Agent Configuration

**packages/worker/src/agents/prompts.ts:**
```typescript
export const IMPLEMENTER_SYSTEM_PROMPT = `You are a highly constrained Surgical Coder operating within an isolated repository environment.

INSTRUCTIONS:
1. Read the work request carefully. Understand what needs to be implemented.
2. Explore the codebase using readFile and listDirectory to understand the existing code structure, patterns, and conventions.
3. Write your implementation code following the existing patterns in the repository.
4. TDD MANDATE: Write corresponding unit/integration tests BEFORE or alongside your implementation.
5. Run the test suite using the bash tool. If tests fail, read the output carefully and fix your code.
6. Iterate until all tests pass.

CONSTRAINTS:
- Only modify files within /workspace/target-repo
- Follow existing code style, naming conventions, and patterns
- Do not introduce new dependencies without necessity
- Do not modify unrelated files
- Write clean, minimal code that solves the requirement
- All changes must be covered by tests

If provided with a previousTestResult, focus on fixing the failures described there. Do not rewrite working code.`;
```

**packages/worker/src/agents/implementer.ts:**
```typescript
import { Mastra } from '@mastra/core';
import { anthropic } from '@mastra/anthropic';

export function createImplementerAgent() {
  const mastra = new Mastra({
    agents: {
      implementer: {
        name: 'implementer',
        model: anthropic('claude-opus-4-6'),
        instructions: '', // Set per-call via system message
        tools: {
          // MCP tools are configured to operate within the workspace container.
          // The actual tool bindings depend on the Mastra MCP integration.
          // In the MVP, agent tool calls are translated to docker exec commands
          // by the executeImplementation activity.
        },
      },
    },
  });

  return mastra;
}
```

### Step 15: Activity Barrel Export

**packages/worker/src/activities/index.ts:**
```typescript
export { updateDomainState } from './state';
export { executeImplementation } from './executeImplementation';
export { createOrUpdatePullRequest } from './createOrUpdatePullRequest';
```

### Dockerfiles

**packages/gateway/Dockerfile:**
```dockerfile
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/gateway packages/gateway
RUN pnpm --filter shared build && pnpm --filter gateway build

FROM node:20-alpine
RUN corepack enable
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/generated ./packages/shared/generated
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder /app/packages/gateway/package.json ./packages/gateway/
CMD ["node", "packages/gateway/dist/index.js"]
```

**packages/worker/Dockerfile:**
```dockerfile
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/worker packages/worker
RUN pnpm --filter shared build && pnpm --filter worker build

FROM node:20-dind
# Worker needs Docker CLI to manage workspace containers
RUN corepack enable
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/generated ./packages/shared/generated
COPY --from=builder /app/packages/worker/dist ./packages/worker/dist
COPY --from=builder /app/packages/worker/package.json ./packages/worker/
CMD ["node", "packages/worker/dist/index.js"]
```

## 4. Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `TEMPORAL_ADDRESS` | Yes | `localhost:7233` | Temporal gRPC endpoint |
| `ANTHROPIC_API_KEY` | Yes | — | API key for claude-opus-4-6 |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with `repo` scope |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | HMAC secret for GitHub webhook verification |
| `PORT` | No | `8080` | Gateway listen port |

### GitHub Webhook Setup

Configure on the target repository:
1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<gateway-host>/api/v1/webhooks/git`
3. **Content type:** `application/json`
4. **Secret:** Same value as `GITHUB_WEBHOOK_SECRET`
5. **Events:** Select "Pull requests" only

## 5. Local Development Quickstart

```bash
# 1. Clone and install
git clone <repo-url> auto-swe
cd auto-swe
pnpm install

# 2. Start infrastructure
cp .env.example .env
# Edit .env with your API keys
docker compose up postgres temporal -d

# 3. Run migrations and seed
pnpm db:migrate
pnpm db:generate
pnpm db:seed

# 4. Register a target repository (manual DB insert for MVP)
# Use prisma studio: pnpm --filter shared prisma studio
# Insert a Repository record with organizationName, repoName, defaultBranch

# 5. Start services
pnpm dev:gateway   # Terminal 1
pnpm dev:worker    # Terminal 2

# 6. Submit a work request
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H 'Content-Type: application/json' \
  -d '{"externalTicketId": "JIRA-1234", "repoIds": ["<repo-uuid>"]}'

# 7. Monitor
# Temporal Web UI: http://localhost:8233
# Gateway API: http://localhost:8080/api/v1/workflows
```

## 6. Testing Strategy (MVP)

### Unit Tests

| Component | What to Test | Framework |
|---|---|---|
| Gateway routes | Request validation, error responses, DB record creation | Vitest + Supertest |
| Temporal workflow | Signal handling, timeout behavior, state transitions | `@temporalio/testing` (TestWorkflowEnvironment) |
| Activities | Mocked Prisma + mocked Docker exec | Vitest |
| Workspace | Container lifecycle (create, exec, destroy) | Vitest (integration, requires Docker) |

### End-to-End Test

A single E2E script that validates the full MVP path:

```typescript
// e2e/mvp.test.ts
// 1. POST /api/v1/work-requests with a real test repository
// 2. Poll GET /api/v1/workflows until status = 'AWAITING_HUMAN_MERGE'
// 3. Verify PR exists on GitHub
// 4. Merge the PR manually (or simulate via API)
// 5. POST /api/v1/webhooks/git with a mock merge payload
// 6. Poll GET /api/v1/workflows until status = 'COMPLETED'
// 7. Assert: workflow completed, PR marked as MERGED
```

## 7. Known Limitations & Future Work

| Limitation | Impact | Resolved In |
|---|---|---|
| No authentication | Anyone with network access can trigger workflows | Phase 3 |
| Single PAT for all repos | Token has broad access | Phase 3 (JIT scoped tokens) |
| No code review agents | Only human reviewer catches issues | Phase 2 |
| No CI/CD self-healing | Agent can't fix pipeline failures | Phase 2 |
| No semantic memory | Agent doesn't learn from past failures | Phase 4 |
| No cost tracking | Token spend is unmonitored | Phase 4 |
| Docker-in-Docker | Not suitable for production K8s | Phase 3 (K8s Jobs) |
| No OTel tracing | Limited observability | Phase 2 |
| Hardcoded test detection | Only detects `npm test` | Phase 2 (improved heuristics) |
