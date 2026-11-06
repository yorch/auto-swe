/**
 * What a reviewer does from a pull request's review page beyond reading it: keep draft line
 * comments, and later send a review. Every route here acts as the caller alone and on a pull
 * request in a repository they can reach; one they cannot is a 404, as on the read routes.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { COMMIT_SHA } from '../lib/githubPullFiles.js';
import { sendError } from '../lib/httpErrors.js';
import { REVIEW_TEXT_MESSAGES, reviewTextProblem } from '../lib/reviewText.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** Drafts one person may hold on one pull request. */
export const MAX_DRAFTS_PER_PULL_REQUEST = 100;

const PullParams = z.object({ id: z.string().uuid() });
const DraftParams = PullParams.extend({ draftId: z.string().uuid() });

const NewDraftBody = z.object({
  body: z.string(),
  headSha: z.string().regex(COMMIT_SHA),
  line: z.number().int().min(1).max(10_000_000),
  patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
  // Short enough for an index key, as a viewed mark's path is.
  path: z.string().min(1).max(500),
});

const EditDraftBody = z.object({ body: z.string() });

type DraftRow = {
  body: string;
  createdAt: Date;
  headSha: string;
  id: string;
  line: number;
  path: string;
};

const draftOf = (row: DraftRow) => ({
  body: row.body,
  createdAt: row.createdAt.toISOString(),
  headSha: row.headSha,
  id: row.id,
  line: row.line,
  path: row.path,
});

export const pullRequestReviewRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineerOnly = requireAuth({ requiredRole: 'ENGINEER' });

  /** The pull request, when the caller may see its repository. */
  const reachablePull = (request: FastifyRequest, id: string) => {
    const user = requireUser(request);
    return fastify.prisma.pullRequest.findFirst({
      select: { id: true },
      where: {
        id,
        ...(user.role === 'ADMIN'
          ? {}
          : { repository: reachableConnections(user, request.repoAccessGate) }),
      },
    });
  };

  // POST /api/v1/pull-requests/:id/drafts — keep a line comment for the caller until they send a
  // review. Nothing leaves the platform here, and whether the line is still in the diff is decided
  // when a review is sent, against the host's patch then.
  app.post(
    '/:id/drafts',
    { onRequest: engineerOnly, schema: { body: NewDraftBody, params: PullParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = await reachablePull(request, request.params.id);
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const problem = reviewTextProblem(request.body.body);
      if (problem) {
        return sendError(reply, 400, 'REVIEW_TEXT_REFUSED', REVIEW_TEXT_MESSAGES[problem], {
          problem,
        });
      }
      const mine = { pullRequestId: pull.id, userId: user.sub };
      if (
        (await fastify.prisma.prReviewDraft.count({ where: mine })) >= MAX_DRAFTS_PER_PULL_REQUEST
      ) {
        return sendError(
          reply,
          400,
          'TOO_MANY_DRAFTS',
          `At most ${MAX_DRAFTS_PER_PULL_REQUEST} draft comments can be kept on one pull request`
        );
      }
      const row = await fastify.prisma.prReviewDraft.create({
        data: {
          ...mine,
          body: request.body.body,
          headSha: request.body.headSha,
          line: request.body.line,
          patchDigest: request.body.patchDigest,
          path: request.body.path,
        },
      });
      return reply.code(201).send({ data: draftOf(row) });
    }
  );

  // PATCH /api/v1/pull-requests/:id/drafts/:draftId — change the text of one of the caller's drafts.
  app.patch(
    '/:id/drafts/:draftId',
    { onRequest: engineerOnly, schema: { body: EditDraftBody, params: DraftParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = await reachablePull(request, request.params.id);
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const problem = reviewTextProblem(request.body.body);
      if (problem) {
        return sendError(reply, 400, 'REVIEW_TEXT_REFUSED', REVIEW_TEXT_MESSAGES[problem], {
          problem,
        });
      }
      const mine = { id: request.params.draftId, pullRequestId: pull.id, userId: user.sub };
      const changed = await fastify.prisma.prReviewDraft.updateMany({
        data: { body: request.body.body },
        where: mine,
      });
      if (changed.count === 0) {
        return sendError(reply, 404, 'DRAFT_NOT_FOUND', 'Draft not found');
      }
      const row = await fastify.prisma.prReviewDraft.findFirst({ where: mine });
      return row
        ? { data: draftOf(row) }
        : sendError(reply, 404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }
  );

  // DELETE /api/v1/pull-requests/:id/drafts/:draftId — discard one of the caller's drafts.
  app.delete(
    '/:id/drafts/:draftId',
    { onRequest: engineerOnly, schema: { params: DraftParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = await reachablePull(request, request.params.id);
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const removed = await fastify.prisma.prReviewDraft.deleteMany({
        where: { id: request.params.draftId, pullRequestId: pull.id, userId: user.sub },
      });
      return removed.count === 0
        ? sendError(reply, 404, 'DRAFT_NOT_FOUND', 'Draft not found')
        : { data: { deleted: true } };
    }
  );
};
