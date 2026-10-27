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
import { JiraFilterFiltersSchema } from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import type { IssueTrackerProvider } from '@auto-swe/shared/lib/integrations/issueTracker';
import { isInstallationRetired } from '@auto-swe/shared/lib/repoAccessDecision';

/** Matches one poll will read. More means the filter is too broad to act on safely. */
export const JIRA_POLL_MAX_MATCHES = 1_000;

/** How long a replica may hold an automation's lease. It expires by itself if the process dies. */
const LEASE_MS = 5 * 60_000;

/** The only values `lastError` ever holds. */
export type PollErrorCode =
  | 'NO_ALLOWED_PROJECTS'
  | 'FILTER_TOO_BROAD'
  | 'JQL_REJECTED'
  | 'TRACKER_UNAVAILABLE'
  | 'INVALID_FILTERS';

export type PollSkipReason =
  | 'repository-inactive'
  | 'installation-retired'
  | 'switched-off'
  | 'leased';

export type PollOutcome =
  | { status: 'skipped'; reason: PollSkipReason }
  | { status: 'error'; code: PollErrorCode }
  | { status: 'baselined'; recorded: number }
  | { status: 'polled' };

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
  tracker: Pick<IssueTrackerProvider, 'searchIssues'>;
  now: Date;
}

const KILL_SWITCH = 'workflow.jiraPollAutomationsEnabled';
const ALLOWLIST = 'workflow.jiraPollProjectKeys';

/** A trailing `ORDER BY …`, which Jira refuses inside parentheses and a poll has no use for. */
const TRAILING_ORDER_BY = /(?:^|\s)order\s+by\s+[^()"']+$/i;

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

export async function pollAutomation(
  deps: PollDeps,
  automation: PollableAutomation
): Promise<PollOutcome> {
  const { connection } = automation;
  if (!connection.isActive) {
    return { reason: 'repository-inactive', status: 'skipped' };
  }
  if (isInstallationRetired(connection)) {
    return { reason: 'installation-retired', status: 'skipped' };
  }
  const scope = {
    ...(connection.team.orgId ? { orgId: connection.team.orgId } : {}),
    teamId: connection.team.id,
  };
  if ((await resolveSetting(KILL_SWITCH, scope)) !== true) {
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
  const allowed = (await resolveSetting(ALLOWLIST, scope)).map((k) => k.toUpperCase());
  if (allowed.length === 0) {
    return { code: 'NO_ALLOWED_PROJECTS', status: 'error' };
  }

  let found: Awaited<ReturnType<PollDeps['tracker']['searchIssues']>>;
  try {
    found = await deps.tracker.searchIssues(wrapJqlInProjects(filters.data.jql, allowed), {
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
  if (state.baselinedAt === null) {
    await seenIssues.createMany({
      data: inAllowedProjects.map((i) => ({
        automationId: automation.id,
        issueKey: i.key.toLowerCase(),
      })),
      skipDuplicates: true,
    });
    await states.update({
      data: { baselinedAt: deps.now },
      where: { automationId: automation.id },
    });
    return { recorded: inAllowedProjects.length, status: 'baselined' };
  }
  return { status: 'polled' };
}
