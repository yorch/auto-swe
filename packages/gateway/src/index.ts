import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE Fastify creation so auto-instrumentation can patch
const otel = initTelemetry('auto-swe-gateway');

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify, { type FastifyError } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { auth as betterAuth, configuredProviders } from './lib/betterAuth.js';
import authPlugin from './plugins/auth.js';
import { prismaPlugin } from './plugins/prisma.js';
import { temporalPlugin } from './plugins/temporal.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { epicRoutes } from './routes/epics.js';
import { lessonRoutes } from './routes/lessons.js';
import { repositoryRoutes } from './routes/repositories.js';
import { slackRoutes } from './routes/slack.js';
import { teamRoutes } from './routes/teams.js';
import { tokenRoutes } from './routes/tokens.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { stepRegistryRoutes, workflowRunRoutes } from './routes/workflowRuns.js';
import { workflowRoutes } from './routes/workflows.js';
import { workflowTemplateRoutes } from './routes/workflowTemplates.js';
import { workRequestRoutes } from './routes/workRequests.js';

async function start() {
  const app = Fastify({ logger: true });

  // Zod validation + serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — allow the web dashboard and any additional origins from env
  await app.register(cors, {
    credentials: true,
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

  // Global error handler
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
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

  // ── Better Auth handler — multi-provider browser sign-in flow.
  // Mounted at /api/auth/* per the better-auth convention. Cookie-based
  // sessions live independently of the existing JWT/PAT bearer scheme;
  // the /api/v1/auth/session-token bridge below exchanges a valid
  // better-auth session for a short-lived JWT the rest of the API
  // already understands. ──
  app.route({
    async handler(request, reply) {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = fromNodeHeaders(request.headers);
        const req = new Request(url.toString(), {
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          headers,
          method: request.method,
        });
        const response = await betterAuth.handler(req);
        reply.status(response.status);
        response.headers.forEach((value, key) => {
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
      const session = await betterAuth.api.getSession({ headers });
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
  await app.register(authRoutes, { prefix: '/api/v1/auth' });

  // ── Personal access tokens (auth required, but self-service for engineers+) ──
  await app.register(tokenRoutes, { prefix: '/api/v1/auth/tokens' });

  // ── Protected routes ──
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(stepRegistryRoutes, { prefix: '/api/v1/workflow-steps' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });
  await app.register(epicRoutes, { prefix: '/api/v1/epics' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
}

start().catch(async (err) => {
  console.error('Gateway failed to start:', err);
  await otel.shutdown();
  process.exit(1);
});
