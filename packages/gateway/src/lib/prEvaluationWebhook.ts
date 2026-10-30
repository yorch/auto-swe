import type { PrismaClient } from '@auto-swe/shared';
import { resolveSettings } from '@auto-swe/shared/config';
import { findPlatformPullRequest } from '@auto-swe/shared/lib/prEvaluationPlatformPr';
import type { PrEvaluationInput } from '@auto-swe/shared/lib/prEvaluationWorkflow';
import { prEvaluationWorkflowId } from '@auto-swe/shared/lib/prEvaluationWorkflow';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  claimsHostWithOwnSecret,
  deliveryHostMatches,
  webhookRepositoryWhere,
} from './repositoryHost.js';

/**
 * Pull-request evaluation, driven by the GitHub webhook: start an evaluation when a pull
 * request or review changes, and record how an evaluated pull request ended. Every step here
 * is a side effect of a delivery the existing handlers also process, so nothing in this file
 * may throw into them: `handlePrEvaluationDelivery` logs a failure and returns.
 */

const START_PR_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
  'edited',
]);
const START_REVIEW_ACTIONS = new Set(['submitted', 'dismissed', 'edited']);

/** How long after a merge a revert of it still marks the merge bad. */
export const BAD_MERGE_WINDOW_DAYS = 14;

const PayloadSchema = z.object({
  action: z.string(),
  changes: z.object({ base: z.unknown().optional() }).passthrough().optional(),
  pull_request: z.object({
    body: z.string().nullish(),
    closed_at: z.string().nullish(),
    head: z.object({ sha: z.string() }).optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullish(),
    number: z.number().int().positive(),
    title: z.string().nullish(),
  }),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

const REVERT_BODY = /^Reverts\s+([\w.-]+)\/([\w.-]+)#(\d+)/im;
const PR_REFERENCE = /\(#(\d+)\)/g;

/**
 * The pull request a merged revert undoes, from GitHub's default revert text: the body's
 * `Reverts owner/repo#N`, else a `Revert ...` title that names `(#N)`. A heuristic: a revert
 * written by hand in other words is not seen. A title names no repository, so it is taken to
 * mean the pull request's own. The title's first reference is used because a squash merge
 * appends the revert's own number last (`Revert "Fix x (#12)" (#15)`).
 */
export function revertedPullRequest(
  pr: { body?: string | null; number: number; title?: string | null },
  repo: { owner: string; name: string }
): number | null {
  const sameRepo = (owner: string, name: string) =>
    owner.toLowerCase() === repo.owner.toLowerCase() &&
    name.toLowerCase() === repo.name.toLowerCase();
  const fromBody = REVERT_BODY.exec(pr.body ?? '');
  if (fromBody) {
    const target = Number(fromBody[3]);
    return sameRepo(fromBody[1], fromBody[2]) &&
      Number.isSafeInteger(target) &&
      target !== pr.number
      ? target
      : null;
  }
  const title = pr.title ?? '';
  if (/^Revert\b/i.test(title)) {
    for (const match of title.matchAll(PR_REFERENCE)) {
      const target = Number(match[1]);
      if (Number.isSafeInteger(target) && target !== pr.number) {
        return target;
      }
    }
  }
  return null;
}

type Delivery = z.infer<typeof PayloadSchema>;

function shouldStart(eventType: string, payload: Delivery): boolean {
  if (eventType === 'pull_request_review') {
    return START_REVIEW_ACTIONS.has(payload.action);
  }
  if (!START_PR_ACTIONS.has(payload.action)) {
    return false;
  }
  // An edit starts an evaluation only when it moved the base branch.
  return payload.action !== 'edited' || payload.changes?.base !== undefined;
}

/**
 * The pull request's merge or close, on the one evaluation row of the head that was merged.
 * Returns whether a row was stamped as merged.
 */
async function recordClosed(
  prisma: PrismaClient,
  connectionId: string,
  payload: Delivery
): Promise<boolean> {
  const pr = payload.pull_request;
  const headSha = pr.head?.sha;
  if (!headSha) {
    return false;
  }
  // Exactly one row: the auto-merge evidence gate counts rows, so marking every evaluation of
  // a pull request would count one merge once per push. A head no row evaluated is not guessed.
  const row = await prisma.prEvaluation.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    where: { connectionId, headSha, prNumber: pr.number },
  });
  if (!row) {
    return false;
  }
  const at = (iso: string | null | undefined): Date => {
    const parsed = iso ? new Date(iso) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  };
  const closedAt = at(pr.closed_at ?? pr.merged_at);
  await prisma.prEvaluation.update({
    data: pr.merged ? { closedAt, mergedAt: at(pr.merged_at) } : { closedAt },
    where: { id: row.id },
  });
  return pr.merged === true;
}

async function markRevertedMerge(
  prisma: PrismaClient,
  connection: { id: string; organizationName: string | null; repoName: string | null },
  payload: Delivery,
  now: Date
): Promise<void> {
  const pr = payload.pull_request;
  const target = revertedPullRequest(
    { body: pr.body, number: pr.number, title: pr.title },
    { name: connection.repoName ?? '', owner: connection.organizationName ?? '' }
  );
  if (target === null) {
    return;
  }
  const since = new Date(now.getTime() - BAD_MERGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  await prisma.prEvaluation.updateMany({
    data: { badMerge: true, badMergeReason: `revert PR #${pr.number} merged` },
    where: { connectionId: connection.id, mergedAt: { gte: since }, prNumber: target },
  });
}

/**
 * Act on one verified `pull_request` / `pull_request_review` delivery for pull-request
 * evaluation. Never throws: a failure is logged and the delivery's other handlers carry on.
 */
export async function handlePrEvaluationDelivery(
  fastify: FastifyInstance,
  input: {
    body: unknown;
    deliveryId: string;
    eventType: string;
    log: FastifyBaseLogger;
    verifiedHost: string | null;
  }
): Promise<void> {
  const { body, deliveryId, eventType, log, verifiedHost } = input;
  try {
    if (eventType !== 'pull_request' && eventType !== 'pull_request_review') {
      return;
    }
    const parsed = PayloadSchema.safeParse(body);
    if (!parsed.success) {
      return;
    }
    const payload = parsed.data;
    const closing = eventType === 'pull_request' && payload.action === 'closed';
    if (!closing && !shouldStart(eventType, payload)) {
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
          select: {
            id: true,
            isActive: true,
            organizationName: true,
            prEvaluationMode: true,
            repoName: true,
            team: { select: { orgId: true } },
            teamId: true,
          },
          where: { ...repositoryWhere, type: 'git_repo' },
        })
    );
    for (const connection of connections) {
      // One repository's failure must not stop the next.
      try {
        if (closing) {
          const stamped = await recordClosed(prisma, connection.id, payload);
          if (payload.pull_request.merged) {
            await markRevertedMerge(prisma, connection, payload, new Date());
          }
          if (stamped) {
            // The approval fact on the row predates the merge: have the worker recount it at
            // the merged head (a dismissal followed by a bypass-merge starts no evaluation).
            await fastify.temporal.startPrEvaluationWorkflow(
              prEvaluationWorkflowId(connection.id, payload.pull_request.number, deliveryId),
              {
                connectionId: connection.id,
                prNumber: payload.pull_request.number,
                trigger: 'merged',
              }
            );
          }
          continue;
        }
        // The cheap pre-filter only: two database reads, so a pull request the platform did not
        // open (nearly every one in a busy repository) starts no workflow. The activity decides
        // the rest. The lookup is the activity's own (`findPlatformPullRequest`).
        const platformPr = await findPlatformPullRequest(
          prisma,
          connection.id,
          payload.pull_request.number
        );
        if (!platformPr?.workflow) {
          continue;
        }
        const settings = await resolveSettings(
          ['prEvaluation.enabled', 'prEvaluation.defaultMode'],
          {
            ...(connection.team?.orgId ? { orgId: connection.team.orgId } : {}),
            teamId: connection.teamId ?? undefined,
          }
        );
        const mode = connection.prEvaluationMode ?? settings['prEvaluation.defaultMode'];
        if (!connection.isActive || !settings['prEvaluation.enabled'] || mode === 'off') {
          // Switched off (or deactivated) is not the same as nothing to do: an auto-merge the platform armed
          // earlier must still be disarmed, and only the activity can do it.
          const armed = await prisma.prEvaluation.findFirst({
            select: { id: true },
            where: {
              autoMergeEnabled: true,
              closedAt: null,
              connectionId: connection.id,
              mergedAt: null,
              prNumber: payload.pull_request.number,
            },
          });
          // Or an approval of the approver App still stands: it is withdrawn the same way.
          const botApproved = armed
            ? null
            : await prisma.prEvaluation.findFirst({
                select: { id: true },
                where: {
                  botApproved: true,
                  closedAt: null,
                  connectionId: connection.id,
                  mergedAt: null,
                  prNumber: payload.pull_request.number,
                },
              });
          if (!armed && !botApproved) {
            continue;
          }
        }
        const workflowInput: PrEvaluationInput = {
          connectionId: connection.id,
          prNumber: payload.pull_request.number,
          trigger: `${eventType}.${payload.action}`,
        };
        await fastify.temporal.startPrEvaluationWorkflow(
          prEvaluationWorkflowId(connection.id, payload.pull_request.number, deliveryId),
          workflowInput
        );
      } catch (err) {
        log.error(
          { connectionId: connection.id, err, eventType, prNumber: payload.pull_request.number },
          'pull request evaluation step failed (non-fatal)'
        );
      }
    }
  } catch (err) {
    log.error({ err, eventType }, 'pull request evaluation webhook handling failed (non-fatal)');
  }
}
