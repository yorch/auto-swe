# MVP Technical Implementation Guide (Phase 1)

> This document provides the complete, step-by-step technical implementation for the MVP. It covers project structure, configuration, every file that needs to be written, and the exact build order. Refer to [mvp-architecture.md](./mvp-architecture.md) for design rationale.

## 1. Project Structure

```
auto-swe/
├── docker-compose.yml
├── .env                          # Local secrets (git-ignored)
├── .env.example                  # Template for .env
├── .gitignore
├── .yarnrc.yml                   # Yarn 4 config (node-modules linker)
├── package.json                  # Root workspace config (Yarn 4)
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
│   │       │   ├── seed.ts
│   │       │   └── migrations/
│   │       ├── db.ts             # Singleton PrismaClient export
│   │       └── index.ts          # Barrel export
│   │
│   ├── gateway/                  # Interaction Gateway (Fastify 5.x)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts          # Fastify app bootstrap
│   │       ├── plugins/
│   │       │   ├── temporal.ts   # Temporal client plugin (fastify-plugin)
│   │       │   └── prisma.ts     # Prisma client plugin (fastify-plugin)
│   │       ├── routes/
│   │       │   ├── workRequests.ts
│   │       │   ├── workflows.ts
│   │       │   └── webhooks.ts
│   │       └── lib/
│   │           └── github.ts     # HMAC verification helper
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
│               ├── implementer.ts  # Mastra agent config + tool bindings
│               └── prompts.ts      # System prompts
```

## 2. Build Order

The implementation should proceed in this exact order. Each step produces a testable artifact.

| Step | What | Depends On | Validation |
|---|---|---|---|
| 1 | Monorepo scaffold + toolchain (Yarn 4) | — | `yarn install` succeeds |
| 2 | Prisma schema + Docker Compose (Postgres + Temporal) | Step 1 | `yarn prisma migrate dev` succeeds, `docker compose up` runs |
| 3 | Shared types package + Prisma client singleton | Step 1 | TypeScript compiles |
| 4 | Gateway: Fastify bootstrap + health endpoint | Steps 1-3 | `curl localhost:8080/health` returns 200 |
| 5 | Gateway: `POST /api/v1/work-requests` | Steps 2-4 | Creates DB records, returns `workRequestId` |
| 6 | Gateway: Temporal client plugin | Steps 2, 5 | Work request starts a Temporal workflow |
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

### Step 1: Monorepo Scaffold (Yarn 4)

```bash
# Initialize Yarn 4 via corepack (ships with Node.js 20+)
corepack enable
corepack use yarn@4.12.0
```

**package.json (root):**
```json
{
  "name": "auto-swe",
  "private": true,
  "packageManager": "yarn@4.12.0",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "yarn workspaces foreach -A run build",
    "dev:gateway": "yarn workspace @auto-swe/gateway dev",
    "dev:worker": "yarn workspace @auto-swe/worker dev",
    "db:migrate": "yarn workspace @auto-swe/shared prisma migrate dev",
    "db:generate": "yarn workspace @auto-swe/shared prisma generate",
    "db:seed": "yarn workspace @auto-swe/shared prisma db seed",
    "db:studio": "yarn workspace @auto-swe/shared prisma studio"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

**.yarnrc.yml:**
```yaml
nodeLinker: node-modules
enableGlobalCache: false
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

**.gitignore (additions for Yarn 4 non-zero-installs):**
```
node_modules/
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/sdks
!.yarn/versions
dist/
.env
```

### Step 2: Prisma Schema + Docker Compose

**packages/shared/package.json:**
```json
{
  "name": "@auto-swe/shared",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./db": "./dist/db.js",
    "./types/workflow": "./dist/types/workflow.js",
    "./types/api": "./dist/types/api.js"
  },
  "scripts": {
    "build": "tsc",
    "prisma": "prisma"
  },
  "dependencies": {
    "@prisma/client": "^7.4.0",
    "bcrypt": "^5.1.0"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.0",
    "prisma": "^7.4.0",
    "typescript": "^5.7.0"
  },
  "prisma": {
    "schema": "src/prisma/schema.prisma",
    "seed": "tsx src/prisma/seed.ts"
  }
}
```

**packages/shared/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/prisma/migrations"]
}
```

**packages/shared/src/prisma/schema.prisma:**
```prisma
generator client {
  provider        = "prisma-client"
  previewFeatures = ["tracing"]
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
  mcpServerRef     String?          @map("mcp_server_ref")
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

**packages/shared/src/db.ts:**
```typescript
import { PrismaClient } from '@prisma/client';

// Singleton PrismaClient — shared across the process.
// Import as: import { prisma } from '@auto-swe/shared/db';
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

**packages/shared/src/index.ts:**
```typescript
export { prisma } from './db';
export type * from './types/workflow';
export type * from './types/api';
```

**packages/shared/src/prisma/seed.ts:**
```typescript
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Seed admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@auto-swe.local' },
    update: {},
    create: {
      email: 'admin@auto-swe.local',
      passwordHash: await bcrypt.hash('admin', 12),
      role: 'ADMIN',
    },
  });
  console.log(`Seed: admin user created (${admin.id})`);

  // Seed a sample repository for local development.
  // Update organizationName and repoName to match your target GitHub repo.
  const repo = await prisma.repository.upsert({
    where: {
      organizationName_repoName: {
        organizationName: 'your-org',
        repoName: 'your-repo',
      },
    },
    update: {},
    create: {
      organizationName: 'your-org',
      repoName: 'your-repo',
      defaultBranch: 'main',
    },
  });
  console.log(`Seed: sample repository created (${repo.id})`);
  console.log('');
  console.log('  To submit a work request, use this repo ID:');
  console.log(`    curl -X POST http://localhost:8080/api/v1/work-requests \\`);
  console.log(`      -H 'Content-Type: application/json' \\`);
  console.log(`      -d '{"externalTicketId":"JIRA-1","description":"Add health endpoint","repoIds":["${repo.id}"]}'`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

**docker-compose.yml:**
```yaml
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

  # Temporal gets its own Postgres to avoid schema conflicts with pgvector
  postgres-temporal:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: password
    volumes:
      - pgdata-temporal:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

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
  pgdata-temporal:
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
  description: string;          // What the agent should implement
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
  description: string;           // Human-readable description of what to implement
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
  repository: { full_name: string };
}
```

### Step 4: Gateway Bootstrap (Fastify 5.x)

**packages/gateway/package.json:**
```json
{
  "name": "@auto-swe/gateway",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "fastify": "^5.7.0",
    "fastify-plugin": "^5.0.0",
    "fastify-raw-body": "^5.0.0",
    "fastify-type-provider-zod": "^4.0.0",
    "zod": "^3.24.0",
    "@temporalio/client": "^1.11.0",
    "@auto-swe/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

**packages/gateway/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

**packages/gateway/src/index.ts:**
```typescript
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import fastifyRawBody from 'fastify-raw-body';
import { temporalPlugin } from './plugins/temporal';
import { prismaPlugin } from './plugins/prisma';
import { workRequestRoutes } from './routes/workRequests';
import { workflowRoutes } from './routes/workflows';
import { webhookRoutes } from './routes/webhooks';

async function start() {
  const app = Fastify({ logger: true });

  // Zod validation + serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Raw body for HMAC webhook verification (opt-in per route)
  await app.register(fastifyRawBody, { global: false, runFirst: true, encoding: 'utf8' });

  // Plugins (decorate app with .temporal and .prisma)
  await app.register(prismaPlugin);
  await app.register(temporalPlugin);

  // Global error handler
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.message,
      },
    });
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Route plugins
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error('Gateway failed to start:', err);
  process.exit(1);
});
```

### Step 5: Gateway Plugins

**packages/gateway/src/plugins/prisma.ts:**
```typescript
import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const prisma = new PrismaClient();
  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
};

export { prismaPlugin };
export default fp(prismaPlugin, { fastify: '5.x', name: 'prisma' });
```

**packages/gateway/src/plugins/temporal.ts:**
```typescript
import fp from 'fastify-plugin';
import { Client, Connection } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';

declare module 'fastify' {
  interface FastifyInstance {
    temporal: {
      startWorkflow: (workflowId: string, request: RepoWorkRequest) => Promise<void>;
      signalWorkflow: (workflowId: string, signalName: string, args?: unknown[]) => Promise<void>;
    };
  }
}

const temporalPlugin: FastifyPluginAsync = async (fastify) => {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  fastify.decorate('temporal', {
    async startWorkflow(workflowId: string, request: RepoWorkRequest): Promise<void> {
      await client.workflow.start('EngineeringWorkflow', {
        taskQueue: 'engineering-workflow',
        workflowId,
        args: [request],
      });
    },

    async signalWorkflow(workflowId: string, signalName: string, args: unknown[] = []): Promise<void> {
      const handle = client.workflow.getHandle(workflowId);
      await handle.signal(signalName, ...args);
    },
  });

  fastify.addHook('onClose', async () => {
    await connection.close();
  });
};

export { temporalPlugin };
export default fp(temporalPlugin, { fastify: '5.x', name: 'temporal' });
```

### Step 6: Work Request Route

**packages/gateway/src/routes/workRequests.ts:**
```typescript
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const CreateWorkRequestSchema = z.object({
  externalTicketId: z.string().min(1),
  description: z.string().min(1, 'description is required — tell the agent what to implement'),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/', {
    schema: {
      body: CreateWorkRequestSchema,
    },
  }, async (request, reply) => {
    const { externalTicketId, description, repoIds } = request.body;

    // Verify repository exists
    const repo = await fastify.prisma.repository.findUnique({ where: { id: repoIds[0] } });
    if (!repo || !repo.isActive) {
      return reply.status(404).send({
        error: { code: 'REPO_NOT_FOUND', message: `Repository ${repoIds[0]} not found or inactive` },
      });
    }

    // Create work request
    const workRequest = await fastify.prisma.workRequest.create({
      data: {
        externalTicketId,
        description,
        requestPayload: JSON.stringify(request.body),
      },
    });

    // Generate Temporal workflow ID (deterministic for idempotency)
    const temporalWorkflowId = `eng-${externalTicketId}-${repo.repoName}`;
    const branch = `auto/${externalTicketId}`;

    // Create ActiveWorkflow record
    const activeWorkflow = await fastify.prisma.activeWorkflow.create({
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
      await fastify.temporal.startWorkflow(temporalWorkflowId, {
        workRequestId: workRequest.id,
        repoId: repo.id,
        externalTicketId,
        description,
        requestPayload: JSON.stringify(request.body),
      });
    } catch (err: any) {
      if (err.name === 'WorkflowExecutionAlreadyStartedError') {
        return reply.status(409).send({
          error: { code: 'WORKFLOW_ALREADY_EXISTS', message: `Workflow already running for ${externalTicketId}` },
        });
      }
      throw err;
    }

    return reply.status(201).send({
      data: {
        workRequestId: workRequest.id,
        workflowIds: [activeWorkflow.id],
      },
    });
  });
};
```

### Step 7: Workflow Routes (Debug)

**packages/gateway/src/routes/workflows.ts:**
```typescript
import type { FastifyPluginAsync } from 'fastify';

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/workflows
  fastify.get('/', async () => {
    const workflows = await fastify.prisma.activeWorkflow.findMany({
      include: { repository: true, pullRequests: true },
      orderBy: { updatedAt: 'desc' },
    });
    return { data: workflows };
  });

  // GET /api/v1/workflows/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const workflow = await fastify.prisma.activeWorkflow.findUnique({
      where: { id: request.params.id },
      include: { repository: true, pullRequests: true, workRequest: true },
    });
    if (!workflow) {
      return reply.status(404).send({
        error: { code: 'WORKFLOW_NOT_FOUND', message: `No workflow with id ${request.params.id}` },
      });
    }
    return { data: workflow };
  });
};
```

### Step 8: Webhook Route (Git Merge)

**packages/gateway/src/routes/webhooks.ts:**
```typescript
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/webhooks/git
  // Uses fastify-raw-body for HMAC verification
  fastify.post('/git', {
    config: { rawBody: true },
  }, async (request, reply) => {
    // Verify GitHub HMAC signature
    const signature = request.headers['x-hub-signature-256'] as string;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret || !signature) {
      return reply.status(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Missing signature' } });
    }

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(request.rawBody!).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return reply.status(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED', message: 'Invalid signature' } });
    }

    const payload = request.body as any;

    // Only handle merged pull_request events
    if (payload.action !== 'closed' || !payload.pull_request?.merged) {
      return { data: { ignored: true } };
    }

    const prNumber = payload.pull_request.number;
    const repoFullName = payload.repository.full_name;
    const [org, repoName] = repoFullName.split('/');

    // Find the tracked PR
    const pullRequest = await fastify.prisma.pullRequest.findFirst({
      where: {
        prNumber,
        repository: { organizationName: org, repoName },
        status: 'OPEN',
      },
      include: { workflow: true },
    });

    if (!pullRequest?.workflow) {
      return { data: { ignored: true, reason: 'No tracked workflow for this PR' } };
    }

    // Update PR status
    await fastify.prisma.pullRequest.update({
      where: { id: pullRequest.id },
      data: { status: 'MERGED' },
    });

    // Signal the Temporal workflow
    await fastify.temporal.signalWorkflow(
      pullRequest.workflow.temporalWorkflowId,
      'humanMergeSignal',
      [true],
    );

    return { data: { signalSent: true, workflowId: pullRequest.workflow.temporalWorkflowId } };
  });
};
```

### Step 9: Worker Bootstrap

**packages/worker/package.json:**
```json
{
  "name": "@auto-swe/worker",
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
    "@mastra/anthropic": "^1.0.0",
    "@octokit/rest": "^21.0.0",
    "@auto-swe/shared": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

**packages/worker/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
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
    // Temporal bundles workflows separately (V8 isolate).
    // Only type-only imports are allowed in workflow files.
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

### Step 10: Workflow + Activities

**packages/worker/src/workflows/engineering.ts:**

> **Important Temporal constraint:** Workflow files run in a V8 isolate, not Node.js. Only `import type` is allowed for external packages. All runtime imports must come from `@temporalio/workflow`.

```typescript
import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities';
import type { RepoWorkRequest, WorkflowResult } from '@auto-swe/shared/types/workflow';

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
import { prisma } from '@auto-swe/shared/db';

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
import { execSync, type ExecSyncOptions } from 'node:child_process';
import crypto from 'node:crypto';

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

  const authedUrl = repoUrl.replace(
    'https://',
    `https://x-access-token:${githubToken}@`,
  );

  // Start container with git installed
  execSync(
    `docker run -d --name ${containerName} ${image} sleep infinity`,
    EXEC_OPTS,
  );

  // Initial exec function (root of container)
  const rootExec = (command: string): string => {
    return execSync(
      `docker exec ${containerName} sh -c '${command.replace(/'/g, "'\\''")}'`,
      EXEC_OPTS,
    ) as string;
  };

  // Install git if not present (alpine images may not have it)
  rootExec('which git || apk add --no-cache git');

  // Clone repo
  rootExec(`git clone --depth=50 -b ${defaultBranch} '${authedUrl}' /workspace/target-repo`);
  rootExec(`cd /workspace/target-repo && git checkout -b '${branch}'`);

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
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest, CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { createWorkspace } from './workspace';
import { createImplementerAgent } from '../agents/implementer';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts';

const MAX_TDD_ITERATIONS = 5;

export async function executeImplementation(
  request: RepoWorkRequest,
): Promise<CodeResult> {
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const repoUrl = `https://github.com/${repo.organizationName}/${repo.repoName}.git`;
  const branch = `auto/${request.externalTicketId}`;
  const githubToken = process.env.GITHUB_TOKEN!;

  const workspace = createWorkspace(
    repoUrl,
    branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:20-alpine',
  );

  try {
    heartbeat('workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Create Mastra agent with tools bound to workspace
    const { agent } = createImplementerAgent(workspace);

    let testResult: TestRunResult = {
      passed: false, total: 0, passing: 0, failing: 0, stdout: '', duration_ms: 0,
    };

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      await agent.generate(
        [
          { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              description: request.description,
              externalTicketId: request.externalTicketId,
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
          passed: false, total: 0, passing: 0, failing: 1,
          stdout: err.stdout?.slice(-10_000) ?? err.message,
          duration_ms: 0,
        };
      }
    }

    // Commit and push
    workspace.exec('git add -A');
    workspace.exec(`git commit -m "auto: implement ${request.externalTicketId}"`);
    workspace.exec(`git push origin '${branch}'`);

    // Collect results
    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch,
      headSha,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Completed in ${formatIterationCount(testResult)} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    };
  } finally {
    workspace.destroy();
  }
}

function formatIterationCount(result: TestRunResult): string {
  return result.passed ? '≤5' : '5 (max)';
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
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest, CodeResult } from '@auto-swe/shared/types/workflow';

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
    `**Description:** ${request.description}`,
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

### Step 11: Implementer Agent with Tool Bindings

> ⚠️ **VERIFY MASTRA API BEFORE IMPLEMENTING** — The code below is based on pre-release Mastra 1.0 documentation. The constructor shape (`new Mastra({ agents: { ... } })`), tool creation pattern (`createTool`), and model binding (`anthropic('claude-opus-4-6')`) must be verified against the actual released `@mastra/core` and `@mastra/anthropic` packages. Install them first, check their exported APIs, and adapt if needed. The intent and architecture are correct — only the exact API surface may differ.

**packages/worker/src/agents/prompts.ts:**
```typescript
export const IMPLEMENTER_SYSTEM_PROMPT = `You are a highly constrained Surgical Coder operating within an isolated repository environment.

INSTRUCTIONS:
1. Read the description carefully. Understand what needs to be implemented.
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
import { createTool } from '@mastra/core';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace';

/**
 * Creates a Mastra Implementer agent with MCP-style tools bound to a specific workspace container.
 * Each tool call is translated to a `docker exec` command inside the workspace.
 */
export function createImplementerAgent(workspace: Workspace) {
  // Tool: Read a file from the workspace
  const readFile = createTool({
    id: 'readFile',
    description: 'Read the contents of a file in the workspace',
    inputSchema: z.object({ path: z.string().describe('Relative path from repo root') }),
    execute: async ({ context }) => {
      try {
        return workspace.exec(`cat '${context.path}'`);
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      }
    },
  });

  // Tool: Write/overwrite a file in the workspace
  const writeFile = createTool({
    id: 'writeFile',
    description: 'Create or overwrite a file in the workspace',
    inputSchema: z.object({
      path: z.string().describe('Relative path from repo root'),
      content: z.string().describe('Full file content'),
    }),
    execute: async ({ context }) => {
      workspace.exec(`mkdir -p "$(dirname '${context.path}')"`);
      // Write via base64 to avoid shell escaping issues
      const b64 = Buffer.from(context.content).toString('base64');
      workspace.exec(`echo '${b64}' | base64 -d > '${context.path}'`);
      return `File written: ${context.path}`;
    },
  });

  // Tool: List directory contents
  const listDirectory = createTool({
    id: 'listDirectory',
    description: 'List files and directories at a given path',
    inputSchema: z.object({ path: z.string().default('.').describe('Relative path from repo root') }),
    execute: async ({ context }) => {
      try {
        return workspace.exec(`ls -la '${context.path}'`);
      } catch (err: any) {
        return `Error listing directory: ${err.message}`;
      }
    },
  });

  // Tool: Execute a bash command in the workspace
  const bash = createTool({
    id: 'bash',
    description: 'Execute a shell command in the workspace (e.g., run tests, install deps)',
    inputSchema: z.object({ command: z.string().describe('Shell command to execute') }),
    execute: async ({ context }) => {
      try {
        return workspace.exec(context.command);
      } catch (err: any) {
        return `Command failed (exit code ${err.status}):\n${err.stdout ?? ''}\n${err.stderr ?? err.message}`;
      }
    },
  });

  const mastra = new Mastra({
    agents: {
      implementer: {
        name: 'implementer',
        model: anthropic('claude-opus-4-6'),
        instructions: '', // Set per-call via system message
        tools: { readFile, writeFile, listDirectory, bash },
      },
    },
  });

  return { agent: mastra.getAgent('implementer'), mastra };
}
```

### Step 12: Activity Barrel Export

**packages/worker/src/activities/index.ts:**
```typescript
export { updateDomainState } from './state';
export { executeImplementation } from './executeImplementation';
export { createOrUpdatePullRequest } from './createOrUpdatePullRequest';
```

### Dockerfiles

> **Yarn 4 monorepo Docker strategy:** These use a 3-stage build pattern:
> 1. **builder** — Full `yarn install --immutable` (validates lockfile) + TypeScript compile
> 2. **prod-deps** — `yarn workspaces focus <pkg> --production` (strips devDependencies, ignores unrelated workspaces)
> 3. **runtime** — Minimal image with only production `node_modules` + compiled output
>
> With `nodeLinker: node-modules`, Yarn 4 hoists most dependencies to the root `node_modules/`. Workspace cross-references (`@auto-swe/shared`) become symlinks. The root `package.json` is copied to runtime so Node can resolve these symlinks. Prisma's generated client lives in `node_modules/.prisma` and `node_modules/@prisma`, so those are copied explicitly.

**packages/gateway/Dockerfile:**
```dockerfile
# ── Stage 1: Build ──
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY .yarnrc.yml yarn.lock package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
RUN yarn install --immutable

COPY packages/shared/ packages/shared/
COPY packages/gateway/ packages/gateway/
RUN yarn workspace @auto-swe/shared prisma generate \
 && yarn workspace @auto-swe/shared build \
 && yarn workspace @auto-swe/gateway build

# ── Stage 2: Production dependencies only ──
FROM node:20-alpine AS prod-deps
RUN corepack enable
WORKDIR /app

COPY .yarnrc.yml yarn.lock package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
RUN yarn workspaces focus @auto-swe/gateway --production

# ── Stage 3: Runtime ──
FROM node:20-alpine
WORKDIR /app

# Production node_modules (hoisted root deps)
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma generated client (lives inside node_modules)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Workspace package.json files (for symlink resolution)
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/gateway/package.json ./packages/gateway/

# Built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist

# Root package.json (for workspace symlink resolution)
COPY package.json ./

CMD ["node", "packages/gateway/dist/index.js"]
```

**packages/worker/Dockerfile:**
```dockerfile
# ── Stage 1: Build ──
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY .yarnrc.yml yarn.lock package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN yarn install --immutable

COPY packages/shared/ packages/shared/
COPY packages/worker/ packages/worker/
RUN yarn workspace @auto-swe/shared prisma generate \
 && yarn workspace @auto-swe/shared build \
 && yarn workspace @auto-swe/worker build

# ── Stage 2: Production dependencies only ──
FROM node:20-alpine AS prod-deps
RUN corepack enable
WORKDIR /app

COPY .yarnrc.yml yarn.lock package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN yarn workspaces focus @auto-swe/worker --production

# ── Stage 3: Runtime ──
FROM node:20-alpine
# Worker needs Docker CLI to manage workspace containers (DinD)
RUN apk add --no-cache docker-cli
WORKDIR /app

# Production node_modules (hoisted root deps)
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma generated client (lives inside node_modules)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Workspace package.json files (for symlink resolution)
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/worker/package.json ./packages/worker/

# Built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/worker/dist ./packages/worker/dist

# Root package.json (for workspace symlink resolution)
COPY package.json ./

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
corepack enable
yarn install

# 2. Start infrastructure
cp .env.example .env
# Edit .env with your API keys
docker compose up postgres postgres-temporal temporal -d

# 3. Run migrations and seed
yarn db:migrate
yarn db:generate
yarn db:seed

# 4. Register a target repository
# Edit packages/shared/src/prisma/seed.ts — set organizationName and repoName to your GitHub repo
yarn db:seed
# The seed output will print the repo UUID for use in work requests

# 5. Start services
yarn dev:gateway   # Terminal 1
yarn dev:worker    # Terminal 2

# 6. Submit a work request
curl -X POST http://localhost:8080/api/v1/work-requests \
  -H 'Content-Type: application/json' \
  -d '{
    "externalTicketId": "JIRA-1234",
    "description": "Add a GET /api/health endpoint that returns { status: ok }",
    "repoIds": ["<repo-uuid>"]
  }'

# 7. Monitor
# Temporal Web UI: http://localhost:8233
# Gateway API: http://localhost:8080/api/v1/workflows
```

## 6. Testing Strategy (MVP)

### Unit Tests

| Component | What to Test | Framework |
|---|---|---|
| Gateway routes | Request validation, error responses, DB record creation | Vitest + `light-my-request` (Fastify's built-in test helper) |
| Temporal workflow | Signal handling, timeout behavior, state transitions | `@temporalio/testing` (TestWorkflowEnvironment) |
| Activities | Mocked Prisma + mocked Docker exec | Vitest |
| Workspace | Container lifecycle (create, exec, destroy) | Vitest (integration, requires Docker) |

### Test Configuration

**vitest.config.ts (root):**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/prisma/migrations/**'],
    },
  },
});
```

Add to **package.json (root)** scripts:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

### Example Unit Test

**packages/gateway/src/routes/workRequests.test.ts:**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { workRequestRoutes } from './workRequests';

describe('POST /api/v1/work-requests', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Mock prisma and temporal on the app instance
    app.decorate('prisma', {
      repository: {
        findUnique: async () => ({ id: 'repo-1', isActive: true, repoName: 'test', organizationName: 'org' }),
      },
      workRequest: { create: async (args: any) => ({ id: 'wr-1', ...args.data }) },
      activeWorkflow: { create: async (args: any) => ({ id: 'wf-1', ...args.data }) },
    });
    app.decorate('temporal', {
      startWorkflow: async () => {},
      signalWorkflow: async () => {},
    });

    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterAll(() => app.close());

  it('rejects missing description', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/work-requests',
      payload: { externalTicketId: 'JIRA-1', repoIds: ['repo-1'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a work request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/work-requests',
      payload: {
        externalTicketId: 'JIRA-1',
        description: 'Add health endpoint',
        repoIds: ['repo-1'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.workRequestId).toBeDefined();
  });
});
```

### End-to-End Test

A single E2E script that validates the full MVP path:

```typescript
// e2e/mvp.test.ts
// 1. POST /api/v1/work-requests with a real test repository
// 2. Poll GET /api/v1/workflows until status = 'AWAITING_HUMAN_MERGE'
// 3. Verify PR exists on GitHub
// 4. Merge the PR manually (or simulate via API)
// 5. POST /api/v1/webhooks/git with a mock merge payload (signed with HMAC)
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
