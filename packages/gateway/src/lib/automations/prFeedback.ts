/**
 * The `github.pull_request.feedback` event source's webhook side: `pull_request_review`,
 * `pull_request_review_comment` and `issue_comment` deliveries normalized into occurrences
 * for the engine, plus the one enrichment pass the descriptor's facts cannot carry (R2 of the
 * design): who opened the pull request, and — for an `issue_comment`, which has no head — its
 * head branch. Everything that is never acted on is ignored before any query: another action,
 * a closed pull request, a bot, a fork's head.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  type PrFeedbackFacts,
  parseFeedbackCommand,
  visibleIssueText,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { resolvePlatformCredential } from '@auto-swe/shared/lib/githubHostCredential';
import { installationTargetFor } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { isSafeGitBranchName } from '@auto-swe/shared/lib/gitRef';
import { PR_FEEDBACK_QODO_TRIGGER } from '@auto-swe/shared/lib/prFeedback';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { z } from 'zod';
import { webhookRepositoryWhere } from '../repositoryHost.js';
import type { Occurrence } from './engine.js';

const SenderSchema = z.object({
  id: z.number().int().positive(),
  login: z.string(),
  type: z.string(),
});

const RepositorySchema = z.object({
  full_name: z.string(),
  html_url: z.string().optional(),
  id: z.number(),
});

/** A `pull_request` object as the review payloads carry it. */
const PullRequestSchema = z.object({
  head: z.object({
    ref: z.string(),
    repo: z.object({ id: z.number() }).nullish(),
    sha: z.string().optional(),
  }),
  number: z.number().int().positive(),
  state: z.string(),
});

const ReviewEventSchema = z.object({
  action: z.string(),
  pull_request: PullRequestSchema,
  repository: RepositorySchema,
  review: z.object({
    body: z.string().nullish(),
    html_url: z.string().optional(),
    id: z.number().int().positive(),
    state: z.string(),
    submitted_at: z.string(),
  }),
  sender: SenderSchema,
});

const ReviewCommentEventSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string().nullish(),
    created_at: z.string(),
    html_url: z.string().optional(),
    id: z.number().int().positive(),
  }),
  pull_request: PullRequestSchema,
  repository: RepositorySchema,
  sender: SenderSchema,
});

const IssueCommentEventSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string().nullish(),
    created_at: z.string(),
    html_url: z.string().optional(),
    id: z.number().int().positive(),
  }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
    state: z.string(),
  }),
  repository: RepositorySchema,
  sender: SenderSchema,
});

export type PrFeedbackEvent =
  | ({ type: 'feedback'; repositoryId: number } & Occurrence<PrFeedbackFacts>)
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

function repoParts(repository: { full_name: string }): { org: string; repoName: string } | null {
  const [org, repoName] = repository.full_name.split('/');
  return org && repoName ? { org, repoName } : null;
}

function senderFacts(sender: { id: number; login: string }) {
  return { senderId: String(sender.id), senderLogin: sender.login.slice(0, 100) };
}

const HEAD_SHA = /^[0-9a-f]{40,64}$/i;

/**
 * What a bot's review or comment becomes: a nudge for the Qodo findings trigger. It carries
 * only identifiers — a bot's text is never copied and never read for a command, so `notes` is
 * empty. Whether the bot is Qodo's, and whether the feature is on, is the enrichment's call
 * (those are settings); a delivery that is not is answered there with the same reason a bot
 * always got.
 */
function qodoNudge(args: {
  eventId: string;
  eventKind: PrFeedbackFacts['eventKind'];
  headRef?: string;
  headSha?: string;
  parts: { org: string; repoName: string };
  prNumber: number;
  repository: { full_name: string; html_url?: string; id: number };
  sender: { id: number; login: string };
  submittedAt: string;
}): PrFeedbackEvent {
  return {
    facts: {
      eventId: args.eventId,
      eventKind: args.eventKind,
      ...(args.headRef ? { headRef: args.headRef } : {}),
      ...(args.headSha ? { headSha: args.headSha.toLowerCase() } : {}),
      htmlUrl: `https://github.com/${args.repository.full_name}/pull/${args.prNumber}`,
      notes: '',
      origin: 'other',
      prNumber: args.prNumber,
      submittedAt: args.submittedAt.slice(0, 40),
      trigger: PR_FEEDBACK_QODO_TRIGGER,
      ...senderFacts(args.sender),
    },
    repositoryId: args.repository.id,
    type: 'feedback',
    ...args.parts,
    repoFullName: args.repository.full_name,
    repoHtmlUrl: args.repository.html_url,
  };
}

/** Other senders (an organization, a mannequin) are never acted on; a Bot is judged later. */
function notAPersonOrBot(sender: { type: string }): PrFeedbackEvent | null {
  return sender.type === 'User' || sender.type === 'Bot'
    ? null
    : { reason: `left by a ${sender.type}, not a person`, type: 'ignored' };
}

const NO_HEAD = {
  reason: 'the pull request names no head commit',
  type: 'ignored',
} as const;

/**
 * Pure mapping from a `pull_request_review`, `pull_request_review_comment` or
 * `issue_comment` webhook body to the feedback an automation may act on. `origin` and (for an
 * `issue_comment`) `headRef` are still unset here — the enrichment fills them.
 */
export function normalizePrFeedbackEvent(eventType: string, body: unknown): PrFeedbackEvent {
  switch (eventType) {
    case 'pull_request_review':
      return normalizeReview(body);
    case 'pull_request_review_comment':
      return normalizeReviewComment(body);
    case 'issue_comment':
      return normalizeIssueComment(body);
    default:
      return { type: 'unrecognized' };
  }
}

function normalizeReview(body: unknown): PrFeedbackEvent {
  const parsed = ReviewEventSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, pull_request: pr, repository, review, sender } = parsed.data;
  if (action !== 'submitted') {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  const other = notAPersonOrBot(sender);
  if (other) {
    return other;
  }
  if (pr.state !== 'open') {
    return { reason: 'the pull request is not open', type: 'ignored' };
  }
  // A fork's head is never pushed to. Compared by id, which a rename cannot change.
  if (!pr.head.repo || pr.head.repo.id !== repository.id) {
    return { reason: 'the pull request is from a fork', type: 'ignored' };
  }
  const parts = repoParts(repository);
  if (!parts || !isSafeGitBranchName(pr.head.ref)) {
    return { type: 'unrecognized' };
  }
  if (sender.type === 'Bot') {
    if (!pr.head.sha || !HEAD_SHA.test(pr.head.sha)) {
      return NO_HEAD;
    }
    return qodoNudge({
      eventId: String(review.id),
      eventKind: 'review',
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      parts,
      prNumber: pr.number,
      repository,
      sender,
      submittedAt: review.submitted_at,
    });
  }
  const command = parseFeedbackCommand(review.body ?? '');
  const trigger = review.state.toLowerCase() === 'changes_requested' ? 'changes_requested' : null;
  if (trigger === null && command === null) {
    return { reason: `review state ${review.state} with no command`, type: 'ignored' };
  }
  return {
    facts: {
      eventId: String(review.id),
      eventKind: 'review',
      headRef: pr.head.ref,
      htmlUrl: (
        review.html_url ?? `https://github.com/${repository.full_name}/pull/${pr.number}`
      ).slice(0, 500),
      notes: (command?.notes ?? visibleIssueText(review.body ?? '')).slice(0, 4_000),
      origin: 'other',
      prNumber: pr.number,
      submittedAt: review.submitted_at.slice(0, 40),
      trigger: trigger ?? 'command',
      ...senderFacts(sender),
    },
    repositoryId: repository.id,
    type: 'feedback',
    ...parts,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
  };
}

function normalizeReviewComment(body: unknown): PrFeedbackEvent {
  const parsed = ReviewCommentEventSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, comment, pull_request: pr, repository, sender } = parsed.data;
  if (action !== 'created') {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  const other = notAPersonOrBot(sender);
  if (other) {
    return other;
  }
  if (pr.state !== 'open') {
    return { reason: 'the pull request is not open', type: 'ignored' };
  }
  if (!pr.head.repo || pr.head.repo.id !== repository.id) {
    return { reason: 'the pull request is from a fork', type: 'ignored' };
  }
  const parts = repoParts(repository);
  if (!parts || !isSafeGitBranchName(pr.head.ref)) {
    return { type: 'unrecognized' };
  }
  if (sender.type === 'Bot') {
    if (!pr.head.sha || !HEAD_SHA.test(pr.head.sha)) {
      return NO_HEAD;
    }
    return qodoNudge({
      eventId: String(comment.id),
      eventKind: 'review_comment',
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      parts,
      prNumber: pr.number,
      repository,
      sender,
      submittedAt: comment.created_at,
    });
  }
  const command = parseFeedbackCommand(comment.body ?? '');
  if (command === null) {
    return { reason: 'no command', type: 'ignored' };
  }
  return {
    facts: {
      eventId: String(comment.id),
      eventKind: 'review_comment',
      headRef: pr.head.ref,
      htmlUrl: (
        comment.html_url ?? `https://github.com/${repository.full_name}/pull/${pr.number}`
      ).slice(0, 500),
      notes: command.notes.slice(0, 4_000),
      origin: 'other',
      prNumber: pr.number,
      submittedAt: comment.created_at.slice(0, 40),
      trigger: 'command',
      ...senderFacts(sender),
    },
    repositoryId: repository.id,
    type: 'feedback',
    ...parts,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
  };
}

function normalizeIssueComment(body: unknown): PrFeedbackEvent {
  const parsed = IssueCommentEventSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, comment, issue, repository, sender } = parsed.data;
  if (action !== 'created') {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  if (issue.pull_request === undefined) {
    return { reason: 'not on a pull request', type: 'ignored' };
  }
  const other = notAPersonOrBot(sender);
  if (other) {
    return other;
  }
  if (issue.state !== 'open') {
    return { reason: 'the pull request is not open', type: 'ignored' };
  }
  const parts = repoParts(repository);
  if (!parts) {
    return { type: 'unrecognized' };
  }
  if (sender.type === 'Bot') {
    // No head in this payload: the enrichment reads it, with the head branch, from the host.
    return qodoNudge({
      eventId: String(comment.id),
      eventKind: 'issue_comment',
      parts,
      prNumber: issue.number,
      repository,
      sender,
      submittedAt: comment.created_at,
    });
  }
  const command = parseFeedbackCommand(comment.body ?? '');
  if (command === null) {
    return { reason: 'no command', type: 'ignored' };
  }
  // An `issue_comment` delivery carries no head: the enrichment fills `headRef` from the
  // platform's own row, or one read of the pull request for one it did not open.
  return {
    facts: {
      eventId: String(comment.id),
      eventKind: 'issue_comment',
      htmlUrl: (
        comment.html_url ?? `https://github.com/${repository.full_name}/pull/${issue.number}`
      ).slice(0, 500),
      notes: command.notes.slice(0, 4_000),
      origin: 'other',
      prNumber: issue.number,
      submittedAt: comment.created_at.slice(0, 40),
      trigger: 'command',
      ...senderFacts(sender),
    },
    repositoryId: repository.id,
    type: 'feedback',
    ...parts,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
  };
}

export type EnrichedFeedback =
  | { type: 'ok'; facts: PrFeedbackFacts }
  | { type: 'ignored'; reason: string }
  /** A transient failure: the delivery should be answered 503 so it can be sent again. */
  | { type: 'failed'; reason: string };

type FeedbackConnection = {
  githubApiUrl: string | null;
  githubUrl: string | null;
  id: string;
  installation: { host: string; installationId: string } | null;
};

/**
 * Where, and with which credential, to ask the host about a pull request — the same rule the
 * check-run lookup (`routes/webhooks.ts` `checkRunTarget`) applies: the repository's own API
 * base on an approved host, and a platform credential that never leaves its own host.
 */
async function feedbackReadTarget(
  repo: FeedbackConnection,
  log?: { warn: (obj: unknown, msg: string) => void }
): Promise<{ apiUrl: string; token: string } | null> {
  const ghConfig = await resolveGitHubConfig();
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.githubApiUrl,
    githubUrl: repo.githubUrl,
  });
  if (!hosts.ok) {
    log?.warn({ url: hosts.url }, 'repository host is not approved; no credential sent');
    return null;
  }
  const scoped = {
    apiUrl: repo.githubApiUrl,
    baseUrl: repo.githubUrl,
    installationHost: repo.installation?.host ?? null,
    installationId: repo.installation?.installationId ?? null,
  };
  try {
    const credential = await resolvePlatformCredential(scoped, ghConfig);
    if (credential.scope !== 'instance' && credential.scope !== 'host') {
      return null;
    }
    const target = installationTargetFor(scoped, credential.config);
    const token = await resolveGitHubToken(credential.config, target);
    return { apiUrl: target.apiUrl, token };
  } catch (err) {
    log?.warn({ err }, 'no GitHub credential for the pull request read');
    return null;
  }
}

const PrHeadSchema = z.object({
  head: z.object({
    ref: z.string(),
    repo: z.object({ id: z.number() }).nullish(),
    sha: z.string().optional(),
  }),
  state: z.string(),
});
type PrHead = z.infer<typeof PrHeadSchema>;

/** One read of a pull request from its host, with a platform credential that stays on its host. */
async function readPullRequestHead(
  target: { apiUrl: string; token: string },
  event: { org: string; repoName: string },
  prNumber: number,
  log?: { warn: (obj: unknown, msg: string) => void }
): Promise<
  | { type: 'ok'; pr: PrHead }
  | { type: 'ignored'; reason: string }
  | { type: 'failed'; reason: string }
> {
  try {
    const res = await fetch(
      `${target.apiUrl}/repos/${event.org}/${event.repoName}/pulls/${prNumber}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${target.token}`,
          'User-Agent': 'auto-swe/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.status === 404 || res.status === 410) {
      return { reason: 'the pull request is gone', type: 'ignored' };
    }
    if (!res.ok) {
      return { reason: `the pull request read answered ${res.status}`, type: 'failed' };
    }
    const parsed = PrHeadSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { reason: 'the pull request read was unreadable', type: 'failed' };
    }
    return { pr: parsed.data, type: 'ok' };
  } catch (err) {
    log?.warn({ err, prNumber }, 'the pull request read failed');
    return { reason: 'the pull request could not be read', type: 'failed' };
  }
}

/** What a bot that is not Qodo's has always been answered with. */
const BOT_REASON = 'left by a Bot, not a person';

/**
 * The one enrichment pass a `github.pull_request.feedback` occurrence gets, once in the
 * gateway before the engine sees it (so a recorded decision replays the same `origin` and
 * `headRef`): the pull request the platform opened — its `PullRequest` row, on one of the
 * connections the engine would match, whose `ActiveWorkflow` names the run's template — is a
 * `workflow` pull request, or an `agent_run` one when that template is the Agent Run system
 * template. Anything else is `other`.
 *
 * An `issue_comment` delivery carries no head branch: a platform pull request's is its run's
 * `assignedBranch`; for any other, ONE read of the pull request from the host with the
 * repository's platform credential, which also catches a fork head. A failed read is `failed`
 * so the delivery can be redelivered; when no credential can reach the host the head is left
 * unset (the payload contract refuses the run later, recorded as a failed start).
 */
export async function enrichPrFeedbackFacts(
  prisma: PrismaClient,
  event: Occurrence<PrFeedbackFacts> & { repositoryId?: number },
  verifiedHost: string | null,
  log?: { warn: (obj: unknown, msg: string) => void }
): Promise<EnrichedFeedback> {
  const { facts } = event;
  // A bot's nudge is acted on only when the bot is the one an admin named by its numeric
  // account id; nothing is queried before that. Any other bot is answered as ever.
  if (
    facts.trigger === PR_FEEDBACK_QODO_TRIGGER &&
    !(await resolveSetting('qodo.prFeedbackBotAccountIds')).includes(Number(facts.senderId))
  ) {
    return { reason: BOT_REASON, type: 'ignored' };
  }
  const repositoryWhere = await webhookRepositoryWhere(
    prisma,
    event.org,
    event.repoName,
    event.repoHtmlUrl,
    verifiedHost
  );
  const connections: (FeedbackConnection & {
    teamId: string | null;
    team?: { orgId: string | null } | null;
  })[] = await runUnscoped('a webhook names a host repository, not a team', ['Connection'], () =>
    prisma.connection.findMany({
      select: {
        githubApiUrl: true,
        githubUrl: true,
        id: true,
        installation: { select: { host: true, installationId: true } },
        team: { select: { orgId: true } },
        teamId: true,
      },
      where: { ...repositoryWhere, isActive: true, type: 'git_repo' },
    })
  );
  const pullRequest =
    connections.length === 0
      ? null
      : await prisma.pullRequest.findFirst({
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          select: {
            repoId: true,
            workflow: { select: { assignedBranch: true, temporalWorkflowId: true } },
          },
          where: {
            prNumber: facts.prNumber,
            repoId: { in: connections.map((c) => c.id) },
            status: 'OPEN',
          },
        });

  let origin: PrFeedbackFacts['origin'] = 'other';
  let headRef = facts.headRef;
  if (pullRequest?.workflow) {
    const run = await prisma.workflowRun.findFirst({
      select: { template: { select: { origin: true, teamId: true } } },
      where: { workflowId: pullRequest.workflow.temporalWorkflowId },
    });
    origin =
      run?.template.origin === AGENT_RUN_TEMPLATE_ORIGIN && run.template.teamId === null
        ? 'agent_run'
        : 'workflow';
    // An `issue_comment` names no branch; a platform pull request's head is its run's own.
    headRef ??= pullRequest.workflow.assignedBranch ?? undefined;
  }
  if (facts.trigger === PR_FEEDBACK_QODO_TRIGGER) {
    return enrichQodoNudge(
      facts,
      event,
      origin,
      headRef,
      connections.find((c) => c.id === pullRequest?.repoId),
      log
    );
  }
  if (origin === 'other' && facts.eventKind === 'issue_comment' && !headRef) {
    // No token is minted and no host read runs unless a round could actually start on a
    // matched connection: the kill switch is on for its team/org AND an enabled feedback
    // automation on it selects `others` pull requests with the `command` trigger.
    const eligible: typeof connections = [];
    for (const c of connections) {
      const cctx = {
        ...(c.team?.orgId ? { orgId: c.team.orgId } : {}),
        teamId: c.teamId ?? undefined,
      };
      if (!(await resolveSetting('github.prFeedbackAutomationsEnabled', cctx))) {
        continue;
      }
      // A webhook names a host repository, not a team: the lookup spans every team.
      const eligibleRows = await runUnscoped(
        'a webhook names a host repository, not a team',
        ['Automation'],
        () =>
          prisma.automation.findMany({
            select: { filters: true },
            where: {
              connectionId: c.id,
              enabled: true,
              source: 'github.pull_request.feedback',
            },
          })
      );
      const allows = eligibleRows.some((a) => {
        const f = (a.filters ?? {}) as { pullRequests?: string[]; triggers?: string[] };
        return (
          (f.pullRequests ?? []).includes('others') &&
          (f.triggers ?? ['command']).includes('command')
        );
      });
      if (allows) {
        eligible.push(c);
      }
    }
    if (eligible.length === 0) {
      // Nothing on this repository could act on a stranger's pull request: leave the head
      // unset and let the payload contract refuse the run, without ever touching the host.
      return { facts: { ...facts, headRef: undefined, origin }, type: 'ok' };
    }
    const connection = pullRequest
      ? (eligible.find((c) => c.id === pullRequest.repoId) ?? eligible[0])
      : eligible[0];
    const target = connection ? await feedbackReadTarget(connection, log) : null;
    if (connection && !target) {
      // No credential can reach this host: leave the head unset; the payload contract
      // refuses the run later rather than a 503 a redelivery can never fix.
      return { facts: { ...facts, headRef: undefined, origin }, type: 'ok' };
    }
    if (target) {
      const read = await readPullRequestHead(target, event, facts.prNumber, log);
      if (read.type !== 'ok') {
        return read;
      }
      const pr = read.pr;
      if (pr.state !== 'open') {
        return { reason: 'the pull request is not open', type: 'ignored' };
      }
      if (!pr.head.repo || pr.head.repo.id !== event.repositoryId) {
        return { reason: 'the pull request is from a fork', type: 'ignored' };
      }
      if (!isSafeGitBranchName(pr.head.ref)) {
        return { reason: 'the pull request names no usable branch', type: 'ignored' };
      }
      headRef = pr.head.ref;
    }
  }
  return { facts: { ...facts, headRef, origin }, type: 'ok' };
}

/**
 * The rest of a Qodo nudge's enrichment: only a pull request the platform opened, only where
 * Qodo reading is on for the repository's team, and only with the head commit it is deduped
 * on. A delivery that carries no head (a discussion comment) gets it from one read of the pull
 * request, which also catches a fork head and a closed pull request.
 */
async function enrichQodoNudge(
  facts: PrFeedbackFacts,
  event: { org: string; repoName: string; repositoryId?: number },
  origin: PrFeedbackFacts['origin'],
  headRef: string | undefined,
  connection:
    | (FeedbackConnection & { teamId: string | null; team?: { orgId: string | null } | null })
    | undefined,
  log?: { warn: (obj: unknown, msg: string) => void }
): Promise<EnrichedFeedback> {
  if (origin === 'other' || !connection) {
    return { reason: 'the pull request is not one the platform opened', type: 'ignored' };
  }
  const enabled = await resolveSetting('qodo.enabled', {
    ...(connection.team?.orgId ? { orgId: connection.team.orgId } : {}),
    teamId: connection.teamId ?? undefined,
  });
  if (!enabled) {
    return { reason: 'reading Qodo’s review is switched off', type: 'ignored' };
  }
  if (facts.headSha && headRef) {
    return { facts: { ...facts, headRef, origin }, type: 'ok' };
  }
  const target = await feedbackReadTarget(connection, log);
  if (!target) {
    return { reason: 'no credential can read the pull request', type: 'ignored' };
  }
  const read = await readPullRequestHead(target, event, facts.prNumber, log);
  if (read.type !== 'ok') {
    return read;
  }
  const { pr } = read;
  if (pr.state !== 'open') {
    return { reason: 'the pull request is not open', type: 'ignored' };
  }
  if (!pr.head.repo || pr.head.repo.id !== event.repositoryId) {
    return { reason: 'the pull request is from a fork', type: 'ignored' };
  }
  if (!isSafeGitBranchName(pr.head.ref)) {
    return { reason: 'the pull request names no usable branch', type: 'ignored' };
  }
  if (!pr.head.sha || !HEAD_SHA.test(pr.head.sha)) {
    return NO_HEAD;
  }
  return {
    facts: { ...facts, headRef: pr.head.ref, headSha: pr.head.sha.toLowerCase(), origin },
    type: 'ok',
  };
}
