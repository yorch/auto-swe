import crypto from 'node:crypto';
import { Prisma } from '@auto-swe/shared';
import { isInputSchema, validateInputPayload } from '@auto-swe/shared/lib/inputSchema';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
  type WorkspaceProviderType,
  WorkspaceProviderTypeSchema,
} from '@auto-swe/shared/lib/workspaceProviders';
import { WORKFLOW_TEMPLATE_STATUSES } from '@auto-swe/shared/types/api';
import type { BudgetTier, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import {
  assertShellImageAllowed,
  computeAnalytics,
  computeGlobalAnalytics,
  diffSpecs,
  formatValidationIssue,
  migrateSpec,
  parseWorkflowSpec,
  ShellImageNotAllowedError,
  SPEC_SCHEMA_VERSION,
  validateSpec,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdempotencyHeaderSchema, workflowIdFromIdempotencyKey } from '../lib/idempotency.js';
import { assertOrgBudget } from '../lib/orgAccess.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import { validateRunConnection } from '../lib/runConnection.js';
import { validateSpecRefs } from '../lib/specRefValidation.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { type JwtPayload, requireAuth, requireUser } from '../plugins/auth.js';
import { projectRunSummary, RunListPaginationQuery } from './workflowProjections.js';

/**
 * Stable marker the `generateWorkflowSpec` activity puts in its thrown message
 * when the model fails to produce a valid spec after all repair attempts. Used
 * to tell a genuine generation failure (→ 422) from an infra error (→ 503).
 */
const AUTHOR_GENERATION_FAILURE_MARKER = 'could not produce a valid WorkflowSpec';

/**
 * A Temporal `WorkflowFailedError` wraps the activity's `ApplicationFailure` in a
 * `cause` chain, so walk it looking for the author-failure marker.
 */
function isAuthorGenerationFailure(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    if (cur.message.includes(AUTHOR_GENERATION_FAILURE_MARKER)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Shared authoring RBAC for the generate endpoints: non-admins may only target a
 * team they belong to and may not author global templates. Returns the
 * `allowShell` hint (admin or team-admin) on success, or a reply to send.
 */
async function resolveTemplateAuthScope(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string | null
): Promise<{ ok: true; allowShell: boolean } | { ok: false; statusCode: number; body: unknown }> {
  if (user.role === 'ADMIN') {
    return { allowShell: true, ok: true };
  }
  if (!teamId) {
    return {
      body: { error: { code: 'FORBIDDEN', message: 'Only admins may create global templates' } },
      ok: false,
      statusCode: 403,
    };
  }
  const member = await fastify.prisma.teamMembership.findFirst({
    where: { teamId, userId: user.sub },
  });
  if (!member) {
    return {
      body: { error: { code: 'FORBIDDEN', message: 'Not a member of this team' } },
      ok: false,
      statusCode: 403,
    };
  }
  return { allowShell: member.role === 'ADMIN', ok: true };
}

interface ShellNodeWithId {
  id: string;
  /** Structural subset shared by `shell` and `containerStep` — both run a
   *  team-authored image+command and are gated/audited identically. */
  node: { image: string; command: string; network?: 'none' | 'egress' };
}

// Both `shell` and `containerStep` execute team-authored code in a container, so
// they share the same authoring RBAC, image allowlist, and audit trail.
function collectShellNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'shell') {
      out.push({ id, node });
    } else if (node.type === 'containerStep') {
      out.push({
        id,
        node: { command: node.command ?? '', image: node.image, network: node.network },
      });
    }
  }
  return out;
}

/**
 * Phase-6 RBAC: authoring a spec with any shell node requires the
 * `workflow:write:shell` permission. We map it to:
 *   - platform ADMIN, OR
 *   - team-role ADMIN in the template's owning team (templates with
 *     teamId === null are global → only platform ADMINs may save shell
 *     nodes there).
 * Returns a Fastify reply on failure, or null on success.
 */
async function assertShellAuthoringAllowed(
  fastify: FastifyInstance,
  user: JwtPayload,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<{ statusCode: number; body: unknown } | null> {
  if (shellNodes.length === 0) {
    return null;
  }
  if (user.role === 'ADMIN') {
    return null;
  }
  if (teamId === null) {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Only platform admins may author shell steps on global templates',
        },
      },
      statusCode: 403,
    };
  }
  const membership = await fastify.prisma.teamMembership.findUnique({
    where: { userId_teamId: { teamId, userId: user.sub } },
  });
  if (membership?.role !== 'ADMIN') {
    return {
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Authoring shell steps requires team-admin role',
        },
      },
      statusCode: 403,
    };
  }
  return null;
}

async function assertShellImagesAllowed(
  fastify: FastifyInstance,
  teamId: string | null,
  shellNodes: ShellNodeWithId[]
): Promise<
  { ok: true; egressAllowlist: string[] } | { ok: false; statusCode: number; body: unknown }
> {
  if (shellNodes.length === 0) {
    return { egressAllowlist: [], ok: true };
  }
  const team = teamId
    ? await fastify.prisma.team.findUnique({
        select: { egressAllowlist: true, shellImageAllowlist: true },
        where: { id: teamId },
      })
    : null;
  const teamAllowlist = team?.shellImageAllowlist ?? [];
  for (const { id, node } of shellNodes) {
    try {
      assertShellImageAllowed(node.image, teamAllowlist);
    } catch (err) {
      if (err instanceof ShellImageNotAllowedError) {
        return {
          body: {
            error: {
              code: 'SHELL_IMAGE_NOT_ALLOWED',
              message: `Node '${id}': ${err.message}`,
            },
          },
          ok: false,
          statusCode: 400,
        };
      }
      throw err;
    }
  }
  return { egressAllowlist: team?.egressAllowlist ?? [], ok: true };
}

/**
 * Insert the audit rows. Accepts either the singleton prisma client or a
 * transaction client so the caller can wrap the version write + audit in a
 * single atomic step — without that, a failed audit insert leaves the version
 * row in place and the API reports an error, an inconsistency that's hard
 * to reconcile later.
 */
async function recordShellAudit(
  tx: Pick<FastifyInstance['prisma'], 'workflowShellAudit'>,
  templateVersionId: string,
  teamId: string | null,
  authorUserId: string,
  shellNodes: ShellNodeWithId[],
  egressAllowlist: string[]
): Promise<void> {
  if (shellNodes.length === 0) {
    return;
  }
  await tx.workflowShellAudit.createMany({
    data: shellNodes.map(({ id, node }) => ({
      authorUserId,
      command: node.command,
      egressAllowlistSnapshot: egressAllowlist,
      image: node.image,
      network: node.network ?? 'none',
      nodeId: id,
      teamId,
      templateVersionId,
    })),
  });
}

const TemplateIdParam = z.object({ id: z.string().uuid() });
const VersionParam = z.object({ id: z.string().uuid(), version: z.coerce.number().int().min(1) });

const CreateTemplateBody = z.object({
  description: z.string().max(2000).optional(),
  name: z.string().min(1).max(120),
  spec: z.unknown(),
  teamId: z.string().uuid().nullable().optional(),
  workspaceProvider: WorkspaceProviderTypeSchema.nullable().optional(),
});

const UpdateTemplateBody = z.object({
  description: z.string().max(2000).optional(),
  estimatedHumanTimeSavedMinutes: z.number().min(0).nullable().optional(),
  experimentSplit: z.number().int().min(0).max(100).nullable().optional(),
  experimentVersion: z.number().int().min(1).nullable().optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  status: z.enum(WORKFLOW_TEMPLATE_STATUSES).optional(),
  workspaceProvider: WorkspaceProviderTypeSchema.nullable().optional(),
});

const CreateVersionBody = z.object({ spec: z.unknown() });
const PromoteBody = z.object({ version: z.number().int().min(1) });
const ListTemplatesQuery = z.object({ teamId: z.string().uuid().optional() });
const TEMPLATE_INCLUDE = {
  _count: { select: { versions: true } },
  team: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.WorkflowTemplateInclude;

type TemplateWithIncludes = Prisma.WorkflowTemplateGetPayload<{ include: typeof TEMPLATE_INCLUDE }>;

/**
 * Create a template + its initial v1 version + shell audit in one transaction
 * (so a failed audit insert rolls back the template, keeping API success aligned
 * with persisted state). Shared by `POST /` (status ACTIVE) and `POST /generate`
 * (status DRAFT) so the persist/audit shape lives in one place.
 */
async function createTemplateWithInitialVersion(
  prisma: FastifyInstance['prisma'],
  args: {
    name: string;
    description: string;
    teamId: string | null;
    status: 'ACTIVE' | 'DRAFT';
    specJson: object;
    authorUserId: string;
    shellNodes: ShellNodeWithId[];
    egressAllowlist: string[];
    workspaceProvider: string | null;
    generatedBy?: string | null;
  }
): Promise<TemplateWithIncludes> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.workflowTemplate.create({
      data: {
        activeVersion: 1,
        description: args.description,
        name: args.name,
        status: args.status,
        teamId: args.teamId,
        versions: {
          create: {
            createdBy: args.authorUserId,
            generatedBy: args.generatedBy,
            spec: args.specJson,
            version: 1,
          },
        },
        workspaceProvider: args.workspaceProvider,
      },
      include: { ...TEMPLATE_INCLUDE, versions: { select: { id: true, version: true } } },
    });
    const initialVersion = created.versions[0];
    if (initialVersion) {
      await recordShellAudit(
        tx,
        initialVersion.id,
        args.teamId,
        args.authorUserId,
        args.shellNodes,
        args.egressAllowlist
      );
    }
    return created;
  });
}

/**
 * Append a new immutable version to an existing template, picking the next
 * version number under concurrency. SELECT max(version)+1 / INSERT is racy — two
 * simultaneous saves would pick the same `next` and Prisma's unique
 * (templateId, version) constraint would 500 the loser — so this retries on
 * P2002 with a fresh max, bounded so a runaway loop can't spin forever. Each
 * attempt's version-create + shell-audit run in one transaction so a failed
 * audit rolls the version back too. Returns the created row, or `null` when the
 * retry budget is exhausted (the caller maps that to a 409). Shared by
 * `POST /:id/versions` and `POST /:id/refine`.
 */
async function createTemplateVersion(
  prisma: FastifyInstance['prisma'],
  args: {
    templateId: string;
    teamId: string | null;
    specJson: object;
    authorUserId: string;
    shellNodes: ShellNodeWithId[];
    egressAllowlist: string[];
    generatedBy?: string | null;
  }
): Promise<{
  id: string;
  version: number;
  spec: unknown;
  createdAt: Date;
  createdBy: string | null;
  generatedBy: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
} | null> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const last = await prisma.workflowTemplateVersion.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
      where: { templateId: args.templateId },
    });
    const next = (last?.version ?? 0) + 1;
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.workflowTemplateVersion.create({
          data: {
            createdBy: args.authorUserId,
            generatedBy: args.generatedBy,
            spec: args.specJson,
            templateId: args.templateId,
            version: next,
          },
        });
        await recordShellAudit(
          tx,
          row.id,
          args.teamId,
          args.authorUserId,
          args.shellNodes,
          args.egressAllowlist
        );
        return row;
      });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code !== 'P2002' || attempt === MAX_RETRIES - 1) {
        throw err;
      }
    }
  }
  return null;
}

function teamMembershipFilter(user: {
  sub: string;
  role: string;
}): Prisma.WorkflowTemplateWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    OR: [
      { teamId: null }, // Global templates visible to everyone
      { team: { memberships: { some: { userId: user.sub } } } },
    ],
  };
}

interface LastRunRow {
  templateId: string;
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

async function loadLastRuns(
  fastify: FastifyInstance,
  templateIds: string[]
): Promise<Map<string, LastRunRow>> {
  if (templateIds.length === 0) {
    return new Map();
  }
  // One query per template using groupBy would also work, but findMany distinct on
  // (templateId) ordered by startedAt desc is the simpler portable pattern.
  const rows = (await fastify.prisma.workflowRun.findMany({
    distinct: ['templateId'],
    orderBy: { startedAt: 'desc' },
    select: { endedAt: true, id: true, startedAt: true, status: true, templateId: true },
    where: { templateId: { in: templateIds } },
  })) as unknown as LastRunRow[];
  return new Map(rows.map((r) => [r.templateId, r]));
}

function projectTemplate(tpl: TemplateWithIncludes, lastRun: LastRunRow | undefined) {
  return {
    activeVersion: tpl.activeVersion,
    createdAt: tpl.createdAt,
    description: tpl.description,
    experimentSplit: tpl.experimentSplit,
    experimentVersion: tpl.experimentVersion,
    id: tpl.id,
    inputSchema: tpl.inputSchema ?? null,
    isDefault: tpl.isDefault,
    lastRun: lastRun
      ? {
          endedAt: lastRun.endedAt,
          id: lastRun.id,
          startedAt: lastRun.startedAt,
          status: lastRun.status,
        }
      : null,
    name: tpl.name,
    status: tpl.status,
    team: tpl.team ? { id: tpl.team.id, name: tpl.team.name, slug: tpl.team.slug } : null,
    updatedAt: tpl.updatedAt,
    versionCount: tpl._count.versions,
    webhookToken: tpl.webhookToken ?? null,
    workspaceProvider: tpl.workspaceProvider ?? null,
  };
}

function parseSpecOrThrow(input: unknown): unknown {
  // Strict check: the spec must already declare the current SPEC_SCHEMA_VERSION.
  // The codemod machinery runs at workflow start (templates.ts → migrateSpec) to
  // upgrade already-stored specs, but the editor is expected to migrate before
  // saving, so we don't auto-upgrade here — otherwise older clients could
  // silently round-trip a spec they don't fully understand.
  const spec = input as { schemaVersion?: unknown } | null;
  if (!spec || typeof spec !== 'object') {
    throw Object.assign(new Error('spec must be an object'), { statusCode: 400 });
  }
  if (spec.schemaVersion !== SPEC_SCHEMA_VERSION) {
    throw Object.assign(
      new Error(
        `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got ${String(spec.schemaVersion)})`
      ),
      { statusCode: 400 }
    );
  }
  try {
    return parseWorkflowSpec(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid spec';
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
}

/**
 * Static pre-execution findings for a spec, formatted as non-blocking save
 * warnings (mirrors `validateSpecRefs`). We deliberately DON'T block save on
 * these — a work-in-progress draft may legitimately not terminate yet, and the
 * generation loop already hard-gates AI output on `validateSpec().errors`. The
 * canvas can surface these as live lint.
 */
function specValidationWarnings(spec: WorkflowSpec): string[] {
  const report = validateSpec(spec);
  return [...report.errors, ...report.warnings].map(formatValidationIssue);
}

/** Visibility filter for workflow runs: mirrors the logic in workflowRuns.ts so that
 *  per-template run lists never leak cross-org work for global templates. */
function runVisibilityFilter(user: { sub: string; role: string }): Prisma.WorkflowRunWhereInput {
  if (user.role === 'ADMIN') {
    return {};
  }
  return {
    OR: [
      { template: { teamId: null } },
      { template: { team: { memberships: { some: { userId: user.sub } } } } },
      {
        workRequest: {
          activeWorkflows: {
            some: { repository: { team: { memberships: { some: { userId: user.sub } } } } },
          },
        },
      },
    ],
  };
}

export const workflowTemplateRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── Cross-template analytics (phase 8) ──
  // GET /analytics?window=<days>
  // Aggregates run counts + cost across every template visible to the caller.
  // Must come BEFORE the `/:id`-style routes so 'analytics' doesn't get matched
  // as a UUID parameter by Fastify's prefix tree.
  const GlobalAnalyticsQuery = z.object({
    window: z.coerce.number().int().min(1).max(365).default(30),
  });
  app.get(
    '/analytics',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: GlobalAnalyticsQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const windowStart = new Date(Date.now() - request.query.window * 24 * 60 * 60 * 1000);
      const ANALYTICS_ROW_CAP = 10_000;
      const rows = await fastify.prisma.workflowRun.findMany({
        orderBy: { startedAt: 'desc' },
        select: {
          costUsdAccrued: true,
          endedAt: true,
          estimatedHumanTimeSaved: true,
          hadHumanStep: true,
          outcomeDomain: true,
          outcomeType: true,
          startedAt: true,
          status: true,
          template: { select: { id: true, name: true } },
          templateId: true,
          wasAutonomous: true,
          // Same back-compat fallback the per-template route uses: legacy +
          // RUNNING rows have `costUsdAccrued = 0` and we read through
          // workRequest → activeWorkflows so the global rollup doesn't
          // under-report cost for them.
          workRequest: {
            select: {
              activeWorkflows: { select: { costUsdAccrued: true } },
            },
          },
        },
        take: ANALYTICS_ROW_CAP,
        where: {
          startedAt: { gte: windowStart },
          // Visibility: piggy-back on the same per-template filter to scope
          // the global rollup to what this user is allowed to see.
          template: teamMembershipFilter(user),
        },
      });
      const analytics = computeGlobalAnalytics(
        rows.map((r) => ({
          costUsdAccrued:
            r.costUsdAccrued > 0
              ? r.costUsdAccrued
              : (r.workRequest?.activeWorkflows ?? []).reduce(
                  (sum, aw) => sum + aw.costUsdAccrued,
                  0
                ),
          endedAt: r.endedAt,
          estimatedHumanTimeSaved: r.estimatedHumanTimeSaved,
          hadHumanStep: r.hadHumanStep,
          outcomeDomain: r.outcomeDomain,
          outcomeType: r.outcomeType,
          startedAt: r.startedAt,
          status: r.status,
          templateId: r.template.id,
          templateName: r.template.name,
          wasAutonomous: r.wasAutonomous,
        })),
        request.query.window
      );
      return { data: analytics };
    }
  );

  // ── Generate a template from a natural-language description ──
  // POST /generate { prompt, teamId?, name? }
  // Runs the workflowAuthor agent (in the worker) to synthesize a WorkflowSpec,
  // then persists it as a DRAFT template so a human can review/edit it on the
  // canvas before activating. Same authoring RBAC + shell gating as POST /.
  // Placed before `/:id` so 'generate' is not matched as a template UUID.
  const GenerateTemplateBody = z.object({
    name: z.string().min(1).max(120).optional(),
    prompt: z.string().min(1).max(8000),
    teamId: z.string().uuid().nullable().optional(),
    workspaceProvider: WorkspaceProviderTypeSchema.nullable().optional(),
  });
  app.post(
    '/generate',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: GenerateTemplateBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { prompt, teamId, name: nameOverride } = request.body;

      // RBAC mirrors POST /: non-admins may only target a team they belong to and
      // may not author global templates. `allowShell` is the hint passed to the
      // author agent (the real gate is assertShellAuthoringAllowed at persist).
      const scope = await resolveTemplateAuthScope(fastify, user, teamId ?? null);
      if (!scope.ok) {
        return reply.status(scope.statusCode).send(scope.body);
      }
      const { allowShell } = scope;

      // Generate via the worker (start WorkflowAuthorWorkflow + await its result).
      let generated: { spec: WorkflowSpec; summary: string; attempts: number };
      try {
        const wfId = `wfauthor-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        generated = await fastify.temporal.generateWorkflowSpec(wfId, {
          allowShell,
          prompt,
          teamId: teamId ?? null,
        });
      } catch (err) {
        request.log.error({ err }, 'workflow generation failed');
        // Distinguish a genuine "model couldn't produce a valid spec" (the user
        // should rephrase → 422) from an infrastructure failure (worker down,
        // Temporal unreachable → 503, rephrasing won't help). The author activity
        // tags the former with a stable marker in its thrown message.
        if (isAuthorGenerationFailure(err)) {
          return reply.status(422).send({
            error: {
              code: 'GENERATION_FAILED',
              message:
                'The author agent could not produce a valid workflow from that description. Try rephrasing with more detail.',
            },
          });
        }
        return reply.status(503).send({
          error: {
            code: 'GENERATION_UNAVAILABLE',
            message: 'Workflow generation is temporarily unavailable. Please try again shortly.',
          },
        });
      }

      // Defensive re-validation (the worker already validated against the schema).
      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(generated.spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }

      const parsedSpec = parsed as WorkflowSpec;
      // Caller may override the model-chosen name; keep template + spec name aligned.
      if (nameOverride) {
        parsedSpec.name = nameOverride;
      }
      const name = parsedSpec.name;

      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, teamId ?? null, shellNodes),
        assertShellImagesAllowed(fastify, teamId ?? null, shellNodes),
      ]);
      if (rbac) {
        return reply.status(rbac.statusCode).send(rbac.body);
      }
      if (!imgGate.ok) {
        return reply.status(imgGate.statusCode).send(imgGate.body);
      }
      const { egressAllowlist } = imgGate;

      try {
        // DRAFT (not ACTIVE): the human reviews/edits on the canvas, then activates.
        const tpl = await createTemplateWithInitialVersion(fastify.prisma, {
          authorUserId: user.sub,
          description: parsedSpec.description ?? '',
          egressAllowlist,
          generatedBy: 'workflow_author',
          name,
          shellNodes,
          specJson: parsed as object,
          status: 'DRAFT',
          teamId: teamId ?? null,
          workspaceProvider: request.body.workspaceProvider ?? null,
        });
        const warnings = [
          ...(await validateSpecRefs(fastify.prisma, parsedSpec)),
          ...specValidationWarnings(parsedSpec),
        ];
        return reply.status(201).send({
          attempts: generated.attempts,
          data: projectTemplate(tpl, undefined),
          spec: parsed,
          summary: generated.summary,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'P2002') {
          return reply.status(409).send({
            error: {
              code: 'NAME_CONFLICT',
              message: `A template named "${name}" already exists — pass a different "name".`,
            },
          });
        }
        throw err;
      }
    }
  );

  // ── Async generation: start a job ──
  // POST /generate/jobs { prompt, teamId?, name? } → 202 { jobId }
  // Non-blocking variant of POST /generate: starts WorkflowAuthorJobWorkflow
  // (which generates AND persists the DRAFT worker-side) and returns a job id the
  // client polls. Avoids holding the HTTP request open for the whole generation
  // (proxy idle-timeouts). This path is not shell-authorized (the job refuses
  // shell nodes); use the synchronous POST /generate for shell-capable authoring.
  app.post(
    '/generate/jobs',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: GenerateTemplateBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { prompt, teamId, name } = request.body;
      const scope = await resolveTemplateAuthScope(fastify, user, teamId ?? null);
      if (!scope.ok) {
        return reply.status(scope.statusCode).send(scope.body);
      }
      const jobId = `wfauthorjob-${crypto.randomUUID().replace(/-/g, '')}`;
      await fastify.temporal.startWorkflowAuthorJob(jobId, {
        createdById: user.sub,
        name,
        prompt,
        teamId: teamId ?? null,
      });
      return reply.status(202).send({ data: { jobId } });
    }
  );

  // ── Async generation: poll a job ──
  // GET /generate/jobs/:jobId → { status: 'running'|'done'|'failed', ... }
  const JobIdParam = z.object({ jobId: z.string().min(8).max(80) });
  app.get(
    '/generate/jobs/:jobId',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { params: JobIdParam },
    },
    async (request) => {
      const status = await fastify.temporal.getWorkflowAuthorJobStatus(request.params.jobId);
      if (status.status === 'running') {
        return { data: { phase: status.phase ?? 'generating', status: 'running' } };
      }
      if (status.status === 'done') {
        return { data: { status: 'done', ...status.result } };
      }
      return { data: { code: status.code, message: status.message, status: 'failed' } };
    }
  );

  // ── List templates ──
  app.get(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { querystring: ListTemplatesQuery },
    },
    async (request) => {
      const user = requireUser(request);
      const where: Prisma.WorkflowTemplateWhereInput = {
        ...teamMembershipFilter(user),
        ...(request.query.teamId ? { teamId: request.query.teamId } : {}),
      };
      // `teamMembershipFilter` is `{}` for a platform admin.
      const templates = await asPlatformAdmin(
        user,
        "admin lists every team's templates",
        ['WorkflowTemplate'],
        () =>
          fastify.prisma.workflowTemplate.findMany({
            include: TEMPLATE_INCLUDE,
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
            where,
          })
      );
      const lastRuns = await loadLastRuns(
        fastify,
        templates.map((t) => t.id)
      );
      return { data: templates.map((t) => projectTemplate(t, lastRuns.get(t.id))) };
    }
  );

  // ── Create template ──
  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateTemplateBody },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { name, description, teamId, spec, workspaceProvider } = request.body;

      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }

      // Non-admins may only create team-owned templates for teams they belong to,
      // and may not create global (teamId = null) templates.
      if (user.role !== 'ADMIN') {
        if (!teamId) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Only admins may create global templates' },
          });
        }
        const member = await fastify.prisma.teamMembership.findFirst({
          where: { teamId, userId: user.sub },
        });
        if (!member) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Not a member of this team' },
          });
        }
      }

      const parsedSpec = parsed as WorkflowSpec;
      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, teamId ?? null, shellNodes),
        assertShellImagesAllowed(fastify, teamId ?? null, shellNodes),
      ]);
      if (rbac) {
        return reply.status(rbac.statusCode).send(rbac.body);
      }
      if (!imgGate.ok) {
        return reply.status(imgGate.statusCode).send(imgGate.body);
      }
      const { egressAllowlist } = imgGate;

      try {
        const tpl = await createTemplateWithInitialVersion(fastify.prisma, {
          authorUserId: user.sub,
          description: description ?? '',
          egressAllowlist,
          name,
          shellNodes,
          specJson: parsed as object,
          status: 'ACTIVE',
          teamId: teamId ?? null,
          workspaceProvider: workspaceProvider ?? 'git_repo',
        });
        // Non-fatal: surface unresolved agent/mcp refs as warnings (never blocks save).
        const warnings = [
          ...(await validateSpecRefs(fastify.prisma, parsedSpec)),
          ...specValidationWarnings(parsedSpec),
        ];
        return reply.status(201).send({
          data: projectTemplate(tpl, undefined),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'P2002') {
          return reply.status(409).send({
            error: { code: 'NAME_CONFLICT', message: 'A template with this name already exists' },
          });
        }
        throw err;
      }
    }
  );

  // ── Get template detail (with versions list + active spec) ──
  app.get(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        include: {
          ...TEMPLATE_INCLUDE,
          versions: {
            orderBy: { version: 'desc' },
            select: {
              createdAt: true,
              createdBy: true,
              generatedBy: true,
              id: true,
              reviewedAt: true,
              reviewedBy: true,
              version: true,
            },
          },
        },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const lastRuns = await loadLastRuns(fastify, [tpl.id]);
      const base = projectTemplate(tpl, lastRuns.get(tpl.id));
      const activeVersionRow = tpl.activeVersion
        ? await fastify.prisma.workflowTemplateVersion.findUnique({
            where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
          })
        : null;
      return {
        data: {
          ...base,
          activeVersionSpec: activeVersionRow
            ? {
                createdAt: activeVersionRow.createdAt,
                createdBy: activeVersionRow.createdBy,
                generatedBy: activeVersionRow.generatedBy,
                id: activeVersionRow.id,
                reviewedAt: activeVersionRow.reviewedAt,
                reviewedBy: activeVersionRow.reviewedBy,
                spec: activeVersionRow.spec,
                version: activeVersionRow.version,
              }
            : null,
          versions: tpl.versions,
        },
      };
    }
  );

  // ── Patch metadata (rename, description, default flag, status) ──
  app.patch(
    '/:id',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: UpdateTemplateBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!existing) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }

      // Experiment-config validation. Done at PATCH time (vs. a CHECK constraint)
      // because the rule depends on a sibling row (the version must exist for
      // this template) which Postgres can't express cheaply.
      const expVersion = request.body.experimentVersion;
      const expSplit = request.body.experimentSplit;
      if (expVersion !== undefined && expVersion !== null) {
        const v = await fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: existing.id, version: expVersion } },
        });
        if (!v) {
          return reply.status(400).send({
            error: {
              code: 'EXPERIMENT_VERSION_NOT_FOUND',
              message: `Version ${expVersion} does not exist on this template`,
            },
          });
        }
      }
      // Enabling traffic split without a destination version is meaningless and
      // would silently no-op in the resolver — reject it up front.
      const nextExpVersion = expVersion !== undefined ? expVersion : existing.experimentVersion;
      const nextExpSplit = expSplit !== undefined ? expSplit : existing.experimentSplit;
      if (nextExpSplit !== null && nextExpSplit > 0 && nextExpVersion === null) {
        return reply.status(400).send({
          error: {
            code: 'EXPERIMENT_VERSION_REQUIRED',
            message: 'experimentSplit > 0 requires experimentVersion to be set',
          },
        });
      }

      const { inputSchema: rawInputSchema, ...restBody } = request.body;
      const updateData: Prisma.WorkflowTemplateUpdateInput = {
        ...restBody,
        ...(rawInputSchema !== undefined && {
          inputSchema:
            rawInputSchema != null
              ? (rawInputSchema as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
        }),
      };

      // Toggling isDefault has team-wide side effects: ensure exactly one
      // default per (teamId, isDefault=true). Clearing siblings and applying
      // this update run in one transaction so a concurrent read can never
      // observe a moment with zero (or more than one) default template for
      // the team.
      const updated: TemplateWithIncludes = await fastify.prisma.$transaction(async (tx) => {
        if (request.body.isDefault === true) {
          await tx.workflowTemplate.updateMany({
            data: { isDefault: false },
            where: { id: { not: existing.id }, teamId: existing.teamId },
          });
        }
        return tx.workflowTemplate.update({
          data: updateData,
          include: TEMPLATE_INCLUDE,
          where: { id: existing.id },
        });
      });
      const lastRuns = await loadLastRuns(fastify, [updated.id]);
      return { data: projectTemplate(updated, lastRuns.get(updated.id)) };
    }
  );

  // ── Explain a template in plain language ──
  // POST /:id/explain — runs the workflowExplainer agent over the active
  // version's spec and returns a Markdown explanation. Read-level (ENGINEER):
  // it touches no state, just describes an already-visible template.
  app.post(
    '/:id/explain',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { activeVersion: true, id: true, teamId: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      if (!tpl.activeVersion) {
        return reply.status(400).send({
          error: {
            code: 'NO_ACTIVE_VERSION',
            message: 'Template has no active version to explain',
          },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.findUnique({
        where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
      });
      if (!version) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'Active version not found' },
        });
      }
      // Migrate an older stored spec to the current schema first (the codemod
      // path the interpreter runs at workflow start), then parse — so a viewable,
      // runnable template can always be explained rather than 400-ing here.
      let parsedSpec: WorkflowSpec;
      try {
        parsedSpec = parseWorkflowSpec(migrateSpec(version.spec, SPEC_SCHEMA_VERSION));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid spec';
        return reply.status(400).send({ error: { code: 'INVALID_SPEC', message } });
      }

      try {
        const wfId = `wfexplain-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const { explanation } = await fastify.temporal.explainWorkflowSpec(wfId, {
          spec: parsedSpec,
          teamId: tpl.teamId,
        });
        return { data: { explanation } };
      } catch (err) {
        request.log.error({ err }, 'workflow explanation failed');
        return reply.status(503).send({
          error: {
            code: 'EXPLAIN_UNAVAILABLE',
            message: 'Could not generate an explanation right now. Please try again shortly.',
          },
        });
      }
    }
  );

  // ── Refine a template conversationally ──
  // POST /:id/refine { prompt } — seed the workflowAuthor agent with the
  // template's LATEST version spec + a plain-language change, then save the
  // refined result as a NEW version (DRAFT-friendly: history is preserved and a
  // human still activates). This is the inverse-of-generate iteration loop that
  // backs the web chat panel and the Slack thread. Write-level (LEAD), same
  // shell gating as POST /:id/versions.
  const RefineTemplateBody = z.object({
    prompt: z.string().min(1).max(8000),
  });
  app.post(
    '/:id/refine',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: RefineTemplateBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true, name: true, teamId: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      // Refine the most recent version (the current draft state), not the
      // promoted one — that's what the user is iterating on.
      const latest = await fastify.prisma.workflowTemplateVersion.findFirst({
        orderBy: { version: 'desc' },
        where: { templateId: tpl.id },
      });
      if (!latest) {
        return reply.status(400).send({
          error: { code: 'NO_VERSION', message: 'Template has no version to refine' },
        });
      }
      let baseSpec: WorkflowSpec;
      try {
        baseSpec = parseWorkflowSpec(migrateSpec(latest.spec, SPEC_SCHEMA_VERSION));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid spec';
        return reply.status(400).send({ error: { code: 'INVALID_SPEC', message } });
      }

      // `allowShell` is a hint to the author agent (the real gate is
      // assertShellAuthoringAllowed at persist). Mirror the version-create
      // stance: any LEAD member may refine, but only admins / team-admins may
      // (re)introduce shell nodes.
      let allowShell = user.role === 'ADMIN';
      if (!allowShell && tpl.teamId) {
        const member = await fastify.prisma.teamMembership.findFirst({
          where: { teamId: tpl.teamId, userId: user.sub },
        });
        allowShell = member?.role === 'ADMIN';
      }

      let generated: { spec: WorkflowSpec; summary: string; attempts: number };
      try {
        const wfId = `wfrefine-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        generated = await fastify.temporal.generateWorkflowSpec(wfId, {
          allowShell,
          baseSpec,
          prompt: request.body.prompt,
          teamId: tpl.teamId,
        });
      } catch (err) {
        request.log.error({ err }, 'workflow refinement failed');
        if (isAuthorGenerationFailure(err)) {
          return reply.status(422).send({
            error: {
              code: 'REFINE_FAILED',
              message:
                'The author agent could not apply that change. Try rephrasing the request with more detail.',
            },
          });
        }
        return reply.status(503).send({
          error: {
            code: 'REFINE_UNAVAILABLE',
            message: 'Workflow refinement is temporarily unavailable. Please try again shortly.',
          },
        });
      }

      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(generated.spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }
      const parsedSpec = parsed as WorkflowSpec;
      // Keep the spec name pinned to the template so a refinement can't silently
      // rename (or collide) the template it belongs to.
      parsedSpec.name = tpl.name;

      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, tpl.teamId, shellNodes),
        assertShellImagesAllowed(fastify, tpl.teamId, shellNodes),
      ]);
      if (rbac) {
        return reply.status(rbac.statusCode).send(rbac.body);
      }
      if (!imgGate.ok) {
        return reply.status(imgGate.statusCode).send(imgGate.body);
      }

      const created = await createTemplateVersion(fastify.prisma, {
        authorUserId: user.sub,
        egressAllowlist: imgGate.egressAllowlist,
        generatedBy: 'workflow_author',
        shellNodes,
        specJson: parsedSpec as object,
        teamId: tpl.teamId,
        templateId: tpl.id,
      });
      if (!created) {
        return reply.status(409).send({
          error: { code: 'VERSION_CONFLICT', message: 'Concurrent version writes — please retry' },
        });
      }
      const warnings = [
        ...(await validateSpecRefs(fastify.prisma, parsedSpec)),
        ...specValidationWarnings(parsedSpec),
      ];
      return reply.status(201).send({
        attempts: generated.attempts,
        data: {
          createdAt: created.createdAt,
          createdBy: created.createdBy,
          generatedBy: created.generatedBy,
          id: created.id,
          reviewedAt: created.reviewedAt,
          reviewedBy: created.reviewedBy,
          spec: created.spec,
          version: created.version,
        },
        spec: parsedSpec,
        summary: generated.summary,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }
  );

  // ── Get a specific version's spec ──
  app.get(
    '/:id/versions/:version',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: VersionParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.findUnique({
        where: {
          templateId_version: { templateId: tpl.id, version: request.params.version },
        },
      });
      if (!version) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
      }
      return {
        data: {
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          generatedBy: version.generatedBy,
          id: version.id,
          reviewedAt: version.reviewedAt,
          reviewedBy: version.reviewedBy,
          spec: version.spec,
          version: version.version,
        },
      };
    }
  );

  // ── Review a generated version before it can be promoted ──
  // POST /:id/versions/:version/review
  // Marks a version as human-reviewed. Required for AI-generated versions
  // (generatedBy is set) before POST /:id/promote will accept them.
  app.post(
    '/:id/versions/:version/review',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { params: VersionParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.update({
        data: { reviewedAt: new Date(), reviewedBy: user.sub },
        where: {
          templateId_version: { templateId: tpl.id, version: request.params.version },
        },
      });
      return {
        data: {
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          generatedBy: version.generatedBy,
          id: version.id,
          reviewedAt: version.reviewedAt,
          reviewedBy: version.reviewedBy,
          spec: version.spec,
          version: version.version,
        },
      };
    }
  );

  // ── Create a new version ──
  app.post(
    '/:id/versions',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: CreateVersionBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }

      let parsed: unknown;
      try {
        parsed = parseSpecOrThrow(request.body.spec);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        return reply
          .status(e.statusCode ?? 400)
          .send({ error: { code: 'INVALID_SPEC', message: e.message } });
      }

      const parsedSpec = parsed as WorkflowSpec;
      const shellNodes = collectShellNodes(parsedSpec);
      const [rbac, imgGate] = await Promise.all([
        assertShellAuthoringAllowed(fastify, user, tpl.teamId, shellNodes),
        assertShellImagesAllowed(fastify, tpl.teamId, shellNodes),
      ]);
      if (rbac) {
        return reply.status(rbac.statusCode).send(rbac.body);
      }
      if (!imgGate.ok) {
        return reply.status(imgGate.statusCode).send(imgGate.body);
      }
      const { egressAllowlist } = imgGate;

      const created = await createTemplateVersion(fastify.prisma, {
        authorUserId: user.sub,
        egressAllowlist,
        shellNodes,
        specJson: parsed as object,
        teamId: tpl.teamId,
        templateId: tpl.id,
      });
      if (!created) {
        return reply.status(409).send({
          error: { code: 'VERSION_CONFLICT', message: 'Concurrent version writes — please retry' },
        });
      }
      const warnings = [
        ...(await validateSpecRefs(fastify.prisma, parsed as WorkflowSpec)),
        ...specValidationWarnings(parsed as WorkflowSpec),
      ];
      return reply.status(201).send({
        data: {
          createdAt: created.createdAt,
          createdBy: created.createdBy,
          generatedBy: created.generatedBy,
          id: created.id,
          reviewedAt: created.reviewedAt,
          reviewedBy: created.reviewedBy,
          spec: created.spec,
          version: created.version,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }
  );

  // ── Promote a version to active ──
  app.post(
    '/:id/promote',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { body: PromoteBody, params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const version = await fastify.prisma.workflowTemplateVersion.findUnique({
        where: {
          templateId_version: { templateId: tpl.id, version: request.body.version },
        },
      });
      if (!version) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
      }
      if (version.generatedBy && !version.reviewedAt) {
        return reply.status(409).send({
          error: {
            code: 'REVIEW_REQUIRED',
            message:
              'This AI-generated version must be reviewed and approved before it can be promoted to active.',
          },
        });
      }
      const updated = await fastify.prisma.workflowTemplate.update({
        data: { activeVersion: request.body.version, status: 'ACTIVE' },
        include: TEMPLATE_INCLUDE,
        where: { id: tpl.id },
      });
      const lastRuns = await loadLastRuns(fastify, [updated.id]);
      return { data: projectTemplate(updated, lastRuns.get(updated.id)) };
    }
  );

  // ── Run a template (generic trigger) ──
  // POST /:id/runs
  // Creates a RunInput + starts a Temporal workflow for any template with an
  // active version. The request body is the generic payload validated against
  // the template's declared inputSchema (if any). Non-SWE templates that don't
  // need a connectionId may omit it; externalTicketId is auto-generated.
  const RunTemplateBody = z.object({
    label: z.string().max(200).optional(),
    payload: z.record(z.string(), z.unknown()).optional().default({}),
  });

  app.post(
    '/:id/runs',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: RunTemplateBody,
        headers: IdempotencyHeaderSchema,
        params: TemplateIdParam,
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: {
          activeVersion: true,
          id: true,
          inputSchema: true,
          team: {
            select: {
              id: true,
              organization: { select: { id: true, monthlyBudgetUsdCents: true } },
            },
          },
          teamId: true,
          workspaceProvider: true,
        },
        where: { id: request.params.id, status: 'ACTIVE', ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found or not active' },
        });
      }
      if (!tpl.activeVersion) {
        return reply.status(400).send({
          error: {
            code: 'NO_ACTIVE_VERSION',
            message: 'Template has no active version — promote a version first',
          },
        });
      }

      const payload = request.body.payload ?? {};

      if (tpl.inputSchema && isInputSchema(tpl.inputSchema)) {
        const result = validateInputPayload(tpl.inputSchema, payload);
        if (!result.ok) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_INPUT',
              details: result.errors,
              message: `Run input does not satisfy the template's input schema: ${result.errors.join('; ')}`,
            },
          });
        }
      }

      // Extract well-known fields from the generic payload so they map onto the
      // RepoWorkRequest struct that Temporal expects. Non-SWE templates that omit
      // these fields get sensible defaults; the worker reads the full payload from
      // RunInput.payload for anything beyond the base fields.
      const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : null;
      const description =
        typeof payload.description === 'string' ? payload.description : (request.body.label ?? '');
      const workRequestId = crypto.randomUUID();
      const budgetTier = (
        ['STANDARD', 'LARGE', 'EPIC'].includes(payload.budget as string)
          ? (payload.budget as BudgetTier)
          : 'STANDARD'
      ) satisfies BudgetTier;
      // Correlation key, not a ticket. A timestamp fallback used to make this
      // unique but useless — two runs a millisecond apart were indistinguishable
      // in the run list and nothing linked the key back to the run it named.
      // The work-request id is already unique and already the thing you would
      // look up.
      const externalTicketId =
        typeof payload.ticketId === 'string'
          ? payload.ticketId
          : (request.body.label ?? workRequestId);

      // Validate the workspace provider / connection pairing when the template
      // declares one. A non-api_only provider needs a connection of the matching
      // type; api_only may omit it.
      const providerMeta =
        tpl.workspaceProvider && isWorkspaceProviderType(tpl.workspaceProvider)
          ? getWorkspaceProviderMetadata(tpl.workspaceProvider)
          : null;

      // Validate the connection and provider pairing, then resolve the org for
      // the budget gate. Authenticated callers are allowed any connection they
      // have team access to; public/webhook callers are scoped to the template's
      // team because there is no authenticated user.
      const connectionResult = await validateRunConnection(
        {
          connectionId,
          prisma: fastify.prisma,
          providerMeta,
          templateTeamId: tpl.teamId,
          user,
        },
        reply
      );
      if (!connectionResult.ok) {
        return;
      }
      const budgetOrgId = connectionResult.budgetOrgId ?? tpl.team?.organization?.id;
      const budgetCap = connectionResult.budgetCap ?? tpl.team?.organization?.monthlyBudgetUsdCents;

      if (budgetOrgId && !(await assertOrgBudget(fastify.prisma, budgetOrgId, budgetCap, reply))) {
        return;
      }

      const shortTplId = tpl.id.replace(/-/g, '').slice(0, 8);
      // With an Idempotency-Key the ID is a pure function of the key, so the
      // unique index on ActiveWorkflow.temporalWorkflowId becomes a real dedup
      // gate. Without one, every request is a distinct run (previous behaviour).
      const idempotencyKey = request.headers['idempotency-key'];
      const temporalWorkflowId = idempotencyKey
        ? workflowIdFromIdempotencyKey('wf', shortTplId, idempotencyKey)
        : `wf-${shortTplId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

      const repoWorkRequest: RepoWorkRequest = {
        budgetTier,
        connectionId,
        description,
        externalTicketId,
        payload,
        repoId: connectionId,
        requestPayload: JSON.stringify(request.body),
        workRequestId,
        workspaceProvider: tpl.workspaceProvider as WorkspaceProviderType | null,
      };

      // Ledger rows first, workflow second, rolled back if the start fails —
      // see `launchTrackedWorkflow`.
      const launch = await launchTrackedWorkflow(
        fastify.prisma,
        {
          activeWorkflow: {
            budgetTier,
            currentStatus: 'IMPLEMENTING',
            repoId: connectionId ?? null,
            temporalWorkflowId,
            workRequestId,
          },
          runInput: {
            connectionId,
            description,
            externalTicketId,
            id: workRequestId,
            payload: payload as object,
            requestedById: user.sub,
            requestPayload: JSON.stringify(request.body),
            templateId: tpl.id,
            templateVersion: tpl.activeVersion,
          },
        },
        () =>
          fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
            request: repoWorkRequest,
            templateId: tpl.id,
            templateVersion: tpl.activeVersion as number,
          }),
        { log: fastify.log }
      );
      if (!launch.ok) {
        return reply.status(409).send({
          error: { code: 'RUN_CONFLICT', message: 'A run with this workflow ID already exists' },
        });
      }

      return reply.status(201).send({
        data: { temporalWorkflowId, workflowId: launch.activeWorkflowId, workRequestId },
      });
    }
  );

  // ── Paginated runs for a template ──
  app.get(
    '/:id/runs',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: RunListPaginationQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const { limit, offset } = request.query;
      const [rows, total] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          include: {
            workRequest: {
              select: { description: true, externalTicketId: true, id: true },
            },
          },
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit,
          where: { templateId: tpl.id, ...runVisibilityFilter(user) },
        }),
        fastify.prisma.workflowRun.count({
          where: { templateId: tpl.id, ...runVisibilityFilter(user) },
        }),
      ]);
      return {
        data: rows.map(projectRunSummary),
        meta: { limit, offset, total },
      };
    }
  );

  // ── Webhook: generate a new token ──
  // POST /:id/webhook/regenerate — LEAD+, generates a new random webhook token.
  app.post(
    '/:id/webhook/regenerate',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' } });
      }
      const token = crypto.randomUUID();
      await fastify.prisma.workflowTemplate.update({
        data: { webhookToken: token },
        where: { id: existing.id },
      });
      return reply.status(200).send({ data: { webhookToken: token } });
    }
  );

  // ── Webhook: revoke token ──
  // DELETE /:id/webhook — LEAD+, removes the webhook token.
  app.delete(
    '/:id/webhook',
    {
      onRequest: requireAuth({ requiredRole: 'LEAD' }),
      schema: { params: TemplateIdParam },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const existing = await fastify.prisma.workflowTemplate.findFirst({
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' } });
      }
      await fastify.prisma.workflowTemplate.update({
        data: { webhookToken: null },
        where: { id: existing.id },
      });
      return reply.status(204).send();
    }
  );

  // ── Spec diff between two versions ──
  // GET /:id/diff?a=<version>&b=<version>
  // Returns the structural diff between two versions of the same template,
  // so the editor can paint added/removed/changed nodes in the DAG.
  const DiffQuery = z.object({
    a: z.coerce.number().int().min(1),
    b: z.coerce.number().int().min(1),
  });
  app.get(
    '/:id/diff',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: DiffQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const [verA, verB] = await Promise.all([
        fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: tpl.id, version: request.query.a } },
        }),
        fastify.prisma.workflowTemplateVersion.findUnique({
          where: { templateId_version: { templateId: tpl.id, version: request.query.b } },
        }),
      ]);
      if (!verA || !verB) {
        return reply.status(404).send({
          error: { code: 'VERSION_NOT_FOUND', message: 'One or both versions not found' },
        });
      }
      // `spec` is stored as parsed JSON; cast at the boundary. Both rows were
      // validated against WorkflowSpecSchema when they landed, so the cast is safe.
      const specA = verA.spec as unknown as WorkflowSpec;
      const specB = verB.spec as unknown as WorkflowSpec;
      const diff = diffSpecs(specA, specB);
      return {
        data: {
          a: { spec: specA, version: verA.version },
          b: { spec: specB, version: verB.version },
          diff,
        },
      };
    }
  );

  // ── Analytics for a template ──
  // GET /:id/analytics?window=<days>
  // Aggregates from workflow_runs + workflow_steps. Cost data is joined via
  // workRequest → activeWorkflow (cost accrues on the Temporal workflow, not
  // the per-run record).
  const AnalyticsQuery = z.object({
    window: z.coerce.number().int().min(1).max(365).default(30),
  });
  app.get(
    '/:id/analytics',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TemplateIdParam, querystring: AnalyticsQuery },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tpl = await fastify.prisma.workflowTemplate.findFirst({
        select: { id: true },
        where: { id: request.params.id, ...teamMembershipFilter(user) },
      });
      if (!tpl) {
        return reply.status(404).send({
          error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
        });
      }
      const windowStart = new Date(Date.now() - request.query.window * 24 * 60 * 60 * 1000);
      // Hard cap on rows pulled into memory. Templates with high run volume
      // would otherwise OOM the gateway on a 90d window. At the cap the rollup
      // becomes an approximation of the most recent N runs/steps in the window.
      const ANALYTICS_ROW_CAP = 10_000;

      const [runs, steps] = await Promise.all([
        fastify.prisma.workflowRun.findMany({
          orderBy: { startedAt: 'desc' },
          select: {
            costUsdAccrued: true,
            endedAt: true,
            estimatedHumanTimeSaved: true,
            hadHumanStep: true,
            outcomeType: true,
            startedAt: true,
            status: true,
            templateVersion: true,
            wasAutonomous: true,
            // Kept for back-compat with rows that pre-date the phase-8
            // denormalization write (analytics.ts falls back to summing this
            // when costUsdAccrued is zero). Cheap because RUNNING runs are
            // bounded.
            workRequest: {
              select: {
                activeWorkflows: { select: { costUsdAccrued: true } },
              },
            },
          },
          take: ANALYTICS_ROW_CAP,
          where: { startedAt: { gte: windowStart }, templateId: tpl.id },
        }),
        fastify.prisma.workflowStep.findMany({
          orderBy: { startedAt: 'desc' },
          select: { nodeId: true, status: true },
          take: ANALYTICS_ROW_CAP,
          where: { run: { startedAt: { gte: windowStart }, templateId: tpl.id } },
        }),
      ]);

      return { data: computeAnalytics(runs, steps, request.query.window) };
    }
  );
};
