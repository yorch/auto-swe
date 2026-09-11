/**
 * One decision for "may this Slack user act on this repository".
 *
 * Slack is the one surface where the person acting is identified by a workspace
 * user id rather than by an authenticated platform session, so every Slack path
 * that can cause work to run needs the same two steps: resolve the `U…` id to a
 * platform user, then take the ordinary repository decision. Two paths need it
 * — the channel assistant's code task (worker) and the thread steer (gateway) —
 * and they run in different processes against different loggers, which is
 * exactly the shape that ends up with two half-matching copies.
 *
 * The refusal is returned as a reason, never as prose. The two callers say
 * different things about the same verdict — the task route explains what to
 * link, the steer route says nothing at all and lets the reply fall through —
 * so the wording belongs at the call site and the decision does not.
 */

import type { PrismaClient } from '../index.js';
import type { AccessLog } from './accessActor.js';
import { decideRepoAccess, type RepoAccessRefusal } from './repoAccessDecision.js';
import { type RepoAccessGate, resolveRepoAccessGateOrLastKnown } from './repoAccessGate.js';

/**
 * Why a Slack user was refused.
 *
 * `no-linked-account` and `gate-unreadable` are Slack-specific and have no
 * equivalent in {@link RepoAccessRefusal}: the first is "we cannot tell who this
 * is", the second "we cannot tell what the policy is". Both are distinct from
 * every reason that describes a user we successfully identified.
 */
export type SlackAccessRefusal = RepoAccessRefusal | 'no-linked-account' | 'gate-unreadable';

export type SlackRepoAccessVerdict =
  | { allowed: true }
  | { allowed: false; reason: SlackAccessRefusal };

const ALLOWED: SlackRepoAccessVerdict = { allowed: true };

/**
 * May the Slack user behind `slackId` cause work to run against `connectionId`?
 *
 * **Off means off.** With `repoAccess.mode` off this allows without a query,
 * which keeps the long-standing behaviour that talking to the assistant needs no
 * linked account. The gate is the operator's statement that it should.
 *
 * A gate that has never been readable refuses. The gateway treats the same
 * value as `off` because it decorates every authenticated request and a process
 * that cannot read its config has nothing to enforce yet — but here the read
 * failure is the only thing standing between an unidentified Slack user and a
 * push, and "we could not check" must not read as "there was nothing to check".
 * In practice a store that cannot answer this also cannot create the run a
 * moment later, so the cost of refusing is a clear message instead of a crash.
 */
export async function decideSlackRepoAccess(
  prisma: PrismaClient,
  slackId: string | undefined,
  connectionId: string,
  log?: AccessLog
): Promise<SlackRepoAccessVerdict> {
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    return { allowed: false, reason: 'gate-unreadable' };
  }
  return decideSlackRepoAccessWithGate(prisma, slackId, connectionId, gate, log);
}

/** As {@link decideSlackRepoAccess}, for a caller that already holds the gate. */
export async function decideSlackRepoAccessWithGate(
  prisma: PrismaClient,
  slackId: string | undefined,
  connectionId: string,
  gate: RepoAccessGate,
  log?: AccessLog
): Promise<SlackRepoAccessVerdict> {
  if (gate.mode === 'off') {
    return ALLOWED;
  }

  // `isActive` here and nowhere else would be half a check: whoever resolves
  // this id for attribution has to filter the same way, or a deactivated user
  // is refused by one query and credited by the other.
  const user = slackId
    ? await prisma.user.findFirst({
        select: { id: true, role: true },
        where: { isActive: true, slackId },
      })
    : null;
  if (!user) {
    return { allowed: false, reason: 'no-linked-account' };
  }

  const repo = await prisma.connection.findUnique({
    select: {
      githubApiUrl: true,
      id: true,
      installation: { select: { installationId: true, isActive: true } },
      organizationName: true,
      repoName: true,
      team: { select: { memberships: { select: { userId: true }, where: { userId: user.id } } } },
      type: true,
    },
    where: { id: connectionId },
  });
  // No such row is not a refusal. The caller named a connection that does not
  // exist, which its own not-found handling answers better than an access
  // decision can.
  if (!repo) {
    return ALLOWED;
  }

  const decision = await decideRepoAccess(
    prisma,
    { role: user.role, sub: user.id },
    repo,
    gate,
    log
  );
  return decision.allowed ? ALLOWED : { allowed: false, reason: decision.reason };
}
