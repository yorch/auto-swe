import crypto from 'node:crypto';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { generateBranchName, generateWorkflowId } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getErrorName, requireAuth, requireUser } from '../plugins/auth.js';

/**
 * Deterministic 0–99 bucket for an A/B key. Uses sha1 mod 100 so the same
 * `externalTicketId` always lands in the same bucket — re-runs of the same
 * ticket cannot accidentally cross the experiment boundary.
 *
 * Salting by `templateId` keeps two templates' experiments statistically
 * independent: a ticket bucketed into the experiment arm on template A is
 * uncorrelated with its bucket on template B.
 */
export function experimentBucket(externalTicketId: string, templateId: string): number {
  const hash = crypto.createHash('sha1').update(`${templateId}:${externalTicketId}`).digest();
  // First 4 bytes is plenty of entropy for a mod-100 bucket.
  return hash.readUInt32BE(0) % 100;
}

/**
 * Resolve the active workflow template for a team, falling back to the
 * global default (teamId IS NULL). Returns {templateId, version} or null
 * if nothing is configured.
 *
 * Honors per-template A/B experiment configuration: if `experimentSplit` is
 * set and the bucketed externalTicketId lands below the split, returns
 * `experimentVersion` instead of `activeVersion`. Falls back silently to
 * `activeVersion` when either experiment field is missing.
 *
 * Uniqueness is enforced at the DB layer via partial unique indexes on
 * (team_id WHERE is_default), so `findFirst` returns at most one row in
 * a well-formed database. The explicit `orderBy` is a deterministic
 * tiebreaker if the index is dropped or someone bypasses Prisma.
 */
// Exported for unit tests; the route handler is the only production caller.
export async function resolveDefaultTemplate(
  prisma: FastifyInstance['prisma'],
  teamId: string,
  externalTicketId?: string
): Promise<{ templateId: string; version: number; isExperiment: boolean } | null> {
  const teamTpl = await prisma.workflowTemplate.findFirst({
    orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
    where: { isDefault: true, status: 'ACTIVE', teamId },
  });
  const tpl =
    teamTpl ??
    (await prisma.workflowTemplate.findFirst({
      orderBy: [{ activeVersion: 'desc' }, { updatedAt: 'desc' }],
      where: { isDefault: true, status: 'ACTIVE', teamId: null },
    }));
  if (!tpl?.activeVersion) {
    return null;
  }

  const split = tpl.experimentSplit ?? 0;
  const expVersion = tpl.experimentVersion ?? null;
  if (split > 0 && expVersion !== null && externalTicketId) {
    const bucket = experimentBucket(externalTicketId, tpl.id);
    if (bucket < split) {
      return { isExperiment: true, templateId: tpl.id, version: expVersion };
    }
  }
  return { isExperiment: false, templateId: tpl.id, version: tpl.activeVersion };
}

const CreateWorkRequestSchema = z.object({
  budgetTier: z.enum(['STANDARD', 'LARGE', 'EPIC']).optional().default('STANDARD'),
  description: z.string().min(1, 'description is required — tell the agent what to implement'),
  externalTicketId: z.string().min(1),
  repoIds: z.array(z.string().uuid()).min(1).max(1), // MVP: single repo only
});

export const workRequestRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        body: CreateWorkRequestSchema,
      },
    },
    async (request, reply) => {
      const { externalTicketId, description, repoIds, budgetTier } = request.body;
      const user = requireUser(request);

      // Verify repository exists and is accessible to the requesting user.
      // Include team membership so non-admins can only trigger work on their
      // own team's repos without a second round-trip query.
      const repo = await fastify.prisma.repository.findUnique({
        include: {
          team: {
            select: {
              memberships: {
                select: { userId: true },
                where: { userId: user.sub },
              },
            },
          },
        },
        where: { id: repoIds[0] },
      });
      if (!repo?.isActive) {
        return reply.status(404).send({
          error: {
            code: 'REPO_NOT_FOUND',
            message: `Repository ${repoIds[0]} not found or inactive`,
          },
        });
      }

      if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You do not have access to this repository' },
        });
      }

      // Generate deterministic workflow ID (includes org to prevent cross-org collisions)
      const temporalWorkflowId = generateWorkflowId(
        externalTicketId,
        repo.organizationName,
        repo.repoName
      );
      const { branchPrefix } = await resolveWorkflowDefaults();
      const branch = generateBranchName(externalTicketId, branchPrefix);

      // Generate the work request ID upfront so it can be passed to Temporal
      // before the DB row exists. This avoids the ordering problem where
      // the workflow needs the ID but the DB write happens after workflow start.
      const workRequestId = crypto.randomUUID();

      // Resolve which workflow template to run. Team-scoped default wins; falls
      // back to the global teamId=null template seeded by `yarn db:seed`.
      // A/B experiments are honored via deterministic bucketing on externalTicketId.
      const resolvedTemplate = await resolveDefaultTemplate(
        fastify.prisma,
        repo.teamId,
        externalTicketId
      );
      if (!resolvedTemplate) {
        return reply.status(500).send({
          error: {
            code: 'NO_DEFAULT_TEMPLATE',
            message: 'No default workflow template configured. Run `yarn db:seed`.',
          },
        });
      }

      // Start Temporal workflow FIRST — this is the idempotency gate.
      // If the workflow already exists, Temporal returns WorkflowExecutionAlreadyStartedError
      // and we haven't written any orphan DB rows yet.
      const repoWorkRequest: RepoWorkRequest = {
        budgetTier,
        description,
        externalTicketId,
        repoId: repo.id,
        requestPayload: JSON.stringify(request.body),
        workRequestId,
      };
      try {
        await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
          request: repoWorkRequest,
          templateId: resolvedTemplate.templateId,
          templateVersion: resolvedTemplate.version,
        });
      } catch (err: unknown) {
        if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
          return reply.status(409).send({
            error: {
              code: 'WORKFLOW_ALREADY_EXISTS',
              message: `Workflow already running for ${externalTicketId}`,
            },
          });
        }
        throw err;
      }

      // Workflow started — now persist to DB.
      // If DB write fails, the Temporal workflow will eventually time out,
      // which is preferable to orphan DB rows that block future retries.
      const workRequest = await fastify.prisma.workRequest.create({
        data: {
          description,
          externalTicketId,
          id: workRequestId,
          requestPayload: JSON.stringify(request.body),
          templateId: resolvedTemplate.templateId,
          templateVersion: resolvedTemplate.version,
        },
      });

      const activeWorkflow = await fastify.prisma.activeWorkflow.create({
        data: {
          assignedBranch: branch,
          budgetTier,
          currentStatus: 'IMPLEMENTING',
          repoId: repo.id,
          temporalWorkflowId,
          workRequestId: workRequest.id,
        },
      });

      return reply.status(201).send({
        data: {
          workflowIds: [activeWorkflow.id],
          workRequestId: workRequest.id,
        },
      });
    }
  );
};
