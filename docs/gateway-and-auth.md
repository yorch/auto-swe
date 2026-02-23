# Interaction Gateway & Authentication

> Extracted from [PLAN.md](../PLAN.md) — Technical implementation detail for the Gateway service.

> ⚠️ **PHASE 3+ DOCUMENT** — This document describes the full authentication, RBAC, and Slack integration layer. **None of this is part of the Phase 1 MVP.** The MVP uses a hardcoded ADMIN role with no JWT auth (see `mvp-implementation.md`). Read this for future context only — do not implement during Phase 1.

## 1. Authentication & Session Strategy

All API requests (except webhooks, which use HMAC signature verification) require a Bearer JWT in the `Authorization` header.

### JWT Signing Key Management

JWTs are signed with RS256 (RSA-SHA256, asymmetric). The Gateway holds the private key; any service that needs to verify tokens only needs the public key.

```typescript
// config/auth.ts
export const AUTH_CONFIG = {
  jwt: {
    algorithm: 'RS256' as const,
    accessTokenTtl: '1h',
    // Private key loaded from K8s Secret (mounted as file, never in env vars)
    privateKeyPath: '/etc/secrets/jwt/private.pem',
    publicKeyPath: '/etc/secrets/jwt/public.pem',
  },
  refreshToken: {
    ttl: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    // Max active refresh tokens per user before oldest are revoked
    maxPerUser: 5,
  },
  password: {
    // bcrypt cost factor — 12 rounds (~250ms on modern hardware)
    bcryptRounds: 12,
  },
};
```

Key rotation: Keys are generated and stored in a Kubernetes Secret. To rotate, generate a new key pair, update the Secret, and perform a rolling restart of Gateway pods. During rotation, the Gateway accepts tokens signed by both the old and new keys (dual-key verification window of 2h).

### JWT Payload & Access Token Issuance

```typescript
// auth/jwt.ts
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { AUTH_CONFIG } from '../config/auth';

interface JwtPayload {
  sub: string;        // User UUID
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  slackId?: string;
  iat: number;
  exp: number;
}

const privateKey = readFileSync(AUTH_CONFIG.jwt.privateKeyPath);
const publicKey = readFileSync(AUTH_CONFIG.jwt.publicKeyPath);

export function signAccessToken(user: { id: string; role: string; slackId?: string | null }): string {
  return jwt.sign(
    { sub: user.id, role: user.role, slackId: user.slackId ?? undefined },
    privateKey,
    { algorithm: AUTH_CONFIG.jwt.algorithm, expiresIn: AUTH_CONFIG.jwt.accessTokenTtl }
  );
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, publicKey, { algorithms: [AUTH_CONFIG.jwt.algorithm] }) as JwtPayload;
}
```

### Login Endpoint

```typescript
// routes/auth.ts
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// POST /api/v1/auth/login
export async function login(req: Request): Promise<Response> {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return errorResponse(401, 'AUTH_FAILED', 'Invalid credentials');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return errorResponse(401, 'AUTH_FAILED', 'Invalid credentials');

  const accessToken = signAccessToken(user);
  const { refreshToken, refreshTokenHash } = generateRefreshToken();

  // Store hashed refresh token (never store plaintext)
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refreshTokenHash,
      expiresAt: new Date(Date.now() + AUTH_CONFIG.refreshToken.ttl),
    },
  });

  // Enforce max active tokens per user
  await pruneExcessRefreshTokens(user.id);

  return jsonResponse(200, {
    data: {
      accessToken,
      refreshToken,     // Plaintext — sent once, never stored server-side
      expiresIn: 3600,  // seconds
    },
  });
}

function generateRefreshToken(): { refreshToken: string; refreshTokenHash: string } {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  return { refreshToken, refreshTokenHash };
}

async function pruneExcessRefreshTokens(userId: string): Promise<void> {
  const tokens = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (tokens.length > AUTH_CONFIG.refreshToken.maxPerUser) {
    const toRevoke = tokens.slice(AUTH_CONFIG.refreshToken.maxPerUser);
    await prisma.refreshToken.updateMany({
      where: { id: { in: toRevoke.map(t => t.id) } },
      data: { revokedAt: new Date() },
    });
  }
}
```

### Refresh Token Rotation

Refresh tokens use **rotation with reuse detection**. Each token belongs to a `family`. When a refresh token is used, a new token is issued in the same family and the old one is revoked. If a revoked token is replayed (indicating theft), the entire family is invalidated.

```typescript
// POST /api/v1/auth/refresh
export async function refresh(req: Request): Promise<Response> {
  const { refreshToken } = req.body;
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  const storedToken = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!storedToken) return errorResponse(401, 'INVALID_TOKEN', 'Refresh token not found');

  // Reuse detection: if the token was already revoked, someone replayed a stolen token.
  // Revoke the entire family as a precaution.
  if (storedToken.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { family: storedToken.family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return errorResponse(401, 'TOKEN_REUSE_DETECTED', 'Possible token theft. All sessions in this family revoked.');
  }

  if (storedToken.expiresAt < new Date()) {
    return errorResponse(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
  }

  const user = await prisma.user.findUnique({ where: { id: storedToken.userId } });
  if (!user || !user.isActive) return errorResponse(401, 'AUTH_FAILED', 'User account is inactive');

  // Revoke the current token
  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { revokedAt: new Date() },
  });

  // Issue new token in the same family
  const { refreshToken: newRefreshToken, refreshTokenHash } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refreshTokenHash,
      family: storedToken.family,  // Same family for reuse detection
      expiresAt: new Date(Date.now() + AUTH_CONFIG.refreshToken.ttl),
    },
  });

  const accessToken = signAccessToken(user);

  return jsonResponse(200, {
    data: { accessToken, refreshToken: newRefreshToken, expiresIn: 3600 },
  });
}
```

### RBAC Hook (Fastify `onRequest` Hook)

The RBAC check is implemented as a Fastify `onRequest` hook via a plugin. Routes declare their minimum role in `route.config`, and the hook enforces it.

```typescript
// plugins/rbac.ts
import fp from 'fastify-plugin';
import { verifyAccessToken } from '../auth/jwt';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

// Role hierarchy: ADMIN > LEAD > ENGINEER
const ROLE_HIERARCHY: Record<string, number> = { ENGINEER: 1, LEAD: 2, ADMIN: 3 };

type MinimumRole = 'ENGINEER' | 'LEAD' | 'ADMIN';

// Augment Fastify types to carry user context and route-level RBAC config
declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; role: MinimumRole; slackId?: string };
  }
  interface FastifyContextConfig {
    requiredRole?: MinimumRole;
  }
}

const rbacPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const minimumRole = request.routeOptions.config.requiredRole;
    if (!minimumRole) return; // No role requirement on this route (e.g., health check)

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Missing Bearer token' } });
    }

    try {
      const payload = verifyAccessToken(authHeader.slice(7));

      const userLevel = ROLE_HIERARCHY[payload.role] ?? 0;
      const requiredLevel = ROLE_HIERARCHY[minimumRole];

      if (userLevel < requiredLevel) {
        return reply.status(403).send({
          error: { code: 'INSUFFICIENT_ROLE', message: `${minimumRole} role required. Your role: ${payload.role}` },
        });
      }

      request.user = { id: payload.sub, role: payload.role as MinimumRole, slackId: payload.slackId };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return reply.status(401).send({ error: { code: 'TOKEN_EXPIRED', message: 'Access token has expired' } });
      }
      return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token verification failed' } });
    }
  });
};

export default fp(rbacPlugin, { fastify: '5.x', name: 'rbac' });

// Route registration example (role declared in config):
// app.post('/api/v1/epics', { config: { requiredRole: 'LEAD' } }, epicHandler);
// app.delete('/api/v1/workflows/:id', { config: { requiredRole: 'ADMIN' } }, terminateHandler);
// app.get('/api/v1/workflows', { config: { requiredRole: 'ENGINEER' } }, listHandler);
```

### Slack OAuth Flow (Linking slack_id to User)

Users link their Slack identity to their system account via OAuth 2.0 (`Sign in with Slack`). This populates the `User.slackId` field, enabling role-checked Slack interactive webhooks.

```
1. User visits: GET /api/v1/auth/slack/connect
   → Redirects to Slack OAuth authorize URL:
     https://slack.com/oauth/v2/authorize?
       client_id=SLACK_CLIENT_ID&
       scope=identity.basic,identity.email&
       redirect_uri=https://gateway.example.com/api/v1/auth/slack/callback&
       state=<signed-jwt-containing-userId>

2. User approves in Slack UI.

3. Slack redirects to: GET /api/v1/auth/slack/callback?code=<code>&state=<state>

4. Gateway handler:
   a. Verify `state` JWT to extract the authenticated userId
   b. Exchange `code` for Slack access token via POST https://slack.com/api/oauth.v2.access
   c. Call GET https://slack.com/api/users.identity with the token to get slack_id
   d. Update user record:
      await prisma.user.update({
        where: { id: userId },
        data: { slackId: slackIdentity.user.id },
      });
   e. Redirect user to dashboard with success message
```

```typescript
// routes/slackOAuth.ts
// GET /api/v1/auth/slack/callback
export async function slackCallback(req: Request): Promise<Response> {
  // a. Verify state contains a valid user session
  const { userId } = verifyAccessToken(req.query.state as string);

  // b. Exchange code for token
  const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code: req.query.code as string,
      redirect_uri: `${process.env.GATEWAY_URL}/api/v1/auth/slack/callback`,
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenData.ok) return errorResponse(400, 'SLACK_AUTH_FAILED', tokenData.error);

  // c. Get Slack user identity
  const identityResponse = await fetch('https://slack.com/api/users.identity', {
    headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
  });
  const identity = await identityResponse.json();

  // d. Check that this slack_id isn't already linked to another user
  const existingUser = await prisma.user.findUnique({ where: { slackId: identity.user.id } });
  if (existingUser && existingUser.id !== userId) {
    return errorResponse(409, 'SLACK_ALREADY_LINKED', 'This Slack account is already linked to another user');
  }

  // e. Link Slack identity
  await prisma.user.update({
    where: { id: userId },
    data: { slackId: identity.user.id },
  });

  return redirect(302, `${process.env.DASHBOARD_URL}/settings?slack=linked`);
}
```

### Slack Webhook Authentication (for Interactive Messages)

When Slack sends an interactive webhook (button click, modal submit), the request does not carry a JWT. Instead, the Gateway verifies the request using Slack's signing secret and resolves the user's role from the embedded `slack_id`. Raw body access is provided by `fastify-raw-body`.

```typescript
// hooks/slackAuth.ts
import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Requires fastify-raw-body plugin registered with { global: false, runFirst: true }
// Slack webhook routes opt in with: { config: { rawBody: true } }

export async function verifySlackRequest(request: FastifyRequest, reply: FastifyReply) {
  const timestamp = request.headers['x-slack-request-timestamp'] as string;
  const signature = request.headers['x-slack-signature'] as string;

  // Reject requests older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return reply.status(401).send({ error: { code: 'SLACK_REPLAY', message: 'Request too old' } });
  }

  // Compute expected signature using raw body from fastify-raw-body
  const sigBasestring = `v0:${timestamp}:${request.rawBody}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET!)
    .update(sigBasestring)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return reply.status(401).send({ error: { code: 'SLACK_SIGNATURE_INVALID', message: 'Signature mismatch' } });
  }

  // Resolve user by slack_id from the payload
  const payload = JSON.parse((request.body as any).payload);
  const slackUserId = payload.user.id;

  const user = await prisma.user.findUnique({ where: { slackId: slackUserId } });
  if (!user || !user.isActive) {
    return reply.send({
      response_type: 'ephemeral',
      text: 'Your Slack account is not linked to the engineering system. Visit the dashboard to connect.',
    });
  }

  request.user = { id: user.id, role: user.role as MinimumRole, slackId: slackUserId };
}

// Used in Slack webhook route:
// app.post('/api/v1/webhooks/slack', { config: { rawBody: true }, preHandler: [verifySlackRequest] }, slackHandler);
```

## 2. RBAC Permission Matrix

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

## 3. Gateway API Specification

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
  Body: { externalTicketId: string, description: string, repoIds: string[], slackChannel?: string }
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

## 4. Webhook Endpoints

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

## 5. Standard Error Responses

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
