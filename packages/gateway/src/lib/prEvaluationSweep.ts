import { randomBytes } from 'node:crypto';
import {
  type PrEvaluationInput,
  prEvaluationWorkflowId,
} from '@auto-swe/shared/lib/prEvaluationWorkflow';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

/** The trigger the worker sees on an evaluation started to disarm, not to evaluate afresh. */
export const DISARM_SWEEP_TRIGGER = 'disarm-sweep';
/** Open pull requests one repository's sweep starts an evaluation for. */
export const REPOSITORY_SWEEP_CAP = 200;
/** Open pull requests a deployment-wide sweep starts an evaluation for. */
export const GLOBAL_SWEEP_CAP = 500;

// Keys with no off position: any write may drop what a standing bot approval rests on.
const BOT_NARROWING_KEYS: ReadonlySet<string> = new Set([
  'prEvaluation.botApprovalPaths',
  'prEvaluation.botApprovalMaxLines',
  'prEvaluation.botApprovalMaxFiles',
]);

const KILL_SWITCH_KEYS: ReadonlySet<string> = new Set([
  'prEvaluation.enabled',
  'prEvaluation.autoMergeAllowed',
  'prEvaluation.botApprovalAllowed',
]);

/**
 * Whether a registry write turns pull request evaluation, auto-merge or bot approval off
 * deployment-wide, or narrows what a bot approval may cover: the switches an operator throws to stop the platform acting, so armed pull
 * requests must be disarmed, and bot-approved repositories re-evaluated, rather than left to
 * GitHub. All three settings are GLOBAL-only. A cleared override falls
 * back to the default, which is `false`, so a clear passes `false`.
 */
export function isPrEvaluationKillSwitch(key: string, scope: string, value: unknown): boolean {
  if (scope !== 'GLOBAL') {
    return false;
  }
  // The bot approval allowlist and size caps have no off position: any write may drop a path or a
  // size an approval stands on, and a clear restores the default, so every change re-evaluates.
  return BOT_NARROWING_KEYS.has(key) || (KILL_SWITCH_KEYS.has(key) && value === false);
}

/** A repository's sweep is skipped when one for it started less than this long ago. */
export const SWEEP_DEBOUNCE_MS = 60_000;

/**
 * When a sweep last started for each repository. Per process, in memory: a restart, or a second
 * gateway replica, forgets it, which only means one extra sweep. It bounds the cost of a route that
 * can be called repeatedly (each sweep starts up to `REPOSITORY_SWEEP_CAP` workflows).
 */
const lastSweepAt = new Map<string, number>();

export function resetSweepDebounceForTests(): void {
  lastSweepAt.clear();
}

export interface SweepResult {
  /** True when a recent sweep of the same repository made this one unnecessary. */
  debounced?: true;
  /** Open pull requests selected for a re-evaluation, up to the cap. */
  found: number;
  /** Workflows started (or already running under the same id). */
  started: number;
  failed: number;
  truncated: boolean;
}

/** Candidates read per pull request kept: the newest armed rows are not all still the latest. */
const CANDIDATE_FACTOR = 3;

/**
 * Start a re-evaluation of every open pull request that has any evaluation row recording an
 * arming or a standing bot approval (the newest row may be unarmed while GitHub still is, after concurrent evaluations), so
 * the worker's activity (which disarms whatever the current policy no longer wants armed) runs
 * for it. Scoped to one repository, or deployment-wide when `connectionId` is omitted.
 *
 * Deployment-wide it also selects every open pull request of a repository that has bot approval
 * on, armed or not: an approval is withdrawn by re-evaluating, and an approved pull request need
 * not have an armed row. For one repository, `allOpen` selects every open pull request likewise,
 * for a repository whose bot approval was just turned off (its flag no longer says so).
 *
 * Never throws: the caller's own write has already happened, and a sweep that cannot finish must
 * not undo or fail it. A failure is logged without secrets and the next pull request carries on.
 */
export async function sweepArmedPullRequests(
  fastify: Pick<FastifyInstance, 'prisma' | 'temporal'>,
  log: FastifyBaseLogger,
  opts: { allOpen?: boolean; cap: number; connectionId?: string }
): Promise<SweepResult> {
  const result: SweepResult = { failed: 0, found: 0, started: 0, truncated: false };
  const { allOpen, cap, connectionId } = opts;
  const prisma = fastify.prisma;
  if (connectionId) {
    const now = Date.now();
    for (const [id, at] of lastSweepAt) {
      if (now - at >= SWEEP_DEBOUNCE_MS) {
        lastSweepAt.delete(id);
      }
    }
    if (lastSweepAt.has(connectionId)) {
      log.info({ connectionId }, 'pull request disarm sweep skipped: one started a moment ago');
      return { ...result, debounced: true };
    }
  }
  try {
    const candidateLimit = cap * CANDIDATE_FACTOR;
    const candidates = await prisma.prEvaluation.findMany({
      distinct: ['connectionId', 'prNumber'],
      orderBy: { createdAt: 'desc' },
      select: { connectionId: true, prNumber: true },
      take: candidateLimit,
      where: {
        closedAt: null,
        mergedAt: null,
        ...(connectionId ? { connectionId } : {}),
        ...(allOpen
          ? {}
          : connectionId
            ? { OR: [{ autoMergeEnabled: true }, { botApproved: true }] }
            : {
                OR: [
                  { autoMergeEnabled: true },
                  { botApproved: true },
                  { connection: { prEvaluationBotApproval: true } },
                ],
              }),
      },
    });
    if (candidates.length === 0) {
      return result;
    }
    // An armed row says the platform armed it once, and the newest row may be unarmed while GitHub
    // still is; only the pull request's newest row says whether it is still open.
    const latestRows = await prisma.prEvaluation.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        closedAt: true,
        connectionId: true,
        mergedAt: true,
        prNumber: true,
      },
      where: {
        OR: candidates.map((c) => ({ connectionId: c.connectionId, prNumber: c.prNumber })),
      },
    });
    const newest = new Map<string, (typeof latestRows)[number]>();
    for (const row of latestRows) {
      const key = `${row.connectionId}#${row.prNumber}`;
      if (!newest.has(key)) {
        newest.set(key, row);
      }
    }
    const armed = [...newest.values()].filter((row) => !row.closedAt && !row.mergedAt);
    result.truncated = candidates.length >= candidateLimit || armed.length > cap;
    const targets = armed.slice(0, cap);
    result.found = targets.length;
    if (result.truncated) {
      log.warn(
        { cap, connectionId: connectionId ?? null, found: result.found },
        'pull request disarm sweep truncated; the remaining armed pull requests are disarmed when they next change'
      );
    }
    if (connectionId && targets.length > 0) {
      lastSweepAt.set(connectionId, Date.now());
    }
    // One id per sweep: a redelivered start is a no-op, a later sweep is a new evaluation.
    const sweepId = randomBytes(4).toString('hex');
    for (const target of targets) {
      const input: PrEvaluationInput = {
        connectionId: target.connectionId,
        prNumber: target.prNumber,
        trigger: DISARM_SWEEP_TRIGGER,
      };
      try {
        await fastify.temporal.startPrEvaluationWorkflow(
          prEvaluationWorkflowId(target.connectionId, target.prNumber, sweepId),
          input
        );
        result.started += 1;
      } catch (err) {
        result.failed += 1;
        log.error(
          { connectionId: target.connectionId, err, prNumber: target.prNumber },
          'pull request disarm sweep could not start an evaluation (non-fatal)'
        );
      }
    }
  } catch (err) {
    log.error(
      { connectionId: connectionId ?? null, err },
      'pull request disarm sweep failed (non-fatal)'
    );
  }
  return result;
}
