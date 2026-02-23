import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import fastifyRawBody from 'fastify-raw-body';
import { temporalPlugin } from './plugins/temporal.js';
import { prismaPlugin } from './plugins/prisma.js';
import { workRequestRoutes } from './routes/workRequests.js';
import { workflowRoutes } from './routes/workflows.js';
import { webhookRoutes } from './routes/webhooks.js';

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
