import { createHash } from 'node:crypto';
import {
  ReviewPresetAttachmentSchema,
  ReviewPresetCreateSchema,
  ReviewPresetUpdateSchema,
  reviewWorkflowId,
} from '@auto-swe/shared/lib/codeReview';
import {
  prepareReviewLaunch,
  ReviewLaunchError,
  reviewRunId,
} from '@auto-swe/shared/lib/reviewLaunch';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { sendError } from '../lib/httpErrors.js';
import { IdempotencyHeaderSchema } from '../lib/idempotency.js';
import { assertMcpWriteAllowed } from '../lib/mcpWriteGuard.js';
import { asPlatformAdmin } from '../lib/platformAdminScope.js';
import {
  isCheckConstraintError,
  isRecordNotFoundError,
  isUniqueConstraintError,
} from '../lib/prismaErrors.js';
import { queueReviewFixRetry } from '../lib/reviewFixRetry.js';
import { validateRunConnection } from '../lib/runConnection.js';
import { buildWorkflowRunControlFilter } from '../lib/runVisibility.js';
import { teamMembershipFilter } from '../lib/templateLaunch.js';
import { launchTrackedWorkflow } from '../lib/workflowLaunch.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

const Id = z.object({ id: z.string().uuid() });
const Choice = z.union([
  z.strictObject({ presetId: z.string().uuid() }),
  z.strictObject({ templateId: z.string().uuid() }),
]);
const Attachment = z
  .strictObject({
    connectionId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
  })
  .refine((b) => !!b.connectionId !== !!b.templateId, 'Choose a source template or repository');

function writeRefusal(reply: FastifyReply, err: unknown) {
  if (isUniqueConstraintError(err)) {
    return sendError(reply, 409, 'REVIEW_CONFLICT', 'This name or attachment already exists');
  }
  if (isRecordNotFoundError(err)) {
    return sendError(reply, 404, 'REVIEW_PRESET_NOT_FOUND', 'Review preset not found');
  }
  if (isCheckConstraintError(err) || (err as { code?: string })?.code === 'P2003') {
    return sendError(
      reply,
      409,
      'REVIEW_INVALID_REFERENCE',
      'The referenced template or repository is unavailable or not review-kind'
    );
  }
  throw err;
}

export const codeReviewRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineer = requireAuth({ requiredRole: 'ENGINEER' });
  const admin = requireAuth({ requiredRole: 'ADMIN' });

  app.post(
    '/workflow-runs/:id/reviews/fix-retry',
    { onRequest: engineer, schema: { params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const mcp = await assertMcpWriteAllowed(request, reply, {
        submit: { budgetTier: 'STANDARD', idempotencyKey: undefined },
        tool: 'start_template_run',
      });
      if (mcp.refused) {
        return mcp.refused;
      }
      const run = await fastify.prisma.workflowRun.findFirst({
        include: { workRequest: { select: { connectionId: true } } },
        where: {
          id: request.params.id,
          ...buildWorkflowRunControlFilter(user, request.repoAccessGate),
        },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      const access = await validateRunConnection(
        {
          connectionId: run.connectionId ?? run.workRequest?.connectionId ?? '',
          gate: request.repoAccessGate,
          log: request.log,
          prisma: fastify.prisma,
          providerMeta: null,
          templateTeamId: null,
          user,
        },
        reply
      );
      if (!access.ok) {
        return;
      }
      try {
        return reply.status(202).send({ data: await queueReviewFixRetry(fastify, user, run.id) });
      } catch (error) {
        if (error instanceof ReviewLaunchError) {
          return sendError(reply, error.status, error.code, error.message);
        }
        throw error;
      }
    }
  );

  app.post(
    '/workflow-runs/:id/reviews',
    { onRequest: engineer, schema: { body: Choice, headers: IdempotencyHeaderSchema, params: Id } },
    async (request, reply) => {
      const user = requireUser(request);
      const body = request.body;
      const key = request.headers['idempotency-key'];
      const mcp = await assertMcpWriteAllowed(request, reply, {
        submit: { budgetTier: 'STANDARD', idempotencyKey: key },
        tool: 'start_template_run',
      });
      if (mcp.refused) {
        return mcp.refused;
      }
      const source = await fastify.prisma.workflowRun.findFirst({
        include: { workRequest: { select: { connectionId: true } } },
        where: {
          id: request.params.id,
          ...buildWorkflowRunControlFilter(user, request.repoAccessGate),
        },
      });
      if (!source) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      const repoId =
        source.connectionId ??
        source.workRequest?.connectionId ??
        (
          await fastify.prisma.activeWorkflow.findUnique({
            select: { repoId: true },
            where: { temporalWorkflowId: source.workflowId },
          })
        )?.repoId;
      if (!repoId) {
        return sendError(reply, 409, 'REVIEW_NOTHING_TO_REVIEW', 'Source run has no repository');
      }
      const access = await validateRunConnection(
        {
          connectionId: repoId,
          gate: request.repoAccessGate,
          log: request.log,
          prisma: fastify.prisma,
          providerMeta: null,
          templateTeamId: null,
          user,
        },
        reply
      );
      if (!access.ok) {
        return;
      }
      const nonceHex = key
        ? createHash('sha256')
            .update(JSON.stringify([source.id, user.sub, key]))
            .digest('hex')
            .slice(0, 8)
        : undefined;
      const expectedPayload = JSON.stringify({ sourceRunId: source.id, ...body });
      const replay = async (workflowId: string) => {
        const previous = await fastify.prisma.activeWorkflow.findUnique({
          include: { workRequest: true },
          where: { temporalWorkflowId: workflowId },
        });
        if (!previous) {
          return false;
        }
        const saved = previous.workRequest;
        let stored: Record<string, unknown> | null = null;
        try {
          stored = JSON.parse(saved?.requestPayload ?? 'null');
        } catch {
          stored = null;
        }
        if (
          saved?.requestedById !== user.sub ||
          stored?.sourceRunId !== source.id ||
          stored?.presetId !== ('presetId' in body ? body.presetId : undefined) ||
          stored?.templateId !== ('templateId' in body ? body.templateId : undefined)
        ) {
          sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key already names a different review request'
          );
          return true;
        }
        reply.status(201).send({ data: { runId: reviewRunId(workflowId), workflowId } });
        return true;
      };
      if (nonceHex) {
        const previous = await replay(reviewWorkflowId(repoId, nonceHex));
        if (previous) {
          return reply;
        }
      }
      try {
        const prepared = await prepareReviewLaunch(fastify.prisma, {
          ...body,
          launchedById: user.sub,
          nonceHex,
          sourceRunId: source.id,
        });
        const allowed = await asPlatformAdmin(
          user,
          'review launch checks its selected template',
          ['WorkflowTemplate'],
          () =>
            fastify.prisma.workflowTemplate.findFirst({
              select: { id: true },
              where: { id: prepared.template.id, ...teamMembershipFilter(user) },
            })
        );
        if (!allowed) {
          return sendError(reply, 404, 'REVIEW_TEMPLATE_NOT_FOUND', 'Review template not found');
        }
        const result = await launchTrackedWorkflow(
          fastify.prisma,
          {
            activeWorkflow: prepared.activeWorkflow,
            ...(access.source ? { knowledgeSourceRepo: access.source } : {}),
            runInput: { ...prepared.runInput, requestPayload: expectedPayload },
          },
          () =>
            fastify.temporal.startRunnableWorkflow(prepared.workflowId, {
              request: prepared.request,
              templateId: prepared.template.id,
              templateVersion: prepared.templateVersion,
            }),
          {
            audit: { actor: user, source: 'code-review', templateId: prepared.template.id },
            guard: mcp.launchGuard,
            log: fastify.log,
            sourceAuthorization: { actor: user },
          }
        );
        if (!result.ok) {
          if (result.reason === 'DUPLICATE') {
            if (await replay(prepared.workflowId)) {
              return reply;
            }
            return sendError(reply, 409, 'REVIEW_CONFLICT', 'Review already started');
          }
          return sendError(reply, 403, 'REVIEW_LAUNCH_REFUSED', 'Review launch was refused');
        }
        return reply
          .status(201)
          .send({ data: { runId: prepared.runId, workflowId: prepared.workflowId } });
      } catch (err) {
        if (err instanceof ReviewLaunchError) {
          return sendError(reply, err.status, err.code, err.message);
        }
        throw err;
      }
    }
  );

  app.get('/review-presets', { onRequest: engineer }, async (request) => {
    const user = requireUser(request);
    const templates = await asPlatformAdmin(
      user,
      'review picker lists launchable review templates',
      ['WorkflowTemplate'],
      () =>
        fastify.prisma.workflowTemplate.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
          where: {
            activeVersion: { not: null },
            kind: 'review',
            status: 'ACTIVE',
            ...teamMembershipFilter(user),
          },
        })
    );
    const presets = await fastify.prisma.reviewPreset.findMany({
      orderBy: { name: 'asc' },
      select: {
        description: true,
        id: true,
        name: true,
        template: { select: { id: true, name: true } },
      },
      where: { enabled: true, templateId: { in: templates.map((t) => t.id) } },
    });
    return { data: presets, templates };
  });

  app.get('/platform/review-presets', { onRequest: admin }, async () => ({
    data: await fastify.prisma.reviewPreset.findMany({
      include: { attachments: true, template: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    }),
  }));
  app.get(
    '/platform/review-presets/:id',
    { onRequest: admin, schema: { params: Id } },
    async (request, reply) => {
      const row = await fastify.prisma.reviewPreset.findUnique({
        include: { attachments: true },
        where: { id: request.params.id },
      });
      return row
        ? { data: row }
        : sendError(reply, 404, 'REVIEW_PRESET_NOT_FOUND', 'Review preset not found');
    }
  );
  app.post(
    '/platform/review-presets',
    { onRequest: admin, schema: { body: ReviewPresetCreateSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const template = await fastify.prisma.workflowTemplate.findUnique({
        where: { id: request.body.templateId },
      });
      if (template?.kind !== 'review') {
        return sendError(
          reply,
          409,
          'REVIEW_TEMPLATE_INVALID',
          'Presets require a review-kind template'
        );
      }
      try {
        const row = await fastify.prisma.reviewPreset.create({
          data: { ...request.body, createdById: user.sub },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: row,
          entityId: row.id,
          entityType: 'ReviewPreset',
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        return writeRefusal(reply, err);
      }
    }
  );
  app.patch(
    '/platform/review-presets/:id',
    { onRequest: admin, schema: { body: ReviewPresetUpdateSchema, params: Id } },
    async (request, reply) => {
      const before = await fastify.prisma.reviewPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!before) {
        return sendError(reply, 404, 'REVIEW_PRESET_NOT_FOUND', 'Review preset not found');
      }
      if (
        request.body.templateId &&
        (
          await fastify.prisma.workflowTemplate.findUnique({
            where: { id: request.body.templateId },
          })
        )?.kind !== 'review'
      ) {
        return sendError(
          reply,
          409,
          'REVIEW_TEMPLATE_INVALID',
          'Presets require a review-kind template'
        );
      }
      try {
        const row = await fastify.prisma.reviewPreset.update({
          data: request.body,
          where: { id: before.id },
        });
        await writeAuditLog(fastify, {
          action: 'UPDATE',
          actor: requireUser(request),
          after: row,
          before,
          entityId: row.id,
          entityType: 'ReviewPreset',
        });
        return { data: row };
      } catch (err) {
        return writeRefusal(reply, err);
      }
    }
  );
  app.delete(
    '/platform/review-presets/:id',
    { onRequest: admin, schema: { params: Id } },
    async (request, reply) => {
      const before = await fastify.prisma.reviewPreset.findUnique({
        where: { id: request.params.id },
      });
      if (!before) {
        return sendError(reply, 404, 'REVIEW_PRESET_NOT_FOUND', 'Review preset not found');
      }
      try {
        await fastify.prisma.reviewPreset.delete({ where: { id: before.id } });
        await writeAuditLog(fastify, {
          action: 'DELETE',
          actor: requireUser(request),
          before,
          entityId: before.id,
          entityType: 'ReviewPreset',
        });
        return { data: { deleted: true } };
      } catch (err) {
        return writeRefusal(reply, err);
      }
    }
  );
  app.post(
    '/platform/review-presets/:id/attachments',
    { onRequest: admin, schema: { body: Attachment, params: Id } },
    async (request, reply) => {
      try {
        const data = ReviewPresetAttachmentSchema.parse({
          ...request.body,
          presetId: request.params.id,
        });
        const row = await fastify.prisma.reviewPresetAttachment.create({
          data: { ...data, createdById: requireUser(request).sub },
        });
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: requireUser(request),
          after: row,
          entityId: row.id,
          entityType: 'ReviewPresetAttachment',
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        return writeRefusal(reply, err);
      }
    }
  );
  app.delete(
    '/platform/review-presets/:id/attachments',
    { onRequest: admin, schema: { body: Attachment, params: Id } },
    async (request, reply) => {
      const before = await fastify.prisma.reviewPresetAttachment.findFirst({
        where: { ...request.body, presetId: request.params.id },
      });
      if (!before) {
        return sendError(reply, 404, 'REVIEW_ATTACHMENT_NOT_FOUND', 'Attachment not found');
      }
      await fastify.prisma.reviewPresetAttachment.delete({ where: { id: before.id } });
      await writeAuditLog(fastify, {
        action: 'DELETE',
        actor: requireUser(request),
        before,
        entityId: before.id,
        entityType: 'ReviewPresetAttachment',
      });
      return { data: { deleted: true } };
    }
  );
};
