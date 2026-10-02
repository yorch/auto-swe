import { getCorsOrigins, getPort } from './lib/env.js';
import { initTelemetry } from './lib/telemetry.js';

// Initialize OTel BEFORE Fastify creation so auto-instrumentation can patch
const otel = initTelemetry('auto-swe-gateway');

import { assertEncryptionKeyConfigured } from '@auto-swe/shared/lib/crypto';
import { syncBuiltins } from '@auto-swe/shared/lib/syncBuiltins';
import {
  assertScheduledSweepsEnv,
  resolveConsolidationConfig,
  resolveEvalScheduleConfig,
  resolveRevalidationConfig,
  resolveScheduledSweeps,
} from '@auto-swe/shared/lib/systemConfig';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify, { type FastifyError } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { configuredProviders, getAuth, initAuth } from './lib/betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './lib/betterAuthHandler.js';
import { registerFormBodyParser } from './lib/formBody.js';
import { mcpBridgePlugin } from './lib/mcp/bridge.js';
import { mcpConsentAudit } from './lib/mcpConsentAudit.js';
import { mcpOAuthGate } from './lib/mcpOAuthGate.js';
import { mcpConsentAuditOptions, mcpOAuthGateOptions } from './lib/mcpOAuthGateOptions.js';
import { mcpRouteOptions } from './lib/mcpRouteOptions.js';
import {
  warnIfGitHubDotComWebhookSecret,
  warnIfReposOnUnusableHosts,
} from './lib/repoIdentityIndexCheck.js';
import { parseTrustProxy } from './lib/trustProxy.js';
import authPlugin, {
  ACCESS_TOKEN_TTL_SECONDS,
  rateLimitKey,
  requireAuth,
  requireUser,
} from './plugins/auth.js';
import prismaPlugin from './plugins/prisma.js';
import temporalPlugin from './plugins/temporal.js';
import { adminRoutes } from './routes/admin.js';
import { agentLibraryRoutes, teamAgentLibraryRoutes } from './routes/agentLibrary.js';
import { agentRunRoutes } from './routes/agentRuns.js';
import { autonomyPolicyRoutes } from './routes/autonomyPolicies.js';
import { bundleRoutes } from './routes/bundles.js';
import { configSettingsRoutes } from './routes/configSettings.js';
import { connectionCredentialRoutes } from './routes/connectionCredentials.js';
import { epicRoutes } from './routes/epics.js';
import { evalRoutes } from './routes/evals.js';
import { githubInstallationRoutes } from './routes/githubInstallations.js';
import { githubWebhookSecretRoutes } from './routes/githubWebhookSecrets.js';
import { humanErrorBaselineRoutes } from './routes/humanErrorBaselines.js';
import { humanStepRoutes } from './routes/humanSteps.js';
import { lessonRoutes } from './routes/lessons.js';
import { mcpRoutes } from './routes/mcp.js';
import { mcpConnectionRoutes } from './routes/mcpConnections.js';
import { meRoutes } from './routes/me.js';
import { modelCatalogRoutes } from './routes/modelCatalog.js';
import { modelConfigRoutes } from './routes/modelConfig.js';
import { organizationRoutes } from './routes/organizations.js';
import { orgBudgetRoutes } from './routes/orgBudget.js';
import { orgMembersRoutes } from './routes/orgMembers.js';
import { prdRunRoutes } from './routes/prdRuns.js';
import { repoDependencyRoutes } from './routes/repoDependencies.js';
import { repositoryRoutes } from './routes/repositories.js';
import { scannerPatternRoutes } from './routes/scannerPatterns.js';
import { scheduledWorkRequestRoutes } from './routes/scheduledWorkRequests.js';
import { securityEventRoutes } from './routes/securityEvents.js';
import { skillsRoutes, teamAgentSkillRoutes } from './routes/skills.js';
import { slackRoutes } from './routes/slack.js';
import { slackChannelRoutes } from './routes/slackChannels.js';
import { systemConfigRoutes } from './routes/systemConfig.js';
import { teamRoutes } from './routes/teams.js';
import { tokenRoutes } from './routes/tokens.js';
import { usageRoutes } from './routes/usage.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';
import { stepRegistryRoutes, workflowRunRoutes } from './routes/workflowRuns.js';
import { workflowRoutes } from './routes/workflows.js';
import { workflowTemplateRoutes } from './routes/workflowTemplates.js';
import { workRequestRoutes } from './routes/workRequests.js';

async function start() {
  // Fail at boot, not on the first credential save: every DB-stored secret
  // (provider keys, GitHub/Slack/S3/OAuth config) goes through this key, and
  // a gateway that starts without it serves 500s on exactly the admin pages
  // needed to bootstrap a deployment.
  assertEncryptionKeyConfigured();
  // The sweep schedules below are environment-only and applied once, here. A
  // value the resolver would silently replace with a default is a failed boot.
  assertScheduledSweepsEnv();

  // Must run before betterAuth.handler is called — reads OAuth creds from DB.
  await initAuth();

  const app = Fastify({ logger: true, trustProxy: parseTrustProxy(process.env.TRUST_PROXY) });

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
  await app.register(rateLimit, {
    keyGenerator: rateLimitKey,
    max: 200,
    timeWindow: '1 minute',
  });

  // Plugins (decorate app with .temporal, .prisma, .auth)
  await app.register(prismaPlugin);
  await app.register(temporalPlugin);
  await app.register(authPlugin);

  // Sync built-in reference data (templates, skills, scanner patterns, tool
  // config) so every deploy automatically picks up new or updated built-ins.
  await syncBuiltins(app.prisma);

  await warnIfGitHubDotComWebhookSecret(app.prisma, app.log);
  await warnIfReposOnUnusableHosts(app.prisma, app.log);

  // Sync the lesson consolidation Temporal Schedule with whatever config is in
  // the DB. Best-effort — a Temporal connectivity failure at startup shouldn't
  // crash the gateway; the admin can re-save from the UI once Temporal is up.
  resolveConsolidationConfig()
    .then((cfg) => app.temporal.syncConsolidationSchedule(cfg))
    .catch((err) => app.log.warn({ err }, 'consolidation schedule sync failed at startup'));

  // Same for the repo-dependency scan Schedule. Without this the schedule never
  // exists, so the on-demand "re-scan" trigger has no handle to fire.
  const sweeps = resolveScheduledSweeps();
  app.temporal
    .syncRepoDependencyScanSchedule(sweeps.repoDependency)
    .catch((err) => app.log.warn({ err }, 'repo dependency scan schedule sync failed at startup'));

  // Same for the permission sweep that refreshes cached GitHub answers. Paused
  // unless an admin has enabled it: it spends GitHub quota proportional to team
  // members times repositories, so it must be a deliberate choice.
  app.temporal
    .syncRepoAccessSyncSchedule(sweeps.repoAccess)
    .catch((err) => app.log.warn({ err }, 'repo access sync schedule sync failed at startup'));

  // Same for the eval-regression Temporal Schedule (the nightly benchmark).
  // Off by default — needs a seeded dataset + a worker that can reach Docker.
  resolveEvalScheduleConfig()
    .then((cfg) => app.temporal.syncEvalSchedule(cfg))
    .catch((err) => app.log.warn({ err }, 'eval schedule sync failed at startup'));

  // Same for the eval re-validation Temporal Schedule (golden-set staleness check).
  // Off by default — needs seeded EvalDatasets + a Docker-capable worker.
  resolveRevalidationConfig()
    .then((cfg) => app.temporal.syncRevalidationSchedule(cfg))
    .catch((err) => app.log.warn({ err }, 'revalidation schedule sync failed at startup'));

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

  // ── Public routes (no auth) ──

  // ── Personal access tokens (auth required, but self-service for engineers+) ──
  await app.register(tokenRoutes, { prefix: '/api/v1/auth/tokens' });

  // ── Protected routes ──
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
  await app.register(scheduledWorkRequestRoutes, { prefix: '/api/v1/scheduled-work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  await app.register(humanErrorBaselineRoutes, { prefix: '/api/v1/human-error-baselines' });
  await app.register(organizationRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(organizationRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(stepRegistryRoutes, { prefix: '/api/v1/workflow-steps' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(repoDependencyRoutes, { prefix: '/api/v1/repositories' });
  await app.register(connectionCredentialRoutes, { prefix: '/api/v1/repositories' });
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });
  await app.register(slackChannelRoutes, { prefix: '/api/v1/platform/slack-channels' });
  // Deprecated alias — kept for one release.
  await app.register(slackChannelRoutes, { prefix: '/api/v1/admin/slack-channels' });
  await app.register(epicRoutes, { prefix: '/api/v1/epics' });
  await app.register(prdRunRoutes, { prefix: '/api/v1/prd-runs' });
  await app.register(adminRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(modelConfigRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(modelConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(modelCatalogRoutes, { prefix: '/api/v1/platform' });
  await app.register(systemConfigRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(systemConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/admin' });
  await app.register(configSettingsRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(configSettingsRoutes, { prefix: '/api/v1/admin' });
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/admin' });
  await app.register(githubInstallationRoutes, { prefix: '/api/v1/platform' });
  await app.register(githubInstallationRoutes, { prefix: '/api/v1/admin' });
  await app.register(githubWebhookSecretRoutes, { prefix: '/api/v1/platform' });
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/admin' });
  await app.register(bundleRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(bundleRoutes, { prefix: '/api/v1/admin' });
  await app.register(securityEventRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(securityEventRoutes, { prefix: '/api/v1/admin' });
  await app.register(usageRoutes, { prefix: '/api/v1/platform' });
  await app.register(orgMembersRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(orgMembersRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(orgBudgetRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(orgBudgetRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(skillsRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(skillsRoutes, { prefix: '/api/v1/admin' });
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/admin' });
  await app.register(evalRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(evalRoutes, { prefix: '/api/v1/admin' });
  await app.register(teamAgentSkillRoutes, { prefix: '/api/v1/teams' });
  await app.register(teamAgentLibraryRoutes, { prefix: '/api/v1/teams' });
  await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
  // Deprecated alias — kept for one release so existing CLI tokens and bookmarks keep working.
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

  const port = getPort();
  await app.listen({ host: '0.0.0.0', port });
}

start().catch(async (err) => {
  console.error('Gateway failed to start:', err);
  await otel.shutdown();
  process.exit(1);
});
