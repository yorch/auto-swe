import {
  resolveCanaryConfig,
  resolveConsolidationConfig,
  resolveEvalScheduleConfig,
  resolveRevalidationConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  auditConfigWrite,
  CLEARABLE_SECRETS,
  type ClearableIntegration,
  clearStoredSecret,
  detectJiraFields,
  getFigmaConfig,
  getGitHubConfig,
  getIntegrationConfig,
  getIssueTrackerConfig,
  getKnowledgeBaseConfig,
  getSlackConfig,
  issueTrackerBaseUrlRefusal,
  knowledgeBaseBaseUrlRefusal,
  listConfigAuditEntries,
  testDecryptSecrets,
  testFigmaConnection,
  testGitHubConnection,
  testIssueTrackerConnection,
  testKnowledgeBaseConnection,
  testSlackConnection,
  updateCanaryConfig,
  updateConsolidationConfig,
  updateEvalScheduleConfig,
  updateFigmaConfig,
  updateGitHubConfig,
  updateIssueTrackerConfig,
  updateKnowledgeBaseConfig,
  updateRevalidationScheduleConfig,
  updateSlackConfig,
  updateWorkflowDefaults,
} from '../lib/systemConfigService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/// Admin CRUD routes for the singleton system-config tables:
///   GET/PUT /api/v1/platform/config/github
///   GET/PUT /api/v1/platform/config/slack
///   GET/PUT /api/v1/platform/config/workflow-defaults
///   GET/PUT /api/v1/platform/config/issue-tracker
///   GET/PUT /api/v1/platform/config/knowledge-base
///
/// Also:
///   POST /api/v1/platform/config/github/test          — live connection test (optional unsaved draft body)
///   POST /api/v1/platform/config/slack/test           — live connection test (optional unsaved draft body)
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
  token: z.string().min(1).max(500).optional(),
  webhookSecret: z.string().min(1).max(500).optional(),
});

/// The unsaved form values a connection test may use. Secrets omitted or blank
/// mean "test the stored one"; nothing here is persisted.
const GitHubTestBody = z.object({
  apiUrl: z.string().url().max(500).nullable().optional(),
  appId: z.string().max(100).nullable().optional(),
  appInstallationId: z.string().max(100).nullable().optional(),
  appPrivateKey: z.string().min(1).max(10_000).optional(),
  authMode: z.enum(['auto', 'pat', 'app']).nullable().optional(),
  token: z.string().min(1).max(500).optional(),
});

const SlackTestBody = z.object({
  botToken: z.string().min(1).max(500).optional(),
});

const SlackPutBody = z.object({
  botToken: z.string().min(1).max(500).optional(),
  clientId: z.string().max(200).nullable().optional(),
  clientSecret: z.string().min(1).max(500).optional(),
  signingSecret: z.string().min(1).max(500).optional(),
});

/** Longest CI poll interval that fits the poll activity's 2-minute heartbeat. */
const CI_POLL_INTERVAL_MAX_SEC = 60;
/** Longest CI poll deadline below the poll activity's 6-hour timeout, less a tick. */
const CI_POLL_DEADLINE_MAX_SEC = 6 * 3600 - 15 * 60;

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
  // Upper bounds mirror the worker's clamp (`ciPollLoop.ts`): the interval must
  // stay inside the poll activity's 2-minute heartbeat timeout, and the
  // deadline below its 6-hour start-to-close timeout (less one final tick).
  //
  // Clamped, not rejected. The settings form sends every field on every save,
  // so a row stored before these bounds existed — or a value the worker would
  // clamp anyway — would otherwise turn every save of an unrelated field into a
  // 400. The lower bound stays a rejection: there is no sensible value to
  // round a zero or negative interval to.
  ciPollDeadlineSec: z
    .number()
    .int()
    .min(1)
    .transform((v) => Math.min(v, CI_POLL_DEADLINE_MAX_SEC))
    .nullable()
    .optional(),
  ciPollGraceSec: z.number().int().min(1).nullable().optional(),
  ciPollIntervalSec: z
    .number()
    .int()
    .min(1)
    .transform((v) => Math.min(v, CI_POLL_INTERVAL_MAX_SEC))
    .nullable()
    .optional(),
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

  // ── Clear a stored secret ───────────────────────────────────────────────────

  // A PUT can only replace a secret. This removes the stored one, which hands the value back
  // to its environment variable when one is set, and to "not configured" when it is not.
  f.delete(
    '/config/:integration/secrets/:field',
    {
      schema: {
        params: z.object({
          field: z.string().max(40),
          integration: z.enum(Object.keys(CLEARABLE_SECRETS) as [ClearableIntegration]),
        }),
        response: { 200: z.any(), 400: z.any(), 404: z.any() },
      },
    },
    async (req, reply) => {
      const { field, integration } = req.params;
      if (!(CLEARABLE_SECRETS[integration] as readonly string[]).includes(field)) {
        return reply.status(400).send({
          error: {
            code: 'NOT_A_SECRET',
            message: `'${field}' is not a secret field of ${integration}`,
          },
        });
      }
      const cleared = await clearStoredSecret(
        fastify.prisma,
        fastify.log,
        requireUser(req).sub,
        integration,
        field
      );
      if (!cleared) {
        return reply.status(404).send({
          error: { code: 'NOT_STORED', message: 'No value is stored for this field' },
        });
      }
      return reply.send(await getIntegrationConfig(fastify.prisma, integration));
    }
  );

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

  f.post(
    '/config/github/test',
    { schema: { body: GitHubTestBody.optional(), response: { 200: z.any() } } },
    async (req, reply) => reply.send(await testGitHubConnection(req.body ?? {}))
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

  f.post(
    '/config/slack/test',
    { schema: { body: SlackTestBody.optional(), response: { 200: z.any() } } },
    async (req, reply) => reply.send(await testSlackConnection(req.body ?? {}))
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

  // ── Issue tracker ────────────────────────────────────────────────────────────

  f.get('/config/issue-tracker', { schema: { response: { 200: z.any() } } }, async (_req, reply) =>
    reply.send(await getIssueTrackerConfig(fastify.prisma))
  );

  f.put(
    '/config/issue-tracker',
    { schema: { body: IssueTrackerPutBody, response: { 200: z.any(), 400: z.any() } } },
    async (req, reply) => {
      const refusal = await issueTrackerBaseUrlRefusal(fastify.prisma, req.body);
      if (refusal) {
        return reply.status(400).send({
          error: {
            code: 'BASE_URL_REFUSED',
            message: `Base URL refused: ${refusal}. The private-network option permits private addresses only, never loopback, link-local or metadata addresses.`,
          },
        });
      }
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
    { schema: { body: KnowledgeBasePutBody, response: { 200: z.any(), 400: z.any() } } },
    async (req, reply) => {
      const refusal = await knowledgeBaseBaseUrlRefusal(fastify.prisma, req.body);
      if (refusal) {
        return reply.status(400).send({
          error: {
            code: 'BASE_URL_REFUSED',
            message: `Base URL refused: ${refusal}. The private-network option permits private addresses only, never loopback, link-local or metadata addresses.`,
          },
        });
      }
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
