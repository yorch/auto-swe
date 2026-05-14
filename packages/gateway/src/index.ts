import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE Fastify creation so auto-instrumentation can patch
const otel = initTelemetry('auto-swe-gateway');

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
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
