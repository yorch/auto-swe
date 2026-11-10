/**
 * What a reviewer does from a pull request's review page beyond reading it: keep draft line
 * comments, and later send a review. Every route here acts as the caller alone and on a pull
 * request in a repository they can reach; one they cannot is a 404, as on the read routes.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import type { UsableCredential } from '@auto-swe/shared/lib/connectionCredential';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditLog } from '../lib/auditLog.js';
import { COMMIT_SHA, type PullFilesResult, readPullFiles } from '../lib/githubPullFiles.js';
import { findSentReview } from '../lib/githubReviewRead.js';
import {
  postIssueComment,
  postReview,
  WRITE_FAILURE_MESSAGES,
  type WriteFailure,
} from '../lib/githubReviewWrite.js';
import { sendError } from '../lib/httpErrors.js';
import { draftIsCurrent } from '../lib/pullRequestCockpit.js';
import { resolveReviewerWrite, type WriteUnavailable } from '../lib/reviewerCredential.js';
import { REVIEW_TEXT_MESSAGES, reviewTextProblem } from '../lib/reviewText.js';
import { reachableConnections } from '../lib/tenantScope.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** Drafts one person may hold on one pull request. */
export const MAX_DRAFTS_PER_PULL_REQUEST = 100;

const PullParams = z.object({ id: z.string().uuid() });
const DraftParams = PullParams.extend({ draftId: z.string().uuid() });

const NewDraftBody = z
  .object({
    body: z.string(),
    headSha: z.string().regex(COMMIT_SHA),
    /** The last line of the comment; for a range, the line it ends on. */
    line: z.number().int().min(1).max(10_000_000),
    patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
    // Short enough for an index key, as a viewed mark's path is.
    path: z.string().min(1).max(500),
    /** RIGHT is the file's new side; LEFT is its old side, where a deleted line is. */
    side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
    /** The first line of a multi-line comment, on the same side as `line`. */
    startLine: z.number().int().min(1).max(10_000_000).optional(),
  })
  .refine((d) => d.startLine === undefined || d.startLine < d.line, {
    message: 'startLine must be before line',
    path: ['startLine'],
  });

const EditDraftBody = z.object({ body: z.string() });

const ReviewBody = z.object({
  body: z.string().optional(),
  draftIds: z.array(z.string().uuid()).max(MAX_DRAFTS_PER_PULL_REQUEST),
  event: z.enum(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']),
  /** The head the page showed; a review is sent only while the host still has it. */
  headSha: z.string().regex(COMMIT_SHA),
});

/**
 * How old the time a send was attempted may be. The page's clock supplies it, so a value in the
 * future is a fast clock and is clamped to the server's now, never refused.
 */
const ATTEMPT_MAX_AGE_MS = 60 * 60 * 1000;

/** The submit body, plus when the page sent it: that bounds where the host can have stamped it. */
const ReviewCheckBody = ReviewBody.extend({ attemptedAt: z.iso.datetime() });

/** Said whenever a check finds nothing: the host's list is evidence, and absence proves nothing. */
const NOT_FOUND_MESSAGE =
  'That review could not be found on the host yet. This does not prove it was not sent, so check the pull request on the host before sending it again.';

const SendBackBody = z.object({
  headSha: z.string().regex(COMMIT_SHA),
  /** What the agent should know, read from the line after the command. */
  note: z.string().optional(),
});

/**
 * The comment that sends a pull request back: the command on a line of its own, then the note. The
 * feedback loop reads everything after the command as the note, so it is what the agent is told.
 */
export const sendBackText = (note: string): string =>
  note === '' ? '/auto-swe fix' : `/auto-swe fix\n\n${note}`;

/** What to tell a reviewer who cannot write as themselves, by why. */
const NO_CREDENTIAL_MESSAGES: Record<WriteUnavailable, string> = {
  disabled:
    'Sending reviews from here is off: saved GitHub tokens are not enabled on this platform.',
  'no-token':
    'Save a GitHub token for this repository on the Connections page to send reviews from here.',
  unreadable:
    'Your saved GitHub token for this repository can no longer be decrypted. Save it again on the Connections page.',
  unusable:
    'Your saved GitHub token for this repository cannot be used now, because the repository moved or you are no longer on its team. Save it again on the Connections page.',
};

/** A host's refusal is not this API's: it is a 502 whose code says which. */
const HOST_ERROR_CODES: Record<WriteFailure, string> = {
  forbidden: 'HOST_FORBIDDEN',
  'not-found': 'HOST_NOT_FOUND',
  'rate-limited': 'HOST_RATE_LIMITED',
  rejected: 'HOST_REJECTED',
  unknown: 'OUTCOME_UNKNOWN',
};

type DraftRow = {
  body: string;
  createdAt: Date;
  headSha: string;
  id: string;
  line: number;
  path: string;
  side: string;
  startLine: number | null;
};

/** What a send refuses before it looks at a draft or the host; a check applies the same rules. */
function sendPreconditionError(
  reply: FastifyReply,
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES',
  text: string,
  draftCount: number
) {
  const problem = text === '' ? null : reviewTextProblem(text);
  if (problem) {
    return sendError(reply, 400, 'REVIEW_TEXT_REFUSED', REVIEW_TEXT_MESSAGES[problem], {
      problem,
    });
  }
  if (event === 'REQUEST_CHANGES' && text === '') {
    return sendError(
      reply,
      400,
      'REVIEW_BODY_REQUIRED',
      'Say what needs to change when you request changes.'
    );
  }
  if (event === 'COMMENT' && text === '' && draftCount === 0) {
    return sendError(reply, 400, 'NOTHING_TO_SEND', 'Write a comment or add a line comment.');
  }
  return null;
}

const sideOf = (side: string): 'LEFT' | 'RIGHT' => (side === 'LEFT' ? 'LEFT' : 'RIGHT');

const draftOf = (row: DraftRow) => ({
  body: row.body,
  createdAt: row.createdAt.toISOString(),
  headSha: row.headSha,
  id: row.id,
  line: row.line,
  path: row.path,
  side: sideOf(row.side),
  startLine: row.startLine,
});

export const pullRequestReviewRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const engineerOnly = requireAuth({ requiredRole: 'ENGINEER' });

  /** The pull request and where it lives, when the caller may see its repository. */
  const reachablePull = (request: FastifyRequest, id: string) => {
    const user = requireUser(request);
    return fastify.prisma.pullRequest.findFirst({
      select: {
        id: true,
        prNumber: true,
        repository: {
          select: {
            githubApiUrl: true,
            githubUrl: true,
            id: true,
            installation: { select: { host: true, installationId: true } },
            organizationName: true,
            repoName: true,
            scmProvider: true,
            team: { select: { orgId: true } },
            teamId: true,
          },
        },
      },
      where: {
        id,
        ...(user.role === 'ADMIN'
          ? {}
          : { repository: reachableConnections(user, request.repoAccessGate) }),
      },
    });
  };

  /** The pull request with where it lives on the host, or null when it has no such place. */
  const locate = (pull: Awaited<ReturnType<typeof reachablePull>>) => {
    const repository = pull?.repository;
    if (
      !pull ||
      !repository ||
      pull.prNumber === null ||
      repository.organizationName === null ||
      repository.repoName === null
    ) {
      return null;
    }
    return {
      id: pull.id,
      organizationName: repository.organizationName,
      prNumber: pull.prNumber,
      repoName: repository.repoName,
      repository,
    };
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
          side: request.body.side,
          startLine: request.body.startLine ?? null,
        },
      });
      return reply.code(201).send({ data: draftOf(row) });
    }
  );

  /**
   * What every write to the host needs first, in this order so the cheapest refusals come first:
   * the caller's own saved token (never the platform's), a live read of the pull request, that it
   * is still open, and that the head is the one the page showed. A failure is the answer to send.
   */
  const readyToWrite = async (args: {
    headSha: string;
    prNumber: number;
    repository: NonNullable<Awaited<ReturnType<typeof reachablePull>>>['repository'] & object;
    userId: string;
  }): Promise<
    | { credential: UsableCredential; live: Extract<PullFilesResult, { type: 'ok' }>; ok: true }
    | { code: string; details?: unknown; message: string; ok: false; status: number }
  > => {
    const write = await resolveReviewerWrite(fastify.prisma, {
      connectionId: args.repository.id,
      userId: args.userId,
    });
    if (!write.available) {
      return {
        code: 'NO_USER_CREDENTIAL',
        details: { reason: write.reason },
        message: NO_CREDENTIAL_MESSAGES[write.reason],
        ok: false,
        status: 409,
      };
    }
    const live = await readPullFiles(args.repository, args.prNumber);
    if (live.type !== 'ok') {
      return {
        code: 'FILES_UNAVAILABLE',
        details: { reason: live.reason },
        message: 'The pull request could not be read from the host, so nothing was sent.',
        ok: false,
        status: 409,
      };
    }
    if (live.state !== 'open') {
      return {
        code: 'PULL_REQUEST_NOT_OPEN',
        message: `This pull request is ${live.state} on the host, so nothing was sent.`,
        ok: false,
        status: 409,
      };
    }
    if (live.headSha.toLowerCase() !== args.headSha.toLowerCase()) {
      return {
        code: 'STALE_HEAD',
        details: { currentHeadSha: live.headSha },
        message:
          'The pull request has new commits since you opened the page. Reload it and look again before you send.',
        ok: false,
        status: 409,
      };
    }
    return { credential: write.credential, live, ok: true };
  };

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

  // POST /api/v1/pull-requests/:id/review — send a review, with the caller's chosen drafts as its
  // line comments, from the caller's own saved token. Never from the platform's credential: when the
  // caller has none, nothing is sent. The page must be showing the head the host has now, and every
  // draft must still sit on a line of the patch it was written against; otherwise nothing is sent
  // and the answer says which. It sends once and never retries (see githubReviewWrite).
  app.post(
    '/:id/review',
    { onRequest: engineerOnly, schema: { body: ReviewBody, params: PullParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = locate(await reachablePull(request, request.params.id));
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const { prNumber, repository } = pull;
      const { event, headSha } = request.body;
      const text = (request.body.body ?? '').trim();
      const draftIds = [...new Set(request.body.draftIds)];
      const refused = sendPreconditionError(reply, event, text, draftIds.length);
      if (refused) {
        return refused;
      }
      const drafts =
        draftIds.length === 0
          ? []
          : await fastify.prisma.prReviewDraft.findMany({
              orderBy: [{ path: 'asc' }, { line: 'asc' }, { id: 'asc' }],
              select: {
                body: true,
                id: true,
                line: true,
                patchDigest: true,
                path: true,
                side: true,
                startLine: true,
              },
              where: { id: { in: draftIds }, pullRequestId: pull.id, userId: user.sub },
            });
      if (drafts.length !== draftIds.length) {
        return sendError(
          reply,
          409,
          'DRAFTS_CHANGED',
          'Some of those draft comments no longer exist. Reload the page.'
        );
      }

      const ready = await readyToWrite({
        headSha,
        prNumber,
        repository,
        userId: user.sub,
      });
      if (!ready.ok) {
        return sendError(reply, ready.status, ready.code, ready.message, ready.details);
      }
      const { credential: write, live } = ready;
      const byPath = new Map(live.files.map((f) => [f.path, f]));
      const outdated = drafts.filter((d) => !draftIsCurrent(d, byPath)).map((d) => d.id);
      if (outdated.length > 0) {
        return sendError(
          reply,
          409,
          'DRAFTS_OUTDATED',
          'Some draft comments are on lines that have changed, so nothing was sent.',
          { draftIds: outdated }
        );
      }

      const result = await postReview(
        { apiUrl: write.apiUrl, token: write.token },
        { organizationName: pull.organizationName, repoName: pull.repoName },
        prNumber,
        {
          body: text,
          comments: drafts.map((d) => ({
            body: d.body,
            line: d.line,
            path: d.path,
            side: sideOf(d.side),
            startLine: d.startLine,
          })),
          commitId: live.headSha,
          event,
        }
      );
      if (result.type === 'failed') {
        return sendError(
          reply,
          502,
          HOST_ERROR_CODES[result.reason],
          WRITE_FAILURE_MESSAGES[result.reason],
          { reason: result.reason }
        );
      }

      // The review is on the host now. If recording that fails, the answer must still say so: an
      // error here would invite a second review. What is left behind is named instead.
      let draftsKept = false;
      try {
        await fastify.prisma.$transaction(async (tx) => {
          await tx.prReviewDraft.deleteMany({
            where: { id: { in: draftIds }, pullRequestId: pull.id, userId: user.sub },
          });
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: {
              comments: drafts.length,
              event,
              githubReviewId: result.id,
              hasBody: text !== '',
              headSha: live.headSha,
              kind: 'review',
              prNumber,
              repositoryId: repository.id,
            },
            client: tx,
            entityId: pull.id,
            entityType: 'PullRequestReview',
          });
        });
      } catch (err) {
        draftsKept = true;
        request.log.error({ err }, 'review sent, but recording it failed');
      }
      return {
        data: { comments: drafts.length, draftsKept, event, reviewId: result.id, url: result.url },
      };
    }
  );

  // POST /api/v1/pull-requests/:id/review/check — after a send whose outcome is unknown, ask
  // whether that review is on the host. Read-only against the host, as the caller with their own
  // saved token, and it needs neither an open pull request nor the head the page now shows: the
  // review was sent against `headSha`. A match clears the drafts that review carried and writes the
  // same audit row a send writes, marked `confirmed`. No match changes nothing and says it proves
  // nothing; the drafts stay.
  app.post(
    '/:id/review/check',
    { onRequest: engineerOnly, schema: { body: ReviewCheckBody, params: PullParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = locate(await reachablePull(request, request.params.id));
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const { prNumber, repository } = pull;
      const { event, headSha } = request.body;
      const now = Date.now();
      const claimedAt = new Date(request.body.attemptedAt);
      if (now - claimedAt.getTime() > ATTEMPT_MAX_AGE_MS) {
        return sendError(
          reply,
          400,
          'ATTEMPT_TIME_INVALID',
          'That send was too long ago to be looked for.'
        );
      }
      const attemptedAt = new Date(Math.min(claimedAt.getTime(), now));
      const text = (request.body.body ?? '').trim();
      const draftIds = [...new Set(request.body.draftIds)];
      const refused = sendPreconditionError(reply, event, text, draftIds.length);
      if (refused) {
        return refused;
      }
      const drafts =
        draftIds.length === 0
          ? []
          : await fastify.prisma.prReviewDraft.findMany({
              select: { body: true, id: true, line: true, path: true, side: true, startLine: true },
              where: { id: { in: draftIds }, pullRequestId: pull.id, userId: user.sub },
            });
      if (drafts.length !== draftIds.length) {
        return sendError(
          reply,
          409,
          'DRAFTS_CHANGED',
          'Some of those draft comments no longer exist. Reload the page.'
        );
      }
      const write = await resolveReviewerWrite(fastify.prisma, {
        connectionId: repository.id,
        userId: user.sub,
      });
      if (!write.available) {
        return sendError(reply, 409, 'NO_USER_CREDENTIAL', NO_CREDENTIAL_MESSAGES[write.reason], {
          reason: write.reason,
        });
      }

      const result = await findSentReview(
        { apiUrl: write.credential.apiUrl, token: write.credential.token },
        { organizationName: pull.organizationName, repoName: pull.repoName },
        prNumber,
        {
          attemptedAt,
          body: text,
          comments: drafts.map((d) => ({
            body: d.body,
            line: d.line,
            path: d.path,
            side: sideOf(d.side),
            startLine: d.startLine,
          })),
          event,
          headSha,
        }
      );
      if (result.type === 'failed') {
        return sendError(
          reply,
          502,
          HOST_ERROR_CODES[result.reason],
          WRITE_FAILURE_MESSAGES[result.reason],
          { reason: result.reason }
        );
      }
      if (result.type === 'not-found') {
        return { data: { message: NOT_FOUND_MESSAGE, status: 'not-found' } };
      }

      // As in a send: the review is on the host, so a failure to record it must not read as one.
      let draftsKept = false;
      try {
        await fastify.prisma.$transaction(async (tx) => {
          // CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock. Two
          // checks of one pull request would both miss the audit row below and both write it.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pr-review-check|${pull.id}`}, 0))`;
          await tx.prReviewDraft.deleteMany({
            where: { id: { in: draftIds }, pullRequestId: pull.id, userId: user.sub },
          });
          // A review already recorded, by a send or by an earlier check, is not recorded again:
          // otherwise any review of the caller's own could be re-confirmed into the log at will.
          const recorded = await tx.configAuditLog.findFirst({
            select: { id: true },
            where: {
              afterJson: { equals: result.id, path: ['githubReviewId'] },
              entityId: pull.id,
              entityType: 'PullRequestReview',
            },
          });
          if (recorded) {
            return;
          }
          await writeAuditLog(fastify, {
            action: 'CREATE',
            actor: user,
            after: {
              comments: drafts.length,
              confirmed: true,
              event,
              githubReviewId: result.id,
              hasBody: text !== '',
              headSha,
              kind: 'review',
              prNumber,
              repositoryId: repository.id,
            },
            client: tx,
            entityId: pull.id,
            entityType: 'PullRequestReview',
          });
        });
      } catch (err) {
        draftsKept = true;
        request.log.error({ err }, 'review found on the host, but recording it failed');
      }
      return {
        data: {
          comments: drafts.length,
          confirmed: true,
          draftsKept,
          event,
          reviewId: result.id,
          status: 'found',
          url: result.url,
        },
      };
    }
  );

  // POST /api/v1/pull-requests/:id/send-back — ask the agent to address the review so far, by
  // leaving `/auto-swe fix` on the pull request as the caller. That is exactly what a person typing
  // it on the host does, so the webhook path decides the rest with its own checks: the caller's
  // linked account and write permission, the round limit and the kill switch. Nothing is started
  // from here, and this refuses while the feedback automations are off, since the comment would
  // then sit on the pull request doing nothing. Same rules as a review: the caller's own token, an
  // open pull request, the head the page showed, one send and no retry.
  app.post(
    '/:id/send-back',
    { onRequest: engineerOnly, schema: { body: SendBackBody, params: PullParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const pull = locate(await reachablePull(request, request.params.id));
      if (!pull) {
        return sendError(reply, 404, 'PULL_REQUEST_NOT_FOUND', 'Pull request not found');
      }
      const { prNumber, repository } = pull;
      const note = (request.body.note ?? '').trim();
      const problem = note === '' ? null : reviewTextProblem(note);
      if (problem) {
        return sendError(reply, 400, 'REVIEW_TEXT_REFUSED', REVIEW_TEXT_MESSAGES[problem], {
          problem,
        });
      }
      const loopOn = await resolveSetting('github.prFeedbackAutomationsEnabled', {
        ...(repository.team?.orgId ? { orgId: repository.team.orgId } : {}),
        teamId: repository.teamId,
      });
      if (!loopOn) {
        return sendError(
          reply,
          409,
          'FEEDBACK_LOOP_OFF',
          'Pull-request feedback automations are off for this repository, so sending it back would start nothing.'
        );
      }
      const ready = await readyToWrite({
        headSha: request.body.headSha,
        prNumber,
        repository,
        userId: user.sub,
      });
      if (!ready.ok) {
        return sendError(reply, ready.status, ready.code, ready.message, ready.details);
      }
      const result = await postIssueComment(
        { apiUrl: ready.credential.apiUrl, token: ready.credential.token },
        { organizationName: pull.organizationName, repoName: pull.repoName },
        prNumber,
        sendBackText(note)
      );
      if (result.type === 'failed') {
        return sendError(
          reply,
          502,
          HOST_ERROR_CODES[result.reason],
          WRITE_FAILURE_MESSAGES[result.reason],
          { reason: result.reason }
        );
      }
      try {
        await writeAuditLog(fastify, {
          action: 'CREATE',
          actor: user,
          after: {
            githubCommentId: result.id,
            hasNote: note !== '',
            headSha: ready.live.headSha,
            kind: 'send-back',
            prNumber,
            repositoryId: repository.id,
          },
          entityId: pull.id,
          entityType: 'PullRequestReview',
        });
      } catch (err) {
        request.log.error({ err }, 'sent back, but recording it failed');
      }
      return { data: { commentId: result.id, url: result.url } };
    }
  );
};
