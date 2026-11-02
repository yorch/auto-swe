import { classifyCommentPath, isPlatformText } from '@auto-swe/shared/lib/prEvaluation';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  claimsHostWithOwnSecret,
  deliveryHostMatches,
  webhookRepositoryWhere,
} from './repositoryHost.js';

/**
 * Counts how people meet the reviewer brief, from the review and inline-comment deliveries the
 * feedback handlers already receive: no new subscription. A delivery changes one number on the
 * evaluation row of the head it names, and never starts an evaluation. Like the evaluation
 * handler it is a side effect of a delivery others also process, so it never throws.
 *
 * The counts are approximate by design: a delivery GitHub sends twice counts twice, and a review
 * that arrives before its head's evaluation row exists is not counted.
 */

const PayloadSchema = z.object({
  action: z.string(),
  comment: z.object({ body: z.string().nullish(), path: z.string() }).optional(),
  pull_request: z.object({
    head: z.object({ sha: z.string() }).optional(),
    number: z.number().int().positive(),
    user: z.object({ login: z.string() }).nullish(),
  }),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
  review: z.object({ body: z.string().nullish(), state: z.string() }).optional(),
  sender: z.object({ login: z.string(), type: z.string().optional() }).optional(),
});

type Delivery = z.infer<typeof PayloadSchema>;

/** A person's act: not a bot, not the pull request's author, not text the platform wrote. */
function isHumanAct(payload: Delivery): boolean {
  const sender = payload.sender;
  if (!sender || sender.type === 'Bot' || sender.login.endsWith('[bot]')) {
    return false;
  }
  if (sender.login.toLowerCase() === payload.pull_request.user?.login.toLowerCase()) {
    return false;
  }
  return !isPlatformText(payload.review?.body) && !isPlatformText(payload.comment?.body);
}

export async function handleBriefEngagementDelivery(
  fastify: FastifyInstance,
  input: {
    body: unknown;
    eventType: string;
    log: FastifyBaseLogger;
    verifiedHost: string | null;
  }
): Promise<void> {
  const { body, eventType, log, verifiedHost } = input;
  try {
    if (eventType !== 'pull_request_review' && eventType !== 'pull_request_review_comment') {
      return;
    }
    const parsed = PayloadSchema.safeParse(body);
    if (!parsed.success) {
      return;
    }
    const payload = parsed.data;
    const headSha = payload.pull_request.head?.sha;
    const isReview = eventType === 'pull_request_review';
    // A dismissed review is not one a person gave; an edited or deleted comment is not a new one.
    const counts = isReview
      ? payload.action === 'submitted' && payload.review !== undefined
      : payload.action === 'created' && payload.comment !== undefined;
    if (!headSha || !counts || !isHumanAct(payload)) {
      return;
    }
    const prisma = fastify.prisma;
    const htmlUrl = payload.repository.html_url;
    if (
      !deliveryHostMatches(verifiedHost, htmlUrl) ||
      (await claimsHostWithOwnSecret(prisma, verifiedHost, htmlUrl))
    ) {
      return;
    }
    const [org, repoName] = payload.repository.full_name.split('/');
    const repositoryWhere = await webhookRepositoryWhere(
      prisma,
      org,
      repoName,
      htmlUrl,
      verifiedHost
    );
    const connections = await runUnscoped(
      'a webhook names a GitHub repository, not a team',
      ['Connection'],
      () =>
        prisma.connection.findMany({
          select: { id: true },
          where: { ...repositoryWhere, type: 'git_repo' },
        })
    );
    for (const connection of connections) {
      try {
        const row = await prisma.prEvaluation.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { brief: true, id: true },
          where: { connectionId: connection.id, headSha, prNumber: payload.pull_request.number },
        });
        if (!row) {
          continue;
        }
        if (isReview && payload.review) {
          await prisma.prEvaluation.updateMany({
            data: { firstHumanReviewAt: new Date() },
            where: { firstHumanReviewAt: null, id: row.id },
          });
          if (payload.review.state.toLowerCase() === 'changes_requested') {
            await prisma.prEvaluation.updateMany({
              data: { changesRequestedCount: { increment: 1 } },
              where: { id: row.id },
            });
          }
        } else if (payload.comment) {
          const placement = classifyCommentPath(payload.comment.path, row.brief);
          await prisma.prEvaluation.updateMany({
            data: {
              [placement === 'flagged'
                ? 'commentsOnFlagged'
                : placement === 'skimmed'
                  ? 'commentsOnSkimmed'
                  : 'commentsElsewhere']: { increment: 1 },
            },
            where: { id: row.id },
          });
        }
      } catch (err) {
        log.error(
          { connectionId: connection.id, err, eventType },
          'brief engagement step failed (non-fatal)'
        );
      }
    }
  } catch (err) {
    log.error({ err, eventType }, 'brief engagement handling failed (non-fatal)');
  }
}
