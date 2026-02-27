import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import fastifyRawBody from 'fastify-raw-body';
import { temporalPlugin } from './plugins/temporal.js';
import { prismaPlugin } from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import { workRequestRoutes } from './routes/workRequests.js';
import { workflowRoutes } from './routes/workflows.js';
import { webhookRoutes } from './routes/webhooks.js';
import { authRoutes } from './routes/auth.js';
import { teamRoutes } from './routes/teams.js';
import { userRoutes } from './routes/users.js';
import { repositoryRoutes } from './routes/repositories.js';
import { lessonRoutes } from './routes/lessons.js';
import { slackRoutes } from './routes/slack.js';

async function start() {
  const app = Fastify({ logger: true });

  // Zod validation + serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — allow the web dashboard and any additional origins from env
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? ['http://localhost:3000'],
    credentials: true,
  });

  // Raw body for HMAC webhook verification (opt-in per route)
  await app.register(fastifyRawBody, { global: false, runFirst: true, encoding: 'utf8' });

  // Plugins (decorate app with .temporal, .prisma, .auth)
  await app.register(prismaPlugin);
  await app.register(temporalPlugin);
  await app.register(authPlugin);

  // Global error handler
  app.setErrorHandler(async (error: any, request, reply) => {
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

  // ── Protected routes ──
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error('Gateway failed to start:', err);
  process.exit(1);
});
