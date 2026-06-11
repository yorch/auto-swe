import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE Fastify creation so auto-instrumentation can patch
const otel = initTelemetry('auto-swe-gateway');

import { syncBuiltins } from '@auto-swe/shared/lib/syncBuiltins';
import { resolveConsolidationConfig } from '@auto-swe/shared/lib/systemConfig';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify, { type FastifyError } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { configuredProviders, getAuth, initAuth } from './lib/betterAuth.js';
import authPlugin, { extractSessionCookieValue, invalidateSessionCache } from './plugins/auth.js';
import { prismaPlugin } from './plugins/prisma.js';
import { temporalPlugin } from './plugins/temporal.js';
import { adminRoutes } from './routes/admin.js';
import { epicRoutes } from './routes/epics.js';
import { humanStepRoutes } from './routes/humanSteps.js';
import { lessonRoutes } from './routes/lessons.js';
import { meRoutes } from './routes/me.js';
import { modelConfigRoutes } from './routes/modelConfig.js';
import { repositoryRoutes } from './routes/repositories.js';
import { scannerPatternRoutes } from './routes/scannerPatterns.js';
import { scheduledWorkRequestRoutes } from './routes/scheduledWorkRequests.js';
import { securityEventRoutes } from './routes/securityEvents.js';
import { skillsRoutes, teamAgentSkillRoutes } from './routes/skills.js';
import { slackRoutes } from './routes/slack.js';
import { systemConfigRoutes } from './routes/systemConfig.js';
import { teamRoutes } from './routes/teams.js';
import { tokenRoutes } from './routes/tokens.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { stepRegistryRoutes, workflowRunRoutes } from './routes/workflowRuns.js';
import { workflowRoutes } from './routes/workflows.js';
import { workflowTemplateRoutes } from './routes/workflowTemplates.js';
import { workRequestRoutes } from './routes/workRequests.js';

async function start() {
  // Must run before betterAuth.handler is called — reads OAuth creds from DB.
  await initAuth();

  const app = Fastify({ logger: true });

  // Zod validation + serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — allow the web dashboard and any additional origins from env.
  // Explicitly list all methods used by the API so PUT/DELETE preflights pass.
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'],
    origin: process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? ['http://localhost:3000'],
  });

  // Raw body for HMAC webhook verification (opt-in per route)
  await app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  await app.register(cookie);

  // Rate limiting — auth routes use stricter per-route limits (see auth.ts)
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });

  // Plugins (decorate app with .temporal, .prisma, .auth)
  await app.register(prismaPlugin);
  await app.register(temporalPlugin);
  await app.register(authPlugin);

  // Sync built-in reference data (templates, skills, scanner patterns, tool
  // config) so every deploy automatically picks up new or updated built-ins.
  await syncBuiltins(app.prisma);

  // Sync the lesson consolidation Temporal Schedule with whatever config is in
  // the DB. Best-effort — a Temporal connectivity failure at startup shouldn't
  // crash the gateway; the admin can re-save from the UI once Temporal is up.
  resolveConsolidationConfig()
    .then((cfg) => app.temporal.syncConsolidationSchedule(cfg))
    .catch((err) => app.log.warn({ err }, 'consolidation schedule sync failed at startup'));

  // Global error handler. 4xx messages are intentional (validation, auth);
  // 5xx messages can leak internals (DB constraint text, library errors), so
  // log the detail server-side and return a generic message.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // ── Better Auth handler — multi-provider browser sign-in flow.
  // Mounted at /api/auth/* per the better-auth convention. Cookie-based
  // sessions live independently of the existing JWT/PAT bearer scheme;
  // the /api/v1/auth/session-token bridge below exchanges a valid
  // better-auth session for a short-lived JWT the rest of the API
  // already understands. ──
  app.route({
    // Tighter rate-limit on the wildcard auth surface. The global limit is
    // 200/min — way too permissive for sign-in / sign-up / reset endpoints
    // where credential-stuffing or magic-link spam should be capped.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    async handler(request, reply) {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = fromNodeHeaders(request.headers);
        // Snapshot the session-cookie value BEFORE better-auth runs — on a
        // successful /sign-out it'll clear the cookie in the response, and
        // we want to invalidate our in-memory cache for that token regardless.
        const sessionCookieBefore = extractSessionCookieValue(request.headers);
        const req = new Request(url.toString(), {
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          headers,
          method: request.method,
        });
        const response = await getAuth().handler(req);
        // Invalidate the cache for sign-out / revoke-session calls so the
        // logged-out user is locked out immediately instead of waiting up
        // to 60s for the cached entry to expire.
        if (
          response.status < 400 &&
          sessionCookieBefore &&
          (url.pathname.endsWith('/sign-out') || url.pathname.endsWith('/revoke-session'))
        ) {
          invalidateSessionCache(sessionCookieBefore);
        }
        reply.status(response.status);
        response.headers.forEach((value: string, key: string) => {
          reply.header(key, value);
        });
        return reply.send(response.body ? await response.text() : null);
      } catch (error) {
        app.log.error({ err: error }, 'better-auth handler failed');
        return reply.status(500).send({
          error: { code: 'AUTH_HANDLER_ERROR', message: 'Internal authentication error' },
        });
      }
    },
    method: ['GET', 'POST'],
    url: '/api/auth/*',
  });

  // Public: which social providers are configured? The login page reads
  // this to know whether to show GitHub / Google buttons (they're hidden
  // when the env vars are missing in dev).
  app.get('/api/v1/auth/providers', async () => configuredProviders());

  // Bridge: better-auth session cookie → existing JWT. The web app calls
  // this once after a successful social / magic-link login to get an
  // access token the rest of /api/v1/* recognises (PAT-or-JWT bearer).
  app.post('/api/v1/auth/session-token', async (request, reply) => {
    try {
      const headers = fromNodeHeaders(request.headers);
      const session = await getAuth().api.getSession({ headers });
      if (!session) {
        return reply.status(401).send({
          error: { code: 'NO_SESSION', message: 'No active better-auth session' },
        });
      }
      // Find the auto-swe User row to read role + slackId. better-auth's
      // user record carries our additionalFields (role, isActive, slackId)
      // but we re-fetch the canonical row in case it was updated.
      const user = await app.prisma.user.findUnique({ where: { id: session.user.id } });
      if (!user?.isActive) {
        return reply.status(403).send({
          error: { code: 'USER_INACTIVE', message: 'User account is not active' },
        });
      }
      const accessToken = app.auth.signAccessToken({
        role: user.role,
        ...(user.slackId ? { slackId: user.slackId } : {}),
        sub: user.id,
      });
      return reply.send({
        data: {
          accessToken,
          expiresIn: 3600,
          user: { email: user.email, id: user.id, role: user.role },
        },
      });
    } catch (err) {
      app.log.error({ err }, 'session-token bridge failed');
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'session-token bridge failed' },
      });
    }
  });

  // ── Public routes (no auth) ──

  // ── Personal access tokens (auth required, but self-service for engineers+) ──
  await app.register(tokenRoutes, { prefix: '/api/v1/auth/tokens' });

  // ── Protected routes ──
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(scheduledWorkRequestRoutes, { prefix: '/api/v1/scheduled-work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(stepRegistryRoutes, { prefix: '/api/v1/workflow-steps' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });
  await app.register(epicRoutes, { prefix: '/api/v1/epics' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(modelConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(systemConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/admin' });
  await app.register(securityEventRoutes, { prefix: '/api/v1/admin' });
  await app.register(skillsRoutes, { prefix: '/api/v1/admin' });
  await app.register(teamAgentSkillRoutes, { prefix: '/api/v1/teams' });
  await app.register(humanStepRoutes, { prefix: '/api/v1/inbox' });

  // Graceful shutdown: stop accepting connections, drain in-flight requests
  // (app.close() also runs plugin onClose hooks — prisma disconnect lives in
  // the prisma plugin), then flush OTel. Without this, Docker/Watchtower
  // restarts dropped in-flight requests and lost final spans.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down gracefully');
    try {
      await app.close();
      await otel.shutdown();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'graceful shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
}

start().catch(async (err) => {
  console.error('Gateway failed to start:', err);
  await otel.shutdown();
  process.exit(1);
});
