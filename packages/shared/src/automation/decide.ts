import type { Prisma } from '../generated/prisma/client.js';
import { ACTIVE_WORKFLOW_TERMINAL_STATUSES } from '../types/api.js';
import { isRepositoryOwnerKey } from './ownerKey.js';
import type { AutomationOutcome, EventSource } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
function ownerLockKey(ownerKey: string): string {
  return isRepositoryOwnerKey(ownerKey)
    ? `automation-repo:${ownerKey}`
    : `automation-owner:${ownerKey}`;
}

export async function decideUnderLock<F, X>(
  tx: Prisma.TransactionClient,
  scope: {
    automation: { id: string; cooldownMinutes: number; maxRunsPerDay: number };
    ownerKey: string;
  },
  source: Pick<
    EventSource<F, X>,
    'inFlightAlsoFrom' | 'inFlightLookbackMs' | 'key' | 'ownOutputFrom'
  >,
  keys: { scope: string; subject: string },
  now: Date,
  /** Whether Temporal says an execution is over. Throws when Temporal cannot say. */
  isWorkflowGone: (temporalWorkflowId: string) => Promise<boolean>
): Promise<{ outcome: AutomationOutcome; reason: string } | null> {
  const { automation, ownerKey } = scope;
  // CLAUDE.md §7 exception: a transaction-scoped advisory lock serialises one owner's
  // decisions; Prisma has no way to express it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLockKey(ownerKey)}, 0))`;

  // Something a run of the platform produced (a pushed fix commit): acting on it would only
  // answer the platform's own output with more of it. On a repository, matched by the subject
  // alone (a commit sha names one commit wherever it is), so a repository renamed since still
  // recognises it; on any other owner, within that owner.
  if (
    await tx.automationFire.findFirst({
      where: {
        producedKey: keys.subject,
        // The source's own output, plus the output of any source it names as its own (a
        // feedback run's pushed commit must not be triaged as a new failure either).
        source: { in: [source.key, ...(source.ownOutputFrom ?? [])] },
        ...(isRepositoryOwnerKey(ownerKey) ? {} : { ownerKey }),
      },
    })
  ) {
    return {
      outcome: 'SUPPRESSED_OWN_OUTPUT',
      reason: 'it is the platform’s own output (a fix it pushed); it is not acted on again',
    };
  }
  // Every other guard counts only this source's decisions on this owner: another source's
  // subjects and scopes are other things, whatever their keys look like.
  const startedOnRepo = { outcome: 'STARTED', ownerKey, source: source.key } as const;
  if (
    await tx.automationFire.findFirst({ where: { ...startedOnRepo, subjectKey: keys.subject } })
  ) {
    return {
      outcome: 'SUPPRESSED_SAME_SUBJECT',
      reason: 'a run was already started for this (another occurrence of it, or a re-run)',
    };
  }
  if (automation.cooldownMinutes > 0) {
    const since = new Date(now.getTime() - automation.cooldownMinutes * 60_000);
    const recent = await tx.automationFire.findFirst({
      where: { ...startedOnRepo, createdAt: { gte: since }, scopeKey: keys.scope },
    });
    if (recent) {
      return {
        outcome: 'SUPPRESSED_COOLDOWN',
        reason: `a run started for ${keys.scope} within the last ${automation.cooldownMinutes} minutes`,
      };
    }
  }
  const earlier = await tx.automationFire.findMany({
    select: { temporalWorkflowId: true },
    where: {
      ...startedOnRepo,
      createdAt: { gte: new Date(now.getTime() - source.inFlightLookbackMs) },
      scopeKey: keys.scope,
      // A run another source started on the same scope (a Jira ticket both Jira sources watch)
      // is as open a run on it as this source's own.
      source: { in: [source.key, ...(source.inFlightAlsoFrom ?? [])] },
      temporalWorkflowId: { not: null },
    },
  });
  const ids = earlier.map((f) => f.temporalWorkflowId as string);
  if (ids.length > 0) {
    const open = await tx.activeWorkflow.findMany({
      select: { temporalWorkflowId: true },
      where: {
        currentStatus: { notIn: [...ACTIVE_WORKFLOW_TERMINAL_STATUSES] },
        temporalWorkflowId: { in: ids },
      },
    });
    for (const row of open) {
      // The ledger row is not the truth: an execution terminated before it finalized never
      // closes its row. Temporal decides; a Temporal that cannot answer counts as running.
      const gone = await isWorkflowGone(row.temporalWorkflowId).catch(() => false);
      if (!gone) {
        return {
          outcome: 'SUPPRESSED_IN_FLIGHT',
          reason: `an earlier run for ${keys.scope} is still in progress`,
        };
      }
    }
  }
  const today = await tx.automationFire.count({
    where: {
      automationId: automation.id,
      createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      outcome: 'STARTED',
    },
  });
  if (today >= automation.maxRunsPerDay) {
    return {
      outcome: 'SUPPRESSED_DAILY_CAP',
      reason: `the automation started ${today} runs in the last 24 hours (cap ${automation.maxRunsPerDay})`,
    };
  }
  return null;
}
