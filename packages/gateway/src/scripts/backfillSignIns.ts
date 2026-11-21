/**
 * Backfill historic sign-ins into `user_activity_events`.
 *
 * Sign-ins recorded before the activity table carried a method exist only as `Session` rows in
 * `config_audit_log` (`afterJson.event = 'sign_in'`, no `method` key). This copies them into the
 * activity table so the people list and overview see them. It is opt-in and never runs at boot:
 *
 *   yarn workspace @auto-swe/gateway backfill:sign-ins -- --dry-run
 *   yarn workspace @auto-swe/gateway backfill:sign-ins
 *   yarn workspace @auto-swe/gateway backfill:sign-ins -- --max-rows 200000
 *
 * Idempotent: an audit row is skipped when the actor already has a `sign_in` event within
 * +-5 s of it, and a backfilled event carries the audit row's own timestamp, so a second run finds
 * every row it wrote and adds nothing. Only rows inside the activity retention window are
 * considered (older events would be deleted by the next sweep). No schema change, Prisma only.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import type { PrismaClient } from '@auto-swe/shared/db';
import { prisma } from '@auto-swe/shared/db';
import { truncateIp } from '../lib/auditContext.js';

export const BATCH_SIZE = 500;
export const DEDUPE_WINDOW_MS = 5000;
export const DEFAULT_MAX_ROWS = 1_000_000;

export interface BackfillOptions {
  dryRun: boolean;
  maxRows: number;
  retentionDays: number;
  now?: Date;
  batchSize?: number;
  log?: (line: string) => void;
}

export interface BackfillResult {
  scanned: number;
  /** Rows that already carry a method, or have no actor: not candidates. */
  ineligible: number;
  alreadyRecorded: number;
  /** Written, or in a dry run, would be written. */
  inserted: number;
  hitMaxRows: boolean;
}

interface AuditRow {
  actorId: string | null;
  afterJson: unknown;
  context: unknown;
  createdAt: Date;
  id: string;
}

type Db = Pick<PrismaClient, 'configAuditLog' | 'userActivityEvent'>;

function auditIp(context: unknown): string | null {
  const ip = context && typeof context === 'object' ? (context as { ip?: unknown }).ip : null;
  return typeof ip === 'string' && ip ? (truncateIp(ip) ?? null) : null;
}

function hasMethodKey(afterJson: unknown): boolean {
  return Boolean(afterJson) && typeof afterJson === 'object' && 'method' in (afterJson as object);
}

export async function runBackfill(db: Db, opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 86_400_000);
  const result: BackfillResult = {
    alreadyRecorded: 0,
    hitMaxRows: false,
    ineligible: 0,
    inserted: 0,
    scanned: 0,
  };
  let cursor: { createdAt: Date; id: string } | null = null;
  const auditWhere = {
    action: 'CREATE' as const,
    afterJson: { equals: 'sign_in', path: ['event'] },
    entityType: 'Session',
  };
  const afterCursor = (c: { createdAt: Date; id: string }) => ({
    OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gt: c.id } }],
  });

  for (;;) {
    const remaining = opts.maxRows - result.scanned;
    if (remaining <= 0) {
      // Reached the cap exactly: it only counts as a stop when a row genuinely remains.
      if (cursor) {
        const more = await db.configAuditLog.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
          take: 1,
          where: { ...auditWhere, ...afterCursor(cursor) },
        });
        result.hitMaxRows = more.length > 0;
      }
      break;
    }
    const rows: AuditRow[] = await db.configAuditLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { actorId: true, afterJson: true, context: true, createdAt: true, id: true },
      take: Math.min(batchSize, remaining),
      where: {
        ...auditWhere,
        ...(cursor ? afterCursor(cursor) : { createdAt: { gte: cutoff } }),
      },
    });
    if (rows.length === 0) {
      break;
    }
    const last = rows[rows.length - 1];
    if (!last) {
      break;
    }
    cursor = { createdAt: last.createdAt, id: last.id };
    result.scanned += rows.length;

    const candidates = rows.filter((r) => {
      const eligible = r.actorId !== null && !hasMethodKey(r.afterJson);
      if (!eligible) {
        result.ineligible++;
      }
      return eligible;
    });

    if (candidates.length > 0) {
      const actorIds: string[] = [...new Set(candidates.map((r) => r.actorId as string))];
      const first = candidates[0]?.createdAt.getTime() ?? 0;
      const lastAt = candidates[candidates.length - 1]?.createdAt.getTime() ?? 0;
      const existing = await db.userActivityEvent.findMany({
        select: { actorId: true, createdAt: true },
        where: {
          actorId: { in: actorIds },
          createdAt: {
            gte: new Date(first - DEDUPE_WINDOW_MS),
            lte: new Date(lastAt + DEDUPE_WINDOW_MS),
          },
          kind: 'sign_in',
        },
      });
      const byActor = new Map<string, number[]>();
      for (const e of existing) {
        if (e.actorId) {
          const list = byActor.get(e.actorId) ?? [];
          list.push(e.createdAt.getTime());
          byActor.set(e.actorId, list);
        }
      }
      const data: Array<Record<string, unknown>> = [];
      for (const r of candidates) {
        const t = r.createdAt.getTime();
        const times = byActor.get(r.actorId as string) ?? [];
        if (times.some((x) => Math.abs(x - t) <= DEDUPE_WINDOW_MS)) {
          result.alreadyRecorded++;
          continue;
        }
        // Later rows of this batch must see this one, so two audit rows a second apart
        // do not both insert.
        times.push(t);
        byActor.set(r.actorId as string, times);
        data.push({
          actorId: r.actorId,
          createdAt: r.createdAt,
          ip: auditIp(r.context),
          kind: 'sign_in',
          method: 'AUTH',
          props: { backfilled: true, method: 'unknown' },
          route: 'auth:unknown',
          via: 'session',
        });
      }
      if (data.length > 0 && !opts.dryRun) {
        await db.userActivityEvent.createMany({ data: data as never });
      }
      result.inserted += data.length;
    }
    log(
      `[backfill] scanned ${result.scanned}, ${opts.dryRun ? 'would insert' : 'inserted'} ${result.inserted}, already recorded ${result.alreadyRecorded}`
    );
    if (rows.length < Math.min(batchSize, remaining)) {
      break;
    }
  }
  return result;
}

export function parseArgs(argv: string[]): { dryRun: boolean; maxRows: number } {
  let dryRun = false;
  let maxRows = DEFAULT_MAX_ROWS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--max-rows') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('--max-rows needs a positive integer');
      }
      maxRows = n;
    } else if (arg !== '--') {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { dryRun, maxRows };
}

async function main(): Promise<void> {
  const { dryRun, maxRows } = parseArgs(process.argv.slice(2));
  const retentionDays = await resolveSetting('analytics.activityRetentionDays', {});
  console.log(
    `[backfill] ${dryRun ? 'dry run: ' : ''}audit sign-ins from the last ${retentionDays} days, max ${maxRows} rows`
  );
  const r = await runBackfill(prisma, { dryRun, maxRows, retentionDays });
  console.log(
    `[backfill] done: scanned ${r.scanned}, ${dryRun ? 'would insert' : 'inserted'} ${r.inserted}, already recorded ${r.alreadyRecorded}, skipped ${r.ineligible} (has a method or no actor)`
  );
  if (r.hitMaxRows) {
    console.warn('[backfill] stopped at --max-rows; run again (or raise it) to continue');
  }
}

if (
  process.argv[1]?.endsWith('backfillSignIns.ts') ||
  process.argv[1]?.endsWith('backfillSignIns.js')
) {
  main()
    .catch((err) => {
      console.error('[backfill] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
