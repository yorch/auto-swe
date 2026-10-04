import type { PrismaClient } from '../index.js';
import {
  resolveSourceSha,
  SKILL_SOURCE_ERRORS,
  type SkillSourceDeps,
  SkillSourceError,
  safeSourceErrorMessage,
} from './skillSource/index.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * The cheap half of tracked updates: ask the host which commit a source's ref
 * names now and record whether that differs from the pinned one.
 *
 * It resolves the ref to a sha and nothing else — no tree, no blobs — and it
 * writes only the source's own bookkeeping columns (`latestSha`, `status`,
 * `lastError`, `lastCheckedAt`). It never touches a skill or a revision: moving
 * the pin is an admin's decision, taken after reading the diff.
 *
 * Both the scheduled sweep and the admin's "check now" run this one function.
 * Everything that reaches the database or a log is a sha, a status or one of the
 * fixed strings in `SKILL_SOURCE_ERRORS` — never provider or fetch text.
 */

export type SourceCheckInput = Pick<
  NonNullable<Awaited<ReturnType<PrismaClient['skillSource']['findFirst']>>>,
  'host' | 'id' | 'owner' | 'path' | 'pinnedSha' | 'ref' | 'repo'
>;

export interface SourceCheckResult {
  id: string;
  status: 'OK' | 'UPDATE_AVAILABLE' | 'ERROR';
  latestSha: string | null;
  /** One of the fixed strings; null unless `status` is `ERROR`. */
  error: string | null;
  /** The error code, so a caller can tell a rate limit from a broken source. */
  code: string | null;
  /** False when the row changed under the check (disabled, or accepted) and nothing was written. */
  recorded: boolean;
}

export async function checkSkillSource(
  prisma: PrismaClient,
  source: SourceCheckInput,
  deps?: SkillSourceDeps
): Promise<SourceCheckResult> {
  let latestSha: string | null = null;
  let failure: SkillSourceError | null = null;
  try {
    latestSha = await resolveSourceSha(source, deps);
  } catch (err) {
    // Anything that is not already a fixed-vocabulary failure is the generic one.
    failure = err instanceof SkillSourceError ? err : new SkillSourceError('NETWORK');
  }
  const status = failure ? 'ERROR' : latestSha === source.pinnedSha ? 'OK' : 'UPDATE_AVAILABLE';
  const error = failure ? safeSourceErrorMessage(failure) : null;
  let recorded = true;
  try {
    // Guarded on the pin and on not being disabled: an accept or a disable that
    // landed while the host was being asked wins, and this write is dropped.
    await prisma.skillSource.update({
      data: {
        lastCheckedAt: new Date(),
        lastError: error,
        // A failed check keeps the last sha it did learn.
        ...(latestSha === null ? {} : { latestSha }),
        status,
      },
      where: { id: source.id, pinnedSha: source.pinnedSha, status: { not: 'DISABLED' } },
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'P2025') {
      throw err;
    }
    recorded = false;
  }
  return {
    code: failure?.code ?? null,
    error,
    id: source.id,
    latestSha: latestSha ?? null,
    recorded,
    status,
  };
}

export interface SourceSweepResult {
  checked: number;
  ok: number;
  updateAvailable: number;
  errors: number;
  /** Not asked at all: the host's rate limit ran low, so its remaining sources wait for the next run. */
  skipped: number;
  /** Per source: ids, statuses and fixed strings only. */
  sources: Array<{ id: string; status: SourceCheckResult['status']; error: string | null }>;
}

/**
 * Check every source that is not disabled, one at a time. Sequential on purpose:
 * the platform token is shared with every workflow, and one failing source (or a
 * database hiccup on its row) must neither stop the others nor spend more than
 * the one request a check costs. When a host reports its rate limit is low or
 * spent, the rest of that host's sources are left for the next run.
 */
export async function sweepSkillSources(
  prisma: PrismaClient,
  deps?: SkillSourceDeps
): Promise<SourceSweepResult> {
  const sources = await runUnscoped('skill-source sweep spans every tenant', ['SkillSource'], () =>
    prisma.skillSource.findMany({
      orderBy: [{ host: 'asc' }, { lastCheckedAt: { nulls: 'first', sort: 'asc' } }],
      select: {
        host: true,
        id: true,
        owner: true,
        path: true,
        pinnedSha: true,
        ref: true,
        repo: true,
      },
      where: { status: { not: 'DISABLED' } },
    })
  );
  const out: SourceSweepResult = {
    checked: 0,
    errors: 0,
    ok: 0,
    skipped: 0,
    sources: [],
    updateAvailable: 0,
  };
  const limitedHosts = new Set<string>();
  for (const source of sources) {
    if (limitedHosts.has(source.host)) {
      out.skipped++;
      continue;
    }
    let result: SourceCheckResult;
    try {
      result = await checkSkillSource(prisma, source, deps);
    } catch {
      // The row could not be written; the next run asks again.
      result = {
        code: 'NETWORK',
        error: SKILL_SOURCE_ERRORS.NETWORK,
        id: source.id,
        latestSha: null,
        recorded: false,
        status: 'ERROR',
      };
    }
    if (result.code === 'RATE_LIMIT_LOW' || result.code === 'RATE_LIMITED') {
      limitedHosts.add(source.host);
    }
    out.checked++;
    if (result.status === 'OK') {
      out.ok++;
    } else if (result.status === 'UPDATE_AVAILABLE') {
      out.updateAvailable++;
    } else {
      out.errors++;
    }
    out.sources.push({ error: result.error, id: result.id, status: result.status });
  }
  return out;
}
