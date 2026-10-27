/**
 * The Jira filter poller (docs/specs/2026-10-27-jira-filter-polling.md): one poll of one
 * `jira.filter.new_issue` automation. It runs the automation's JQL with the platform's Jira
 * credential, keeps only the issues in the projects an admin allowed, and compares them with
 * what the automation has already seen.
 *
 * The first poll of an automation records what already matches and starts nothing, so a broad
 * filter cannot launch a backlog the moment it is saved.
 *
 * Replicas poll one automation at a time through a lease on its poll-state row: a compare-and-set
 * that only one replica wins, which expires on its own if the process dies. (A session advisory
 * lock would not do: Prisma's pool does not keep a session.) Whatever happens after the lease is
 * taken, it is released, and `lastError` only ever holds one of the fixed codes below, never
 * text from Jira.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  type JiraFilterFacts,
  JiraFilterFactsSchema,
  JiraFilterFiltersSchema,
  jiraFilterNewIssueSource,
  repositoryOwnerKey,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import type { IssueTrackerProvider } from '@auto-swe/shared/lib/integrations/issueTracker';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';
import type { FastifyInstance } from 'fastify';
import {
  type AutomationResult,
  type AutomationRow,
  AutomationStartError,
  decideAndStart,
  type EngineConnection,
} from './engine.js';

/** Matches one poll will read. More means the filter is too broad to act on safely. */
export const JIRA_POLL_MAX_MATCHES = 1_000;

/** How long a replica may hold an automation's lease. It expires by itself if the process dies. */
const LEASE_MS = 5 * 60_000;

/** Issues one poll of one automation decides. The rest stay unseen for the next poll. */
const MAX_ISSUES_PER_POLL = 50;

/** The only values `lastError` ever holds. */
export type PollErrorCode =
  | 'NO_ALLOWED_PROJECTS'
  | 'SWITCHED_OFF'
  | 'REPOSITORY_INACTIVE'
  | 'FILTER_TOO_BROAD'
  | 'JQL_REJECTED'
  | 'TRACKER_UNAVAILABLE'
  | 'INVALID_FILTERS'
  | 'START_FAILED';

export type PollSkipReason =
  | 'repository-inactive'
  | 'installation-retired'
  | 'switched-off'
  | 'leased';

export type PollOutcome =
  | { status: 'skipped'; reason: PollSkipReason }
  | { status: 'error'; code: PollErrorCode }
  | { status: 'baselined'; recorded: number }
  | { status: 'polled'; started: number; suppressed: number; pending: number };

/** An automation as the poller reads it: its filters, and the repository it acts on. */
export interface PollableAutomation {
  id: string;
  filters: unknown;
  connection: {
    id: string;
    isActive: boolean;
    installation?: { isActive: boolean } | null;
    team: { id: string; orgId: string | null };
  };
}

export interface PollDeps {
  prisma: Pick<PrismaClient, 'automationPollState' | 'automationSeenIssue'>;
  tracker: Pick<IssueTrackerProvider, 'searchIssues' | 'fetchIssue'>;
  /** Decides one new issue: the engine, for the automation being polled. */
  decide: (facts: JiraFilterFacts) => Promise<AutomationResult>;
  now: Date;
}

const KILL_SWITCH = 'workflow.jiraPollAutomationsEnabled';
const ALLOWLIST = 'workflow.jiraPollProjectKeys';

/** A trailing `ORDER BY …`, which Jira refuses inside parentheses and a poll has no use for. */
const TRAILING_ORDER_BY = /(?<=^|[\s)])order\s+by\s+(?:[^()"']|"[^"]*"|'[^']*')+$/i;

/**
 * The JQL narrowed to the allowed projects. With balanced parentheses (`hasBalancedParentheses`)
 * the narrowing cannot be stepped out of, and the allowlist is still enforced again on the results.
 */
export function wrapJqlInProjects(jql: string, projectKeys: readonly string[]): string {
  const projects = `project in (${projectKeys.map((k) => `"${k}"`).join(', ')})`;
  const condition = jql.replace(TRAILING_ORDER_BY, '').trim();
  return condition === '' ? projects : `${projects} AND (${condition})`;
}

/**
 * Whether every parenthesis outside a quoted string is closed, and none closes before it opens.
 * JQL that is not balanced can end the wrapper's parenthesis early (`x = 1) OR project = OTHER OR
 * (x = 1`) and so be read outside the allowed projects; its error code would also tell its author
 * what exists there.
 */
export function hasBalancedParentheses(jql: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth < 0) {
      return false;
    }
  }
  return depth === 0;
}

/** A project key as Jira issues it. `toUpperCase` folds some other characters onto these. */
const ASCII_PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Jira refusing the query itself, as opposed to Jira being unreachable or unwell. */
function isJqlRejection(err: unknown): boolean {
  return err instanceof AtlassianError && err.status === 400;
}

/**
 * Says why an automation is not being polled, and forgets its baseline. A period in which it is
 * not polled (switched off, a repository out of use) is a period whose issues it must not start
 * runs for when polling resumes: the next poll takes a new baseline and starts nothing. Without a
 * reason the row would read "not polled yet", with nothing to say why.
 */
async function recordSkip(
  deps: PollDeps,
  automationId: string,
  code: 'SWITCHED_OFF' | 'REPOSITORY_INACTIVE'
): Promise<void> {
  const { automationPollState: states } = deps.prisma;
  await states.createMany({ data: [{ automationId }], skipDuplicates: true });
  await states.updateMany({
    data: { baselinedAt: null, lastError: code },
    where: { automationId },
  });
}

export async function pollAutomation(
  deps: PollDeps,
  automation: PollableAutomation
): Promise<PollOutcome> {
  const { connection } = automation;
  if (!connection.isActive) {
    await recordSkip(deps, automation.id, 'REPOSITORY_INACTIVE');
    return { reason: 'repository-inactive', status: 'skipped' };
  }
  if (isInstallationRetired(connection)) {
    await recordSkip(deps, automation.id, 'REPOSITORY_INACTIVE');
    return { reason: 'installation-retired', status: 'skipped' };
  }
  const scope = {
    ...(connection.team.orgId ? { orgId: connection.team.orgId } : {}),
    teamId: connection.team.id,
  };
  if ((await resolveSetting(KILL_SWITCH, scope)) !== true) {
    await recordSkip(deps, automation.id, 'SWITCHED_OFF');
    return { reason: 'switched-off', status: 'skipped' };
  }

  const { automationPollState: states } = deps.prisma;
  const automationId = automation.id;
  const leaseUntil = new Date(deps.now.getTime() + LEASE_MS);
  await states.createMany({ data: [{ automationId }], skipDuplicates: true });
  const claimed = await states.updateMany({
    data: { leaseUntil },
    where: { automationId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: deps.now } }] },
  });
  if (claimed.count !== 1) {
    return { reason: 'leased', status: 'skipped' };
  }

  // The lease is always released, and only if it is still this poll's: one that outlived its
  // lease must not erase the replica that took over. A poll that threw (the database, not Jira)
  // records no outcome, only the release, and its own failure is the one reported.
  let outcome: PollOutcome | undefined;
  let failure: { error: unknown } | undefined;
  try {
    outcome = await poll(deps, automation, scope);
  } catch (error) {
    failure = { error };
  }
  try {
    await states.updateMany({
      data: outcome
        ? {
            lastError: outcome.status === 'error' ? outcome.code : null,
            lastPolledAt: deps.now,
            leaseUntil: null,
          }
        : { leaseUntil: null },
      where: { automationId, leaseUntil },
    });
  } catch (error) {
    failure ??= { error };
  }
  if (failure) {
    throw failure.error;
  }
  return outcome as PollOutcome;
}

async function poll(
  deps: PollDeps,
  automation: PollableAutomation,
  scope: { orgId?: string; teamId: string }
): Promise<PollOutcome> {
  const filters = JiraFilterFiltersSchema.safeParse(automation.filters);
  if (!filters.success || !hasBalancedParentheses(filters.data.jql)) {
    return { code: 'INVALID_FILTERS', status: 'error' };
  }
  // Sorted, so the same projects in another order are the same query and the same baseline.
  const allowed = (await resolveSetting(ALLOWLIST, scope)).map((k) => k.toUpperCase()).sort();
  if (allowed.length === 0) {
    return { code: 'NO_ALLOWED_PROJECTS', status: 'error' };
  }

  const narrowed = wrapJqlInProjects(filters.data.jql, allowed);
  let found: Awaited<ReturnType<PollDeps['tracker']['searchIssues']>>;
  try {
    found = await deps.tracker.searchIssues(narrowed, {
      maxResults: JIRA_POLL_MAX_MATCHES,
    });
  } catch (err) {
    return { code: isJqlRejection(err) ? 'JQL_REJECTED' : 'TRACKER_UNAVAILABLE', status: 'error' };
  }
  if (found.truncated) {
    return { code: 'FILTER_TOO_BROAD', status: 'error' };
  }
  // The authoritative check: whatever the JQL selected, only an allowed project is acted on.
  const inAllowedProjects = found.issues.filter(
    (i) => ASCII_PROJECT_KEY.test(i.projectKey) && allowed.includes(i.projectKey.toUpperCase())
  );

  const { automationPollState: states, automationSeenIssue: seenIssues } = deps.prisma;
  const state = await states.findUniqueOrThrow({ where: { automationId: automation.id } });
  // A baseline belongs to the query it was taken for, as Jira is asked it: the JQL and the
  // allowed projects. A different one (an edited JQL, a project added to the allowlist) takes a
  // new baseline, so what it already matched is recorded and starts nothing.
  if (state.baselinedAt === null || state.baselineJql !== narrowed) {
    await seenIssues.createMany({
      data: inAllowedProjects.map((i) => ({
        automationId: automation.id,
        issueKey: i.key.toLowerCase(),
      })),
      skipDuplicates: true,
    });
    await states.update({
      data: { baselinedAt: deps.now, baselineJql: narrowed },
      where: { automationId: automation.id },
    });
    return { recorded: inAllowedProjects.length, status: 'baselined' };
  }
  return startNewIssues(deps, automation.id, inAllowedProjects);
}

/** `PAY-2` before `PAY-10`; within a poll, one project after another. */
const byIssueNumber = (a: { key: string }, b: { key: string }) =>
  a.key.localeCompare(b.key, 'en', { numeric: true });

/**
 * Decide the issues the automation has not seen, in key order (by project, then issue number)
 * and at most one poll's worth. An issue is marked seen only after the engine has decided it, so a
 * crash between the two is decided again and answered `duplicate`.
 *
 * What stops the batch is visible, never silent: an issue that cannot be read, or whose start
 * failed or was ignored, ends the poll with a fixed error code and stays unseen, because its
 * cause (Jira, a template, Temporal) is not the issue's. Skipping it instead would leave it
 * first in line on every poll and starve the newer issues behind it without a trace.
 */
async function startNewIssues(
  deps: PollDeps,
  automationId: string,
  matches: readonly { key: string; projectKey: string }[]
): Promise<PollOutcome> {
  const { automationSeenIssue: seenIssues } = deps.prisma;
  // One issue is one key whatever its spelling.
  const byKey = new Map(matches.map((m) => [m.key.toLowerCase(), m]));
  const seenRows = await seenIssues.findMany({
    select: { issueKey: true },
    where: { automationId, issueKey: { in: [...byKey.keys()] } },
  });
  const seen = new Set(seenRows.map((r) => r.issueKey));
  const unseen = [...byKey.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, match]) => match)
    .sort(byIssueNumber);
  const markSeen = (key: string) =>
    seenIssues.createMany({
      data: [{ automationId, issueKey: key.toLowerCase() }],
      skipDuplicates: true,
    });

  let started = 0;
  let suppressed = 0;
  let decided = 0;
  for (const match of unseen.slice(0, MAX_ISSUES_PER_POLL)) {
    let issue: Awaited<ReturnType<PollDeps['tracker']['fetchIssue']>>;
    try {
      issue = await deps.tracker.fetchIssue(match.key);
    } catch {
      return { code: 'TRACKER_UNAVAILABLE', status: 'error' };
    }
    if (!issue) {
      return { code: 'TRACKER_UNAVAILABLE', status: 'error' };
    }
    // The search approved this key in this project. A read that answers for another issue (one
    // moved to another project since) is not it, and is left for the next search to show.
    if (issue.id.toLowerCase() !== match.key.toLowerCase()) {
      // It has a new key now, which the next search shows if it is allowed. Left unseen it would
      // keep its place in the window of 50 on every poll and hide the newer issues behind it.
      await markSeen(match.key);
      decided++;
      continue;
    }
    const facts = JiraFilterFactsSchema.safeParse({
      description: issue.description.slice(0, 4_000),
      issueKey: match.key,
      projectKey: match.projectKey,
      summary: issue.title.slice(0, 256),
      url: issue.url.slice(0, 500),
    });
    if (!facts.success) {
      // Facts that can never be valid (a key of an unheard-of shape): retrying changes nothing,
      // and leaving it unseen would put it first in line on every poll.
      await markSeen(match.key);
      decided++;
      continue;
    }
    let result: AutomationResult;
    try {
      result = await deps.decide(facts.data);
    } catch (err) {
      if (err instanceof AutomationStartError) {
        return { code: 'START_FAILED', status: 'error' };
      }
      throw err;
    }
    if ('ignored' in result || ('outcome' in result && result.outcome === 'FAILED_TO_START')) {
      return { code: 'START_FAILED', status: 'error' };
    }
    await markSeen(match.key);
    decided++;
    if ('outcome' in result) {
      if (result.outcome === 'STARTED') {
        started++;
      } else {
        suppressed++;
      }
    }
  }
  return { pending: unseen.length - decided, started, status: 'polled', suppressed };
}

/** `host[:port]` of a URL, lowercased, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The ledger owner of a repository connection, spelled as the webhook path spells it
 * (`<host>/<owner>/<repo>`, lower-cased), so one repository's decisions are counted together
 * whichever way an occurrence reached the engine. Null when the row names no repository.
 */
export function connectionOwnerKey(
  connection: {
    githubUrl: string | null;
    organizationName: string | null;
    repoName: string | null;
  },
  instanceBaseUrl: string
): string | null {
  if (!connection.organizationName || !connection.repoName) {
    return null;
  }
  const host = hostOf(connection.githubUrl ?? instanceBaseUrl);
  return host
    ? repositoryOwnerKey(host, `${connection.organizationName}/${connection.repoName}`)
    : null;
}

/** The engine, bound to one automation and the repository it acts on. */
export function engineDecider(
  fastify: FastifyInstance,
  args: {
    automation: AutomationRow;
    connection: EngineConnection;
    ownerKey: string;
    now: Date;
  }
): PollDeps['decide'] {
  return (facts) =>
    decideAndStart(fastify, jiraFilterNewIssueSource, {
      automation: args.automation,
      connection: args.connection,
      facts,
      now: args.now,
      ownerKey: args.ownerKey,
      // A poll that decided an issue and crashed before marking it seen decides it again; only a
      // start that failed is taken again, as for a redelivered webhook.
      retry: { kind: 'redelivery' },
      startRetryDelayMs: 1_000,
      team: args.connection.team,
    });
}
