import type { Prisma } from '@auto-swe/shared';
import { isJiraFilterSource, JIRA_FILTER_SOURCES } from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { createIssueTrackerProvider } from '@auto-swe/shared/lib/integrations/registry';
import { resolveGitHubConfig, resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { connectionInclude, type EngineConnection } from '../lib/automations/engine.js';
import {
  connectionOwnerKey,
  engineDecider,
  type PollDeps,
  type PollOutcome,
  pollAutomation,
} from '../lib/automations/jiraPoller.js';

/**
 * Polls every enabled Jira filter automation on a timer (docs/automations.md §3.2).
 * It runs in the gateway because the engine that decides an issue lives here. Replicas coordinate
 * through each automation's lease (`pollAutomation`), so every replica may run this loop.
 */

/** Seconds to wait when the interval setting cannot be read. */
const FALLBACK_INTERVAL_SECONDS = 300;

/** Wait after boot before the first tick, so start-up is not competing with it. */
const FIRST_TICK_DELAY_MS = 15_000;

/**
 * Longest one automation's poll may run before the tick gives up on it and goes on. Under the
 * lease (five minutes), which the abandoned poll still holds until it ends or expires.
 */
const POLL_DEADLINE_MS = 4 * 60_000;

/**
 * Longest a tick keeps starting automations. The rest wait for the next tick, which begins with
 * the one polled longest ago, so no tenant is always last behind a slow one.
 */
const TICK_BUDGET_MS = 10 * 60_000;

/** Longest a closing server waits for a tick that is running. */
const STOP_WAIT_MS = 30_000;

export interface PollLoop {
  start(): void;
  /** Stops scheduling; resolves when the tick that is running, if any, has ended. */
  stop(): Promise<void>;
  stopped(): boolean;
}

/**
 * A self-rescheduling timer, not an interval: the next wait starts when a tick ends, so a slow
 * tick never overlaps the next, and the interval is read again before each wait so a change
 * applies from the next one. A tick that fails is logged and the loop goes on.
 */
export function createPollLoop(opts: {
  tick: () => Promise<void>;
  readIntervalSeconds: () => Promise<number>;
  firstDelayMs: number;
  log: { error: (obj: unknown, msg?: string) => void };
}): PollLoop {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;

  const schedule = (ms: number) => {
    if (!stopped) {
      timer = setTimeout(() => {
        running = run().finally(() => {
          running = undefined;
        });
      }, ms);
    }
  };

  const run = async () => {
    try {
      await opts.tick();
    } catch (err) {
      opts.log.error({ err }, 'a Jira filter poll failed');
    }
    if (stopped) {
      return;
    }
    let seconds = FALLBACK_INTERVAL_SECONDS;
    try {
      seconds = await opts.readIntervalSeconds();
    } catch (err) {
      opts.log.error({ err }, 'the Jira poll interval could not be read');
    }
    schedule(seconds * 1_000);
  };

  return {
    start: () => schedule(opts.firstDelayMs),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      return running ?? Promise.resolve();
    },
    stopped: () => stopped,
  };
}

/** An enabled Jira filter automation with the repository it acts on, as the engine reads it. */
export type PollRow = Omit<
  Prisma.AutomationGetPayload<{ include: { connection: { include: typeof connectionInclude } } }>,
  'connection'
> & { connection: EngineConnection };

export interface PollTickDeps {
  /** The Jira client, or null when the tracker is not Jira or is not fully configured. */
  tracker: () => Promise<PollDeps['tracker'] | null>;
  listAutomations: () => Promise<PollRow[]>;
  /**
   * The automation as it is now, or null when it is gone, off, or no longer a Jira filter. A tick
   * can run for minutes after it listed its automations, and what an owner changed or switched
   * off in that time must be what is polled.
   */
  reload: (automationId: string) => Promise<PollRow | null>;
  /** Notes that a poll was tried, so one that keeps failing does not stay first in line. */
  markAttempted: (automationId: string) => Promise<void>;
  /** The instance's own web base URL, the host of a repository that names none. */
  instanceBaseUrl: () => Promise<string>;
  poll: typeof pollAutomation;
  shouldStop: () => boolean;
  /** Tests only; defaults to just under the lease. */
  deadlineMs?: number;
  /** Tests only; defaults to ten minutes. */
  budgetMs?: number;
  /** Tests only. */
  clock?: () => number;
}

/** Rejects when `promise` has not settled in `ms`. The work is not cancelled, only left behind. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the poll did not finish in time')), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * One tick: poll each enabled Jira filter automation in turn. One automation's failure is logged
 * and does not stop the others.
 */
export async function pollAllJiraAutomations(
  fastify: FastifyInstance,
  deps: PollTickDeps
): Promise<{ polled: number; failed: number; skipped: number }> {
  const result = { failed: 0, polled: 0, skipped: 0 };
  const tracker = await deps.tracker();
  if (!tracker) {
    return result;
  }
  const baseUrl = await deps.instanceBaseUrl();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const rows = await deps.listAutomations();
  for (const [index, listed] of rows.entries()) {
    if (deps.shouldStop()) {
      break;
    }
    if (clock() - startedAt > (deps.budgetMs ?? TICK_BUDGET_MS)) {
      fastify.log.warn(
        { waiting: rows.length - index },
        'the Jira poll tick used its time budget; the rest wait for the next tick'
      );
      break;
    }
    const row = await deps.reload(listed.id);
    if (!row?.enabled) {
      result.skipped++;
      continue;
    }
    const ownerKey = connectionOwnerKey(row.connection, baseUrl);
    if (!ownerKey) {
      fastify.log.warn(
        { automationId: row.id },
        'a Jira filter automation is on a repository that names no owner'
      );
      result.skipped++;
      continue;
    }
    try {
      const now = new Date();
      const outcome: PollOutcome = await withDeadline(
        deps.poll(
          {
            decide: engineDecider(fastify, {
              automation: row,
              connection: row.connection,
              now,
              ownerKey,
            }),
            log: fastify.log,
            now,
            prisma: fastify.prisma,
            tracker,
          },
          { connection: row.connection, filters: row.filters, id: row.id, source: row.source }
        ),
        deps.deadlineMs ?? POLL_DEADLINE_MS
      );
      if (outcome.status === 'skipped') {
        result.skipped++;
      } else {
        result.polled++;
      }
    } catch (err) {
      result.failed++;
      fastify.log.error({ automationId: row.id, err }, 'a Jira filter automation poll failed');
      await deps.markAttempted(row.id).catch(() => {});
    }
  }
  if (result.polled + result.failed + result.skipped > 0) {
    fastify.log.info(result, 'Jira filter poll');
  }
  return result;
}

/** The tick's real dependencies: the database, the tracker config and the engine. */
export function defaultTickDeps(
  fastify: Pick<FastifyInstance, 'prisma' | 'log'>,
  shouldStop: () => boolean
): PollTickDeps {
  return {
    instanceBaseUrl: async () => (await resolveGitHubConfig()).baseUrl,
    listAutomations: async () => {
      const rows = await runUnscoped(
        'the Jira poller lists every team’s Jira filter automations; each is decided for its own repository',
        ['Automation'],
        () =>
          fastify.prisma.automation.findMany({
            include: { connection: { include: connectionInclude } },
            // The automation polled longest ago first, one never polled before any: if a tick runs
            // out of time, the next one starts with those left behind.
            orderBy: [
              { pollState: { lastPolledAt: { nulls: 'first', sort: 'asc' } } },
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            where: {
              connectionId: { not: null },
              enabled: true,
              source: { in: [...JIRA_FILTER_SOURCES] },
            },
          })
      );
      return rows.filter((r): r is PollRow => r.connection !== null);
    },
    markAttempted: async (automationId) => {
      const states = fastify.prisma.automationPollState;
      await states.createMany({ data: [{ automationId }], skipDuplicates: true });
      await states.updateMany({ data: { lastPolledAt: new Date() }, where: { automationId } });
    },
    poll: pollAutomation,
    reload: async (automationId) => {
      const row = await runUnscoped(
        'the Jira poller reads one automation it is about to poll, to poll it as it is now',
        ['Automation'],
        () =>
          fastify.prisma.automation.findUnique({
            include: { connection: { include: connectionInclude } },
            where: { id: automationId },
          })
      );
      return row?.enabled && isJiraFilterSource(row.source) && row.connection !== null
        ? (row as PollRow)
        : null;
    },
    shouldStop,
    tracker: async () => {
      const config = await resolveIssueTrackerConfig();
      return config.provider === 'jira'
        ? createIssueTrackerProvider(config, { log: fastify.log })
        : null;
    },
  };
}

export interface JiraPollerOptions {
  /** Tests only. */
  firstDelayMs?: number;
}

export default fp<JiraPollerOptions>(
  async (fastify, opts) => {
    const loop: PollLoop = createPollLoop({
      firstDelayMs: opts.firstDelayMs ?? FIRST_TICK_DELAY_MS,
      log: fastify.log,
      readIntervalSeconds: () => resolveSetting('workflow.jiraPollIntervalSeconds'),
      tick: async () => {
        await pollAllJiraAutomations(
          fastify,
          defaultTickDeps(fastify, () => loop.stopped())
        );
      },
    });
    loop.start();
    fastify.addHook('onClose', async () => {
      // Fastify closes the database and Temporal plugins after this hook, so a tick that is
      // running is waited for, up to a bound, instead of being left to use them closed.
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      });
      await Promise.race([loop.stop(), gaveUp]);
      clearTimeout(timer);
    });
  },
  { dependencies: ['prisma'], fastify: '5.x', name: 'jira-poller' }
);
