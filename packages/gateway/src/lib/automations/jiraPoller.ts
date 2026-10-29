/**
 * The Jira filter poller (docs/automations.md §3.2): one poll of one `jira.filter.new_issue` or
 * `jira.filter.status_changed` automation. It runs the automation's JQL with the platform's Jira
 * credential, keeps only the issues in the projects an admin allowed, and compares them with
 * what the automation has already seen.
 *
 * The first poll of an automation records what already matches and starts nothing, so a broad
 * filter cannot launch a backlog the moment it is saved.
 *
 * The two sources differ in one thing, what counts as already seen. `new_issue` remembers issue
 * keys; `status_changed` remembers (issue key, status) pairs, so an issue in a status it has not
 * been seen in is an occurrence, once per status, and a poll replay or restart finds the pair
 * recorded. Everything else (lease, allowlist, baseline, fail-closed errors) is shared.
 *
 * Replicas poll one automation at a time through a lease on its poll-state row: a compare-and-set
 * that only one replica wins, which expires on its own if the process dies. (A session advisory
 * lock would not do: Prisma's pool does not keep a session.) Whatever happens after the lease is
 * taken, it is released, and `lastError` only ever holds one of the fixed codes below, never
 * text from Jira.
 */
import type { FetchIssueOutcome, PrismaClient } from '@auto-swe/shared';
import {
  JIRA_FILTER_STATUS_CHANGED,
  type JiraFilterFacts,
  JiraFilterFactsSchema,
  JiraFilterFiltersSchema,
  type JiraStatusChangedFacts,
  JiraStatusChangedFactsSchema,
  jiraFilterNewIssueSource,
  jiraFilterStatusChangedSource,
  repositoryOwnerKey,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import type { IssueTrackerProvider } from '@auto-swe/shared/lib/integrations/issueTracker';
import { JIRA_SYNC_STATUS_KEYS } from '@auto-swe/shared/lib/integrations/jiraSyncStatuses';
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
  | {
      status: 'polled';
      started: number;
      /** Issues the engine decided without starting a run; each is in the ledger. */
      suppressed: number;
      pending: number;
      /** Issues the tracker refused to show (marked seen, no ledger row). Absent when none. */
      refused?: number;
    };

/** An automation as the poller reads it: its filters, and the repository it acts on. */
export interface PollableAutomation {
  id: string;
  /** The source key; anything but `jira.filter.status_changed` polls for new issues. */
  source?: string;
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
  tracker: Pick<IssueTrackerProvider, 'searchIssues' | 'fetchIssue' | 'fetchIssueOutcome'>;
  /** Decides one new issue: the engine, for the automation being polled. */
  decide: (facts: JiraFilterFacts | JiraStatusChangedFacts) => Promise<AutomationResult>;
  now: Date;
  /** Where a refused issue is named (its key only). */
  log?: { warn: (obj: unknown, msg?: string) => void };
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
    // Locked out, like switched off: what appears meanwhile must not start runs when the same
    // list comes back, so the next poll takes a new baseline.
    await deps.prisma.automationPollState.updateMany({
      data: { baselinedAt: null },
      where: { automationId: automation.id },
    });
    return { code: 'NO_ALLOWED_PROJECTS', status: 'error' };
  }

  const statusMode = automation.source === JIRA_FILTER_STATUS_CHANGED;
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
  const inAllowedProjects: Match[] = found.issues
    .filter(
      (i) => ASCII_PROJECT_KEY.test(i.projectKey) && allowed.includes(i.projectKey.toUpperCase())
    )
    // An issue the search shows no status for cannot be told from itself a moment ago: it is not
    // acted on, and not recorded, until a search does show one.
    .filter((i) => !statusMode || (i.status ?? '').trim() !== '')
    .map((i) => ({
      key: i.key,
      projectKey: i.projectKey,
      ...(i.status ? { status: i.status } : {}),
    }));

  const { automationPollState: states, automationSeenIssue: seenIssues } = deps.prisma;
  const state = await states.findUniqueOrThrow({ where: { automationId: automation.id } });
  // A baseline belongs to the query it was taken for, as Jira is asked it: the JQL and the
  // allowed projects. A different one (an edited JQL, a project added to the allowlist) takes a
  // new baseline, so what it already matched is recorded and starts nothing. Under
  // `status_changed` that is each match in the status it is in now.
  if (state.baselinedAt === null || state.baselineJql !== narrowed) {
    await seenIssues.createMany({
      data: inAllowedProjects.map((i) => ({
        automationId: automation.id,
        issueKey: seenKeyOf(i, statusMode),
      })),
      skipDuplicates: true,
    });
    await states.update({
      data: { baselinedAt: deps.now, baselineJql: narrowed },
      where: { automationId: automation.id },
    });
    return { recorded: inAllowedProjects.length, status: 'baselined' };
  }
  return startNewIssues(deps, automation.id, inAllowedProjects, statusMode);
}

/** One search match the poll may act on. `status` is set under `status_changed`. */
interface Match {
  key: string;
  projectKey: string;
  status?: string;
}

/**
 * What the automation remembers an issue by: its key, or under `status_changed` its key and the
 * status it is in. Lower-case, as the seen set requires; `#` cannot occur in a Jira key.
 */
export function seenKeyOf(match: Match, statusMode: boolean): string {
  const key = match.key.toLowerCase();
  return statusMode ? `${key}#${(match.status ?? '').trim().toLowerCase()}` : key;
}

/** A tracker that cannot say why a read found nothing: a miss is read as unavailable. */
async function readByFetchIssue(
  tracker: Pick<IssueTrackerProvider, 'fetchIssue'>,
  key: string
): Promise<FetchIssueOutcome> {
  const issue = await tracker.fetchIssue(key);
  return issue ? { issue, kind: 'found' } : { kind: 'unavailable' };
}

/** `PAY-2` before `PAY-10`; within a poll, one project after another. */
const byIssueNumber = (a: { key: string }, b: { key: string }) =>
  a.key.localeCompare(b.key, 'en', { numeric: true });

/**
 * Decide the issues the automation has not seen, in key order (by project, then issue number)
 * and at most one poll's worth. An issue is marked seen only after the engine has decided it, so a
 * crash between the two is decided again and answered `duplicate`.
 *
 * An issue the tracker definitively refuses to show (404 on its own read) is marked seen and
 * counted as refused, so one unreadable issue cannot hold up the newer ones behind it.
 *
 * What stops the batch is visible, never silent: an issue that cannot be read for now (a 5xx, a
 * timeout, a 403, a rejected credential, a tracker that cannot say why), or whose start
 * failed or was ignored, ends the poll with a fixed error code and stays unseen, because its
 * cause (Jira, a template, Temporal) is not the issue's. Skipping it instead would leave it
 * first in line on every poll and starve the newer issues behind it without a trace.
 */
async function startNewIssues(
  deps: PollDeps,
  automationId: string,
  matches: readonly Match[],
  statusMode: boolean
): Promise<PollOutcome> {
  const { automationSeenIssue: seenIssues } = deps.prisma;
  // One issue is one key whatever its spelling.
  const byKey = new Map(matches.map((m) => [seenKeyOf(m, statusMode), m]));
  const seenRows = await seenIssues.findMany({
    select: { issueKey: true },
    where: { automationId, issueKey: { in: [...byKey.keys()] } },
  });
  const seen = new Set(seenRows.map((r) => r.issueKey));
  const unseen = [...byKey.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, match]) => match)
    .sort(byIssueNumber);
  const markSeen = (match: Match) =>
    seenIssues.createMany({
      data: [{ automationId, issueKey: seenKeyOf(match, statusMode) }],
      skipDuplicates: true,
    });

  let started = 0;
  let suppressed = 0;
  let refused = 0;
  let decided = 0;
  for (const match of unseen.slice(0, MAX_ISSUES_PER_POLL)) {
    let read: FetchIssueOutcome;
    try {
      read = deps.tracker.fetchIssueOutcome
        ? await deps.tracker.fetchIssueOutcome(match.key)
        : await readByFetchIssue(deps.tracker, match.key);
    } catch {
      return { code: 'TRACKER_UNAVAILABLE', status: 'error' };
    }
    if (read.kind === 'refused') {
      // The tracker's definitive answer about this issue (issue-level security, or gone): asking
      // again changes nothing, and leaving it unseen would starve every newer issue behind it. It
      // is counted as refused, not suppressed (no ledger row), and only its key is logged.
      await markSeen(match);
      decided++;
      refused++;
      deps.log?.warn({ automationId, issueKey: match.key }, 'Jira refused to show an issue');
      continue;
    }
    if (read.kind === 'unavailable') {
      return { code: 'TRACKER_UNAVAILABLE', status: 'error' };
    }
    const { issue } = read;
    // The search approved this key in this project. A read that answers for another issue (one
    // moved to another project since) is not it, and is left for the next search to show.
    if (issue.id.toLowerCase() !== match.key.toLowerCase()) {
      // It has a new key now, which the next search shows if it is allowed. Left unseen it would
      // keep its place in the window of 50 on every poll and hide the newer issues behind it.
      await markSeen(match);
      decided++;
      continue;
    }
    // The status is the search's, the one the pair was recorded under, not a later read's.
    const facts = (statusMode ? JiraStatusChangedFactsSchema : JiraFilterFactsSchema).safeParse({
      description: issue.description.slice(0, 4_000),
      issueKey: match.key,
      projectKey: match.projectKey,
      summary: issue.title.slice(0, 256),
      url: issue.url.slice(0, 500),
      ...(statusMode ? { status: match.status } : {}),
    });
    if (!facts.success) {
      // Facts that can never be valid (a key of an unheard-of shape, a status over 100
      // characters): retrying changes nothing, and leaving it unseen would put it first in line
      // on every poll. Said in the log, by key only, never with Jira's text.
      await markSeen(match);
      decided++;
      deps.log?.warn(
        { automationId, issueKey: match.key },
        'a Jira issue was not acted on: its facts are not valid'
      );
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
    await markSeen(match);
    decided++;
    if ('outcome' in result) {
      if (result.outcome === 'STARTED') {
        started++;
      } else {
        suppressed++;
      }
    }
  }
  return {
    pending: unseen.length - decided,
    started,
    status: 'polled',
    suppressed,
    ...(refused > 0 ? { refused } : {}),
  };
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
  const isPlatformTransition = platformTransitionCheck(fastify.prisma);
  const common = {
    automation: args.automation,
    connection: args.connection,
    now: args.now,
    ownerKey: args.ownerKey,
    // A poll that decided an issue and crashed before marking it seen decides it again; only a
    // start that failed is taken again, as for a redelivered webhook.
    retry: { kind: 'redelivery' as const },
    startRetryDelayMs: 1_000,
    team: args.connection.team,
  };
  return args.automation.source === JIRA_FILTER_STATUS_CHANGED
    ? (facts) => {
        const status = facts as JiraStatusChangedFacts;
        return decideAndStart(fastify, jiraFilterStatusChangedSource, {
          ...common,
          facts: status,
          ownOutput: () => isPlatformTransition(status.issueKey, status.status),
        });
      }
    : (facts) => decideAndStart(fastify, jiraFilterNewIssueSource, { ...common, facts });
}

/** The reason recorded for a transition the platform made itself. */
export const PLATFORM_TRANSITION_REASON =
  'the platform’s own Jira sync moved this ticket to this status for a run on it; it is not acted on again';

/**
 * Recognises a transition the platform made itself. Its Jira sync moves a ticket to In Progress,
 * In Review and Done for a run on that ticket (`JIRA_SYNC_STATUSES`), and writes Done when the
 * pull request merges, which can be weeks after the run began. So an issue in one of those
 * statuses is taken as the platform's own doing when ANY run on that ticket exists, whatever its
 * age, repository or source (an automation, a manual launch, the transition hook).
 *
 * It is a rule over what the platform writes, not a view of who made the transition: a person's
 * move to one of those statuses on such a ticket is recognised too, and a workflow whose
 * transitions land in other status names is not. The ticket id is matched exactly in its usual
 * spellings (as Jira issues it, upper-case, lower-case) and never as a pattern, because `_` in a
 * project key is a wildcard to a case-insensitive match. The answer is a yes or no that is only
 * used to suppress an occurrence; no run, repository or team is named in it.
 */
export function platformTransitionCheck(
  prisma: Pick<PrismaClient, 'runInput'>
): (issueKey: string, status: string) => Promise<string | null> {
  return async (issueKey, status) => {
    if (!JIRA_SYNC_STATUS_KEYS.includes(status.trim().toLowerCase())) {
      return null;
    }
    const spellings = [...new Set([issueKey, issueKey.toUpperCase(), issueKey.toLowerCase()])];
    const run = await prisma.runInput.findFirst({
      select: { id: true },
      where: { externalTicketId: { in: spellings }, ticketIsSynthetic: false },
    });
    return run ? PLATFORM_TRANSITION_REASON : null;
  };
}
