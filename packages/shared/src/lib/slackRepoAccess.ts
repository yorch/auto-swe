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
 * The three Slack-specific ones have no equivalent in {@link RepoAccessRefusal},
 * and each says a different thing could not be established: who this is, what
 * the policy is, and what repository was being asked about. All three are
 * distinct from every reason that describes a user we successfully identified.
 */
export type SlackAccessRefusal =
  | RepoAccessRefusal
  | 'no-linked-account'
  | 'gate-unreadable'
  | 'repo-unreadable';

export type SlackRepoAccessVerdict =
  | { allowed: true }
  | { allowed: false; reason: SlackAccessRefusal };

const ALLOWED: SlackRepoAccessVerdict = { allowed: true };

/**
 * May the Slack user behind `slackId` cause work to run against `connectionId`?
 *
 * **Off means off, and advisory means advisory.** With `repoAccess.mode` off
 * this allows without a query, which keeps the long-standing behaviour that
 * talking to the assistant needs no linked account. Under `advisory` the two
 * conditions this path did not apply before the gate existed are logged and
 * allowed rather than refused — see {@link ADVISORY_SOFTENED} for which, and for
 * why the answer differs from the gateway's.
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
    return softenUnderAdvisory('no-linked-account', connectionId, gate, slackId, log);
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
  // Fail closed. There is no access to grant to a repository that could not be
  // read, and answering "allowed" would assert something nothing checked —
  // the same reasoning `decideRepoLaunch` states as "an unanswered question is
  // not a yes". Both callers read the row moments earlier, so in practice this
  // is a delete racing the decision rather than an ordinary not-found.
  if (!repo) {
    return { allowed: false, reason: 'repo-unreadable' };
  }

  const decision = await decideRepoAccess(
    prisma,
    { role: user.role, sub: user.id },
    repo,
    gate,
    log
  );
  if (decision.allowed) {
    return ALLOWED;
  }
  return softenUnderAdvisory(decision.reason, connectionId, gate, slackId, log);
}

/**
 * Reasons that advisory mode logs instead of enforcing, and why only these.
 *
 * Advisory promises to report what enforcement *would* refuse without refusing
 * it. The test for whether a reason belongs here is not what kind of condition
 * it is — it is whether this path applied it before the gate existed. On these
 * two Slack paths the answer for both of these is no:
 *
 * - `no-linked-account` is the GitHub gate's own identity requirement, and is
 *   the largest population an operator turns advisory on to measure.
 * - `not-a-team-member` is membership — which every *gateway* route checked
 *   long before the gate, but which these paths never did. The channel task
 *   resolves its repository from the CHANNEL's team binding and never consulted
 *   the asker's membership; the steer checked nothing at all. Both conditions
 *   arrived together, so both have to observe together, or advisory refuses
 *   someone for a rule that did not exist when the operator set the dial.
 *
 * Everything else stays a refusal in every mode. `installation-retired` already
 * stopped channel code tasks at the run's first activity, so it is not new here.
 * `repo-unreadable` is an integrity failure rather than a policy one. And
 * `gate-unreadable` cannot reach this function at all, because the mode is
 * precisely what could not be read.
 */
const ADVISORY_SOFTENED: ReadonlySet<SlackAccessRefusal> = new Set([
  'no-linked-account',
  'not-a-team-member',
]);

function softenUnderAdvisory(
  reason: SlackAccessRefusal,
  connectionId: string,
  gate: RepoAccessGate,
  slackId: string | undefined,
  log?: AccessLog
): SlackRepoAccessVerdict {
  if (gate.mode !== 'advisory' || !ADVISORY_SOFTENED.has(reason)) {
    return { allowed: false, reason };
  }
  log?.warn(
    { connectionId, reason, slackId },
    'repo access (advisory): would refuse this Slack request'
  );
  return ALLOWED;
}
