import { assertEncryptionKeyConfigured } from '@auto-swe/shared/lib/crypto';
import { syncBuiltins } from '@auto-swe/shared/lib/syncBuiltins';
import { assertScheduledSweepsEnv } from '@auto-swe/shared/lib/systemConfig';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify, { type FastifyError } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { otel } from './instrument.js';
import { registerAuditContext } from './lib/auditContext.js';
import { configuredProviders, getAuth, initAuth } from './lib/betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './lib/betterAuthHandler.js';
import { getCorsOrigins, getPort } from './lib/env.js';
import { registerFormBodyParser } from './lib/formBody.js';
import { mcpBridgePlugin } from './lib/mcp/bridge.js';
import { mcpConsentAudit } from './lib/mcpConsentAudit.js';
import { mcpOAuthGate } from './lib/mcpOAuthGate.js';
import { mcpConsentAuditOptions, mcpOAuthGateOptions } from './lib/mcpOAuthGateOptions.js';
import { mcpRouteOptions } from './lib/mcpRouteOptions.js';
import { initMetrics } from './lib/metrics.js';
import { parseRateLimitConfig } from './lib/rateLimitConfig.js';
import {
  warnIfGitHubDotComWebhookSecret,
  warnIfReposOnUnusableHosts,
} from './lib/repoIdentityIndexCheck.js';
import { redactedRequestSerializer, redactingLogMethod } from './lib/requestUrlRedaction.js';
import { syncSchedulesOnceConnected } from './lib/startupScheduleSync.js';
import {
  healthBody,
  isTemporalUnavailable,
  replyIfTemporalUnavailable,
} from './lib/temporalErrors.js';
import { parseTrustProxy } from './lib/trustProxy.js';
import authPlugin, {
  ACCESS_TOKEN_TTL_SECONDS,
  rateLimitKey,
  requireAuth,
  requireUser,
} from './plugins/auth.js';
import prismaPlugin from './plugins/prisma.js';
import temporalPlugin from './plugins/temporal.js';
import { mcpRoutes } from './routes/mcp.js';
import { registerApiRoutes } from './routes/register.js';

async function start() {
  // Fail at boot, not on the first credential save: every DB-stored secret
  // (provider keys, GitHub/Slack/S3/OAuth config) goes through this key, and
  // a gateway that starts without it serves 500s on exactly the admin pages
  // needed to bootstrap a deployment.
  assertEncryptionKeyConfigured();
  // The sweep schedules below are environment-only and applied once, here. A
  // value the resolver would silently replace with a default is a failed boot.
  assertScheduledSweepsEnv();
  // After the instrument.ts preload, so the instruments bind to the real provider.
  initMetrics();

  // Must run before betterAuth.handler is called — reads OAuth creds from DB.
  await initAuth();

  const app = Fastify({
    // A template webhook's URL is its credential: log every request URL with the token redacted.
    logger: {
      hooks: { logMethod: redactingLogMethod },
      serializers: { req: redactedRequestSerializer },
    },
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  });

  // Zod validation + serialization
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Guard against fast-json-stringify silently stripping undeclared response
  // fields: any route that does not declare a response schema gets a permissive
  // `z.any()` for 200 responses. Routes that already declare schemas are untouched.
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.schema?.response) {
      routeOptions.schema = { ...routeOptions.schema, response: { 200: z.any() } };
    }
  });

  // CORS — allow the web dashboard and any additional origins from env.
  // Explicitly list all methods used by the API so PUT/DELETE preflights pass.
  await app.register(cors, {
    credentials: true,
    // Without this the browser hides the audit export's truncation flag from the dashboard.
    exposedHeaders: ['X-Export-Truncated', 'X-Export-Row-Limit'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'],
    origin: getCorsOrigins(),
  });

  // Raw body for HMAC webhook verification (opt-in per route)
  await app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  registerFormBodyParser(app);

  await app.register(cookie);

  // Rate limiting — keyed per authenticated user where the identity is already
  // verified, else per client IP (see `rateLimitKey`). The credential routes
  // below add a stricter per-route limit.
  const limit = parseRateLimitConfig(process.env);
  await app.register(rateLimit, {
    keyGenerator: rateLimitKey,
    max: limit.max,
    timeWindow: limit.timeWindowMs,
  });

  // Plugins (decorate app with .temporal, .prisma, .auth)
  await app.register(prismaPlugin);
  await app.register(temporalPlugin);
  await app.register(authPlugin);
  registerAuditContext(app);

  // Sync built-in reference data (templates, skills, scanner patterns, tool
  // config) so every deploy automatically picks up new or updated built-ins.
  await syncBuiltins(app.prisma);

  await warnIfGitHubDotComWebhookSecret(app.prisma, app.log);
  await warnIfReposOnUnusableHosts(app.prisma, app.log);

  // The gateway boots without Temporal: the plugin connects in the background, and the
  // startup schedule syncs run as soon as it is up, so they are deferred, not lost.
  void syncSchedulesOnceConnected(app).catch((err) =>
    app.log.warn({ err }, 'startup schedule sync failed')
  );

  // Global error handler. 4xx messages are intentional (validation, auth);
  // 5xx messages can leak internals (DB constraint text, library errors), so
  // log the detail server-side and return a generic message.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // Temporal not being connected yet is expected and retryable; pollers would flood
    // the error level during the connect window.
    if (isTemporalUnavailable(error)) {
      request.log.warn({ err: error }, 'Temporal not connected');
    } else {
      request.log.error(error);
    }
    const statusCode = error.statusCode ?? 500;
    // Temporal not being connected yet is an expected, retryable condition with
    // its own stable code and a message safe to show — not an internal error.
    const unavailable = replyIfTemporalUnavailable(error, reply);
    if (unavailable) {
      return unavailable;
    }
    return reply.status(statusCode).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    });
  });

  // Health check — liveness. Always 200 while the process serves requests (the
  // container healthcheck keys on that); Temporal's state is reported, not gated
  // on, because the gateway runs without it and recovers when it connects.
  app.get('/health', async () => healthBody(app.temporalConnection));

  // ── Better Auth handler — multi-provider browser sign-in flow.
  // Mounted at /api/auth/* per the better-auth convention. Cookie-based
  // sessions live independently of the existing JWT/PAT bearer scheme;
  // the /api/v1/auth/session-token bridge below exchanges a valid
  // better-auth session for a short-lived JWT the rest of the API
  // already understands. ──
  // The OAuth gate's hooks apply to routes registered after it, so it goes first.
  await app.register(mcpOAuthGate, mcpOAuthGateOptions());
  await app.register(mcpConsentAudit, mcpConsentAuditOptions());
  registerBetterAuthRoutes(app, createBetterAuthHandler());

  // The MCP endpoint and its protected-resource metadata. Registered unconditionally: `mcp.enabled`
  // is read per request and a disabled deployment answers 404, so the switch needs no restart.
  // The bridge goes on the root first: `requireAuth` on every route consults it, and the MCP routes'
  // tools call REST through it.
  const mcpOptions = mcpRouteOptions();
  await app.register(mcpBridgePlugin, { verifier: mcpOptions.verifier });
  await app.register(mcpRoutes, mcpOptions);

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
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
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

  // Who am I? Used by the web server for server-side admin route guards.
  app.get('/api/v1/auth/me', { onRequest: requireAuth() }, async (request, reply) => {
    const actor = requireUser(request);
    const user = await app.prisma.user.findUnique({
      select: { email: true, id: true, isActive: true, role: true },
      where: { id: actor.sub },
    });
    if (!user?.isActive) {
      return reply
        .status(403)
        .send({ error: { code: 'FORBIDDEN', message: 'User not found or inactive' } });
    }
    return { data: user };
  });

  await registerApiRoutes(app);

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

  const port = getPort();
  await app.listen({ host: '0.0.0.0', port });
}

start().catch(async (err) => {
  console.error('Gateway failed to start:', err);
  await otel.shutdown();
  process.exit(1);
});
