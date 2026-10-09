/**
 * The decision ledger's rows for the automations that keep their own storage: a schedule's
 * fire and a template webhook's call (docs/automations.md §5). Event automations write their
 * own rows in the gateway's engine; these are written where those kinds decide, so the
 * Automations page can say what came of each, not only when it happened.
 *
 * The guards of event sources read only their own source's rows, so nothing here can suppress
 * an event automation. Best-effort: recording never fails the fire or the call it describes.
 */
import type { Prisma, PrismaClient } from '../index.js';

/** The `source` of a schedule fire's row; its subject and scope are the schedule's id. */
export const SCHEDULE_FIRE_SOURCE = 'schedule.fire';
/** The `source` of a template webhook call's row; its subject and scope are the template's id. */
export const TEMPLATE_WEBHOOK_SOURCE = 'template_webhook.call';

export interface AutomationActivity {
  source: typeof SCHEDULE_FIRE_SOURCE | typeof TEMPLATE_WEBHOOK_SOURCE;
  /** The schedule's or the template's id. */
  ownerId: string;
  /** One of `AUTOMATION_OUTCOMES`. */
  outcome: string;
  reason?: string | null;
  connectionId?: string | null;
  temporalWorkflowId?: string | null;
  workRequestId?: string | null;
  /**
   * What makes the row unique. A run that started is keyed by its workflow id, so a retried
   * activity records it once; a refusal by its reason and hour (`refusalKey`), so a per-minute
   * cron or a caller hammering a webhook leaves one row an hour per reason, not one per call.
   */
  key: string;
  facts?: Record<string, string | number | null>;
}

/** The key of a refusal: one row per owner, reason and hour. */
export function refusalKey(source: string, ownerId: string, reason: string, now: Date): string {
  return `${source}:${ownerId}:${reason}:${now.toISOString().slice(0, 13)}`;
}

/** Record one decision; a second one under the same key is not recorded again. Never throws. */
export async function recordAutomationActivity(
  prisma: Pick<PrismaClient, 'automationFire'>,
  a: AutomationActivity,
  onError: (err: unknown) => void = () => {}
): Promise<void> {
  try {
    await prisma.automationFire.create({
      data: {
        connectionId: a.connectionId ?? null,
        dedupeKey: a.key.slice(0, 500),
        facts: a.facts ?? {},
        outcome: a.outcome,
        reason: a.reason ? a.reason.slice(0, 500) : null,
        // Not a repository decision: these rows are read by owner, never by repository.
        repoKey: '',
        scopeKey: a.ownerId,
        source: a.source,
        subjectKey: a.ownerId,
        temporalWorkflowId: a.temporalWorkflowId ?? null,
        workRequestId: a.workRequestId ?? null,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') {
      onError(err);
    }
  }
}

/** The newest decision of an owner, as the dashboard shows it. */
export interface LatestActivity {
  at: Date;
  outcome: string;
  reason: string | null;
}

/**
 * The newest decision of each owner, in two bounded queries (the newest time per owner, then
 * those rows): a nested `take` or a query per owner would read every owner's whole history.
 * `where` narrows the rows a caller may see.
 */
export async function latestActivity(
  prisma: Pick<PrismaClient, 'automationFire'>,
  source: AutomationActivity['source'],
  ownerIds: string[],
  where: Prisma.AutomationFireWhereInput = {}
): Promise<Map<string, LatestActivity>> {
  const latest = new Map<string, LatestActivity>();
  if (ownerIds.length === 0) {
    return latest;
  }
  const scope: Prisma.AutomationFireWhereInput = {
    AND: [where, { source, subjectKey: { in: ownerIds } }],
  };
  const heads = await prisma.automationFire.groupBy({
    _max: { createdAt: true },
    by: ['subjectKey'],
    where: scope,
  });
  const keys = heads.flatMap((h) =>
    h._max.createdAt ? [{ createdAt: h._max.createdAt, subjectKey: h.subjectKey }] : []
  );
  if (keys.length === 0) {
    return latest;
  }
  const rows = await prisma.automationFire.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true, outcome: true, reason: true, subjectKey: true },
    where: { AND: [scope, { OR: keys }] },
  });
  for (const r of rows) {
    if (!latest.has(r.subjectKey)) {
      latest.set(r.subjectKey, { at: r.createdAt, outcome: r.outcome, reason: r.reason });
    }
  }
  return latest;
}
