import type { PrismaClient } from '../../index.js';
import {
  resolveSourceSha,
  SKILL_SOURCE_ERRORS,
  type SkillSourceDeps,
  SkillSourceError,
  safeSourceErrorMessage,
} from '../skillSource/index.js';

/**
 * The cheap half of tracked marketplaces, mirroring `skillSourceSync`: ask the host which commit a
 * marketplace's ref names now and record whether that differs from the pinned one. One request per
 * source; it writes only the source's bookkeeping columns and never touches a profile or the pin
 * (moving the pin is an admin's decision). Everything stored or logged is a sha, a status or one of
 * the fixed strings in `SKILL_SOURCE_ERRORS`.
 */

export type MarketplaceCheckInput = Pick<
  NonNullable<Awaited<ReturnType<PrismaClient['marketplaceSource']['findFirst']>>>,
  'host' | 'id' | 'owner' | 'path' | 'pinnedSha' | 'ref' | 'repo'
>;

export interface MarketplaceCheckResult {
  id: string;
  /** `SKIPPED` is a rate-limit answer: status and latestSha stay, only `lastCheckedAt` moves. */
  status: 'OK' | 'UPDATE_AVAILABLE' | 'ERROR' | 'SKIPPED';
  latestSha: string | null;
  error: string | null;
  code: string | null;
  /** False when the row changed under the check (disabled, or the pin moved) and nothing was written. */
  recorded: boolean;
}

export async function checkMarketplaceSource(
  prisma: PrismaClient,
  source: MarketplaceCheckInput,
  deps?: SkillSourceDeps
): Promise<MarketplaceCheckResult> {
  let latestSha: string | null = null;
  let failure: SkillSourceError | null = null;
  try {
    latestSha = await resolveSourceSha(source, deps);
  } catch (err) {
    failure = err instanceof SkillSourceError ? err : new SkillSourceError('NETWORK');
  }
  const rateLimited = failure?.code === 'RATE_LIMIT_LOW' || failure?.code === 'RATE_LIMITED';
  const status = rateLimited
    ? 'SKIPPED'
    : failure
      ? 'ERROR'
      : latestSha === source.pinnedSha
        ? 'OK'
        : 'UPDATE_AVAILABLE';
  const error = failure ? safeSourceErrorMessage(failure) : null;
  let recorded = true;
  try {
    // Guarded on the pin and on not being disabled: an accept or a disable that landed while the
    // host was being asked wins, and this write is dropped.
    await prisma.marketplaceSource.update({
      data: rateLimited
        ? { lastCheckedAt: new Date() }
        : {
            lastCheckedAt: new Date(),
            lastError: error,
            ...(latestSha === null ? {} : { latestSha }),
            status: status as 'OK' | 'UPDATE_AVAILABLE' | 'ERROR',
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

export interface MarketplaceSweepResult {
  checked: number;
  ok: number;
  updateAvailable: number;
  errors: number;
  /** Not recorded: the host's rate limit ran low; the rest of that host's sources wait for the next run. */
  skipped: number;
  sources: Array<{ id: string; status: MarketplaceCheckResult['status']; error: string | null }>;
}

/**
 * Check every marketplace that is not disabled, one at a time. Sequential on purpose: the platform
 * token is shared with every workflow. One failing source (or a database hiccup on its row) neither
 * stops the others nor spends more than the one request a check costs; when a host reports its
 * rate limit is low or spent, the rest of that host's sources are left for the next run.
 */
export async function sweepMarketplaceSources(
  prisma: PrismaClient,
  deps?: SkillSourceDeps
): Promise<MarketplaceSweepResult> {
  const sources = await prisma.marketplaceSource.findMany({
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
  });
  const out: MarketplaceSweepResult = {
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
    let result: MarketplaceCheckResult;
    try {
      result = await checkMarketplaceSource(prisma, source, deps);
    } catch {
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
    if (result.status === 'SKIPPED') {
      out.skipped++;
      out.sources.push({ error: result.error, id: result.id, status: result.status });
      continue;
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
