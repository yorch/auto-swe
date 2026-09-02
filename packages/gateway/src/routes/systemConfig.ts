import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import {
  resolveCanaryConfig,
  resolveConsolidationConfig,
  resolveEvalScheduleConfig,
  resolveRevalidationConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  auditConfigWrite,
  detectJiraFields,
  getFigmaConfig,
  getGitHubConfig,
  getGoogleOAuthConfig,
  getIssueTrackerConfig,
  getKnowledgeBaseConfig,
  getOktaOAuthConfig,
  getSlackConfig,
  getStorageConfig,
  listConfigAuditEntries,
  testDecryptSecrets,
  testFigmaConnection,
  testGitHubConnection,
  testIssueTrackerConnection,
  testKnowledgeBaseConnection,
  testSlackConnection,
  testStorageConnection,
  updateCanaryConfig,
  updateConsolidationConfig,
  updateEvalScheduleConfig,
  updateFigmaConfig,
  updateGitHubConfig,
  updateGoogleOAuthConfig,
  updateIssueTrackerConfig,
  updateKnowledgeBaseConfig,
  updateOktaOAuthConfig,
  updateRevalidationScheduleConfig,
  updateSlackConfig,
  updateStorageConfig,
  updateWorkflowDefaults,
} from '../lib/systemConfigService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/// Admin CRUD routes for the singleton system-config tables:
///   GET/PUT /api/v1/platform/config/github
///   GET/PUT /api/v1/platform/config/slack
///   GET/PUT /api/v1/platform/config/storage
///   GET/PUT /api/v1/platform/config/workflow-defaults
///   GET/PUT /api/v1/platform/config/oauth/google
///   GET/PUT /api/v1/platform/config/oauth/okta
///   GET/PUT /api/v1/platform/config/issue-tracker
///   GET/PUT /api/v1/platform/config/knowledge-base
///
/// Also:
///   POST /api/v1/platform/config/github/test          — live connection test
///   POST /api/v1/platform/config/slack/test           — live connection test
///   POST /api/v1/platform/config/storage/test         — connectivity test
///   POST /api/v1/platform/config/issue-tracker/test   — fetch a sample ticket
///   POST /api/v1/platform/config/knowledge-base/test  — knowledge base connectivity test
///   GET  /api/v1/platform/config/audit-log            — config change history
///
/// All routes require platform ADMIN role.
/// Secret fields are write-only from the API: reads return `lastFour` only,
/// never the plaintext (same convention as /admin/config/credentials).
/// The encrypt/redact/audit mechanics live in `lib/systemConfigService.ts`.

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const GitHubPutBody = z.object({
  apiUrl: z.string().url().max(500).nullable().optional(),
  appClientId: z.string().max(200).nullable().optional(),
  appClientSecret: z.string().min(1).max(500).optional(),
  appId: z.string().max(100).nullable().optional(),
  appInstallationId: z.string().max(100).nullable().optional(),
  appPrivateKey: z.string().min(1).max(10_000).optional(),
  authMode: z.enum(['auto', 'pat', 'app']).nullable().optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  oauthClientId: z.string().max(200).nullable().optional(),
  oauthClientSecret: z.string().min(1).max(500).optional(),
  token: z.string().min(1).max(500).optional(),
  webhookSecret: z.string().min(1).max(500).optional(),
});

const SlackPutBody = z.object({
  botToken: z.string().min(1).max(500).optional(),
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  signingSecret: z.string().min(1).max(500).optional(),
});

const StoragePutBody = z
  .object({
    awsAccessKeyId: z.string().max(200).nullable().optional(),
    awsSecretAccessKey: z.string().min(1).max(500).optional(),
    backend: z.enum(['inline', 's3']).optional(),
    s3Bucket: z.string().min(1).max(200).nullable().optional(),
    s3Endpoint: z.string().url().max(500).nullable().optional(),
    s3ForcePathStyle: z.boolean().optional(),
    s3Prefix: z.string().max(200).nullable().optional(),
    s3Region: z.string().max(50).nullable().optional(),
  })
  .refine((v) => v.backend !== 's3' || (v.s3Bucket !== undefined && v.s3Bucket !== null), {
    message: 'backend=s3 requires s3Bucket',
  });

const WorkflowDefaultsPutBody = z.object({
  branchPrefix: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9/-]*$/, 'must be lowercase alphanumeric with - or /')
    .optional(),
  budgetEpicInputTokens: z.number().int().min(1).optional(),
  budgetEpicOutputTokens: z.number().int().min(1).optional(),
  budgetLargeInputTokens: z.number().int().min(1).optional(),
  budgetLargeOutputTokens: z.number().int().min(1).optional(),
  budgetStandardInputTokens: z.number().int().min(1).optional(),
  budgetStandardOutputTokens: z.number().int().min(1).optional(),
  // CI-wait strategy. Nullable: clearing a value hands the knob back to the
  // env-var fallback rather than pinning a default into the row.
  ciPollDeadlineSec: z.number().int().min(1).nullable().optional(),
  ciPollGraceSec: z.number().int().min(1).nullable().optional(),
  ciPollIntervalSec: z.number().int().min(1).nullable().optional(),
  ciWaitMode: z.enum(['signal', 'poll']).nullable().optional(),
  defaultTeamSlug: z.string().min(1).max(100).optional(),
  evalHealthMaxFlakeRate: z.number().min(0).max(1).optional(),
  evalHealthMaxStaleRate: z.number().min(0).max(1).optional(),
  evalHealthMinKappa: z.number().min(0).max(1).optional(),
  evalJudgeThreshold: z.number().min(0).max(1).optional(),
  lessonRetrievalLimit: z.number().int().min(1).optional(),
  lessonRetrievalThreshold: z.number().min(0).max(1).optional(),
  maxEvalIterations: z.number().int().min(1).optional(),
  maxTddIterations: z.number().int().min(1).optional(),
  prBodyTemplate: z.string().max(10_000).optional(),
  prTitleTemplate: z.string().min(1).max(500).optional(),
  workspaceCpus: z.number().positive().optional(),
  // Format-validate the two operational strings at write time so a bad value
  // fails fast here (a 400) instead of breaking every future workspace creation
  // deep in the worker. `workspaceImage` must satisfy the same ref regex
  // `createWorkspace` enforces; `workspaceMemory` must be a docker memory value
  // (digits + optional b/k/m/g unit) — this also removes any shell metacharacter.
  workspaceImage: z.string().min(1).max(200).regex(DOCKER_IMAGE_REF_RE).optional(),
  workspaceMemory: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+[bkmg]?$/i, 'must be a docker memory value, e.g. 512m or 4g')
    .optional(),
  workspacePidsLimit: z.number().int().min(1).optional(),
});

const ConsolidationPutBody = z.object({
  cronExpression: z
    .string()
    .min(1)
    .max(100)
    .regex(/^(\S+\s+){4}\S+$/, 'must be a valid 5-field cron expression (e.g. "0 3 * * 0")')
    .optional(),
  enabled: z.boolean().optional(),
  minClusterSize: z.number().int().min(2).max(20).optional(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
});

const EvalSchedulePutBody = z.object({
  baselineRef: z.string().min(1).max(200).optional(),
  candidateRef: z.string().min(1).max(200).optional(),
  cronExpression: z
    .string()
    .min(1)
    .max(100)
    .regex(/^(\S+\s+){4}\S+$/, 'must be a valid 5-field cron expression (e.g. "0 7 * * *")')
    .optional(),
  datasetSlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  enabled: z.boolean().optional(),
});

const RevalidationPutBody = z.object({
  cronExpression: z
    .string()
    .min(1)
    .max(100)
    .regex(/^(\S+\s+){4}\S+$/, 'must be a valid 5-field cron expression (e.g. "0 5 * * 0")')
    .optional(),
  datasetSlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/)
    .nullable()
    .optional(),
  enabled: z.boolean().optional(),
});

const CanaryPutBody = z.object({
  agentKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-zA-Z0-9]*$/)
    .nullable()
    .optional(),
  candidateVersion: z.number().int().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  percent: z.number().min(0).max(1).optional(),
});

const GoogleOAuthPutBody = z.object({
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
});

const OktaOAuthPutBody = z.object({
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  issuer: z.string().url().max(500).nullable().optional(),
});

const IssueTrackerPutBody = z.object({
  allowPrivateNetwork: z.boolean().optional(),
  apiToken: z.string().min(1).max(500).optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  defaultProjectKey: z.string().max(100).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  epicIssueType: z.string().max(100).nullable().optional(),
  instanceType: z.enum(['cloud', 'server', 'datacenter']).nullable().optional(),
  maxRetries: z.number().int().min(0).max(10).nullable().optional(),
  provider: z.enum(['jira', 'linear', 'github']).nullable().optional(),
  storyIssueType: z.string().max(100).nullable().optional(),
  storyPointsFieldId: z.string().max(100).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).nullable().optional(),
  webhookSecret: z.string().max(500).nullable().optional(),
  webhookTriggerStatus: z.string().max(200).nullable().optional(),
});

const IssueTrackerTestBody = z.object({
  ticketId: z.string().min(1).max(200),
});

const KnowledgeBasePutBody = z.object({
  allowPrivateNetwork: z.boolean().optional(),
  apiToken: z.string().min(1).max(500).optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  enabled: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(50).nullable().optional(),
  provider: z.enum(['confluence', 'notion']).nullable().optional(),
  spaces: z.array(z.string().min(1).max(200)).max(20).optional(),
});

const FigmaPutBody = z.object({
  apiToken: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
  maxNodes: z.number().int().min(1).max(50).nullable().optional(),
});

// ─── route plugin ─────────────────────────────────────────────────────────────

const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const systemConfigRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance
): Promise<void> => {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes below require ADMIN
  f.addHook('onRequest', requireAuth({ requiredRole: 'ADMIN' }));

  // ── GitHub ──────────────────────────────────────────────────────────────────

  f.get('/config/github', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getGitHubConfig(fastify.prisma))
  );

  f.put(
    '/config/github',
    { schema: { body: GitHubPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateGitHubConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post('/config/github/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await testGitHubConnection())
  );

  // ── Slack ───────────────────────────────────────────────────────────────────

  f.get('/config/slack', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getSlackConfig(fastify.prisma))
  );

  f.put(
    '/config/slack',
    { schema: { body: SlackPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateSlackConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post('/config/slack/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await testSlackConnection())
  );

  // ── Storage ─────────────────────────────────────────────────────────────────

  f.get('/config/storage', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getStorageConfig(fastify.prisma))
  );

  f.put(
    '/config/storage',
    { schema: { body: StoragePutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateStorageConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post('/config/storage/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await testStorageConnection())
  );

  // ── Workflow defaults ────────────────────────────────────────────────────────

  f.get(
    '/config/workflow-defaults',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => reply.send({ data: await resolveWorkflowDefaults() })
  );

  f.put(
    '/config/workflow-defaults',
    { schema: { body: WorkflowDefaultsPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateWorkflowDefaults(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      // result.data is the shared resolver's shape so GET and PUT match,
      // including env-var fallbacks for fields not yet set in DB.
      return reply.send({ data: result.data });
    }
  );

  // ── Google OAuth ─────────────────────────────────────────────────────────────

  f.get('/config/oauth/google', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getGoogleOAuthConfig(fastify.prisma))
  );

  f.put(
    '/config/oauth/google',
    { schema: { body: GoogleOAuthPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateGoogleOAuthConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  // ── Okta (enterprise SSO) ────────────────────────────────────────────────────

  f.get('/config/oauth/okta', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getOktaOAuthConfig(fastify.prisma))
  );

  f.put(
    '/config/oauth/okta',
    // 400 is declared alongside 200 because this is the one config route that
    // rejects its body after Zod parsing — the SSRF guard below.
    { schema: { body: OktaOAuthPutBody, response: { 200: z.any(), 400: z.any() } } },
    async (req, reply) => {
      // The issuer is fetched server-side at gateway boot (the OIDC discovery
      // document), so an admin-supplied value is an SSRF vector exactly like an
      // `apiBase` probe — run it through the same guard. Okta issuers are always
      // public HTTPS, so unlike the tracker/KB connectors there is no
      // private-network opt-in to honour here.
      const { issuer } = req.body;
      if (issuer) {
        const safety = isSafeProbeUrl(issuer);
        if (!safety.ok) {
          return reply
            .status(400)
            .send({ error: { code: 'UNSAFE_URL', message: `issuer rejected: ${safety.reason}` } });
        }
        if (safety.url.protocol !== 'https:') {
          return reply.status(400).send({
            error: { code: 'UNSAFE_URL', message: 'issuer rejected: must use https' },
          });
        }
      }
      const result = await updateOktaOAuthConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  // ── Issue tracker ────────────────────────────────────────────────────────────

  f.get('/config/issue-tracker', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getIssueTrackerConfig(fastify.prisma))
  );

  f.put(
    '/config/issue-tracker',
    { schema: { body: IssueTrackerPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateIssueTrackerConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post(
    '/config/issue-tracker/test',
    { schema: { body: IssueTrackerTestBody, response: { 200: z.any() } } },
    async (req, reply) => reply.send(await testIssueTrackerConnection(req.body.ticketId))
  );

  f.post(
    '/config/issue-tracker/detect-fields',
    {
      schema: {
        response: {
          200: z.object({
            fields: z.array(z.object({ id: z.string(), name: z.string() })),
            storyPointsFieldId: z.string().nullable(),
          }),
        },
      },
    },
    async (_req, reply) => {
      const result = await detectJiraFields();
      return reply.send(result);
    }
  );

  // ── Knowledge base ───────────────────────────────────────────────────────────

  f.get('/config/knowledge-base', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getKnowledgeBaseConfig(fastify.prisma))
  );

  f.put(
    '/config/knowledge-base',
    { schema: { body: KnowledgeBasePutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateKnowledgeBaseConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post(
    '/config/knowledge-base/test',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => reply.send(await testKnowledgeBaseConnection())
  );

  // ── Figma (design source) ────────────────────────────────────────────────────

  f.get('/config/figma', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getFigmaConfig(fastify.prisma))
  );

  f.put(
    '/config/figma',
    { schema: { body: FigmaPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateFigmaConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      return reply.send({ data: result.data });
    }
  );

  f.post('/config/figma/test', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await testFigmaConnection())
  );

  // ── Config audit log ─────────────────────────────────────────────────────────

  f.get(
    '/config/audit-log',
    { schema: { querystring: AuditLogQuery, response: { 200: z.any() } } },
    async (req, reply) =>
      reply.send({ data: await listConfigAuditEntries(fastify.prisma, req.query.limit) })
  );

  // ── Consolidation schedule ───────────────────────────────────────────────────

  f.get(
    '/config/consolidation',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      const config = await resolveConsolidationConfig();
      const status = await fastify.temporal.getConsolidationScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.put(
    '/config/consolidation',
    { schema: { body: ConsolidationPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateConsolidationConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);

      const config = await resolveConsolidationConfig();
      await fastify.temporal.syncConsolidationSchedule(config);
      const status = await fastify.temporal.getConsolidationScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.post(
    '/config/consolidation/trigger',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      await fastify.temporal.triggerConsolidationNow();
      return reply.send({ data: { triggered: true } });
    }
  );

  // ── Eval regression schedule ─────────────────────────────────────────────────

  f.get(
    '/config/eval-schedule',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      const config = await resolveEvalScheduleConfig();
      const status = await fastify.temporal.getEvalScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.put(
    '/config/eval-schedule',
    { schema: { body: EvalSchedulePutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateEvalScheduleConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);

      const config = await resolveEvalScheduleConfig();
      await fastify.temporal.syncEvalSchedule(config);
      const status = await fastify.temporal.getEvalScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.post(
    '/config/eval-schedule/trigger',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      await fastify.temporal.triggerEvalNow();
      return reply.send({ data: { triggered: true } });
    }
  );

  // ── Re-validation schedule ───────────────────────────────────────────────────

  f.get('/config/revalidation', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const config = await resolveRevalidationConfig();
    const status = await fastify.temporal.getRevalidationScheduleStatus();
    return reply.send({ data: { ...config, schedule: status } });
  });

  f.put(
    '/config/revalidation',
    { schema: { body: RevalidationPutBody, response: { 200: z.any() } } },
    async (req, reply) => {
      const result = await updateRevalidationScheduleConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);

      const config = await resolveRevalidationConfig();
      await fastify.temporal.syncRevalidationSchedule(config);
      const status = await fastify.temporal.getRevalidationScheduleStatus();
      return reply.send({ data: { ...config, schedule: status } });
    }
  );

  f.post(
    '/config/revalidation/trigger',
    { schema: { response: { 200: z.any() } } },
    async (_req, reply) => {
      await fastify.temporal.triggerRevalidationNow();
      return reply.send({ data: { triggered: true } });
    }
  );

  // ── Canary routing ────────────────────────────────────────────────────────────

  f.get('/config/canary', { schema: { response: { 200: z.any() } } }, async (_req, reply) => {
    const config = await resolveCanaryConfig();
    return reply.send({ data: config });
  });

  f.put(
    '/config/canary',
    { schema: { body: CanaryPutBody, response: { 200: z.any(), 400: z.any() } } },
    async (req, reply) => {
      // Guard against pinning a nonexistent/inactive agent version: createWorkflowRun
      // writes agentVersions[agentKey]=candidateVersion verbatim, so a bad version
      // makes resolveAgent throw ConfigMissingError on every routed run. Validate the
      // *effective* config (current row merged with this partial update) before writing.
      const current = await resolveCanaryConfig();
      const agentKey = req.body.agentKey !== undefined ? req.body.agentKey : current.agentKey;
      const candidateVersion =
        req.body.candidateVersion !== undefined
          ? req.body.candidateVersion
          : current.candidateVersion;
      if (agentKey && candidateVersion != null) {
        const agent = await fastify.prisma.agent.findFirst({
          select: { id: true },
          where: { isActive: true, key: agentKey, version: candidateVersion },
        });
        if (!agent) {
          return reply.status(400).send({
            error: {
              code: 'CANARY_VERSION_NOT_FOUND',
              message: `No active agent '${agentKey}' at version ${candidateVersion}`,
            },
          });
        }
      }
      const result = await updateCanaryConfig(fastify.prisma, req.body);
      await auditConfigWrite(fastify.prisma, fastify.log, requireUser(req).sub, result);
      const config = await resolveCanaryConfig();
      return reply.send({ data: config });
    }
  );

  // ── Test endpoint (checks decryption works for all secrets) ──────────────────

  f.get('/config/test-decrypt', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send({ data: await testDecryptSecrets(fastify.prisma) })
  );
};
