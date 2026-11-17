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
  /**
   * What the host said. `SKIPPED` is a rate-limit answer: the source's status and
   * latestSha are left as they were (only `lastCheckedAt` moves), because the host
   * being busy says nothing about the source.
   */
  status: 'OK' | 'UPDATE_AVAILABLE' | 'ERROR' | 'SKIPPED';
  latestSha: string | null;
  /** One of the fixed strings; null unless `status` is `ERROR` or `SKIPPED`. */
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
    // Guarded on the pin and on not being disabled: an accept or a disable that
    // landed while the host was being asked wins, and this write is dropped.
    await prisma.skillSource.update({
      data: rateLimited
        ? { lastCheckedAt: new Date() }
        : {
            lastCheckedAt: new Date(),
            lastError: error,
            // A failed check keeps the last sha it did learn.
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

export interface SourceSweepResult {
  checked: number;
  ok: number;
  updateAvailable: number;
  errors: number;
  /** Not recorded: the host's rate limit ran low (this source's answer, and the rest of the host's sources, wait for the next run). */
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

// ── Harness profiles ──
//
// A harness profile tracks its ref the same way a skill source does: one request resolves the
// ref to a commit, and the answer lands in the profile's own bookkeeping columns. Nothing about
// the stored snapshot changes; an admin reads the diff and accepts.

export interface ProfileCheckInput {
  id: string;
  host: string;
  owner: string;
  path: string;
  ref: string;
  repo: string;
  /** The commit of the profile's latest version. */
  pinnedSha: string;
  /** The profile's `latestVersion` when the input was read; an accept in between drops the write. */
  latestVersion: number;
}

export interface ProfileCheckResult {
  id: string;
  status: SourceCheckResult['status'];
  latestSha: string | null;
  error: string | null;
  code: string | null;
  recorded: boolean;
}

/**
 * Resolve a profile's ref and record `latestSha`, `trackStatus`, `lastError` and `lastCheckedAt`.
 * A rate-limit answer only moves `lastCheckedAt`. Every stored string is a sha, a status or a
 * fixed string from `SKILL_SOURCE_ERRORS`.
 */
export async function checkHarnessProfile(
  prisma: PrismaClient,
  profile: ProfileCheckInput,
  deps?: SkillSourceDeps
): Promise<ProfileCheckResult> {
  let latestSha: string | null = null;
  let failure: SkillSourceError | null = null;
  try {
    latestSha = await resolveSourceSha(profile, deps);
  } catch (err) {
    failure = err instanceof SkillSourceError ? err : new SkillSourceError('NETWORK');
  }
  const rateLimited = failure?.code === 'RATE_LIMIT_LOW' || failure?.code === 'RATE_LIMITED';
  const status = rateLimited
    ? 'SKIPPED'
    : failure
      ? 'ERROR'
      : latestSha === profile.pinnedSha
        ? 'OK'
        : 'UPDATE_AVAILABLE';
  const error = failure ? safeSourceErrorMessage(failure) : null;
  let recorded = true;
  try {
    await prisma.harnessProfile.update({
      data: rateLimited
        ? { lastCheckedAt: new Date() }
        : {
            lastCheckedAt: new Date(),
            lastError: error,
            ...(latestSha === null ? {} : { latestSha }),
            trackStatus: status as 'OK' | 'UPDATE_AVAILABLE' | 'ERROR',
          },
      where: { id: profile.id, latestVersion: profile.latestVersion, status: { not: 'DISABLED' } },
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'P2025') {
      throw err;
    }
    recorded = false;
  }
  return { code: failure?.code ?? null, error, id: profile.id, latestSha, recorded, status };
}

export interface ProfileSweepResult {
  checked: number;
  ok: number;
  updateAvailable: number;
  errors: number;
  skipped: number;
  profiles: Array<{ id: string; status: ProfileCheckResult['status']; error: string | null }>;
}

/**
 * Check every profile that is not disabled, one at a time, like {@link sweepSkillSources}: one
 * request each, a failing profile never stops the others, and a host whose rate limit runs low
 * keeps the rest of its profiles for the next run.
 */
export async function sweepHarnessProfiles(
  prisma: PrismaClient,
  deps?: SkillSourceDeps
): Promise<ProfileSweepResult> {
  const rows = await prisma.harnessProfile.findMany({
    orderBy: [{ host: 'asc' }, { lastCheckedAt: { nulls: 'first', sort: 'asc' } }],
    select: {
      host: true,
      id: true,
      latestVersion: true,
      owner: true,
      path: true,
      ref: true,
      repo: true,
      versions: { select: { commitSha: true, version: true } },
    },
    where: { status: { not: 'DISABLED' } },
  });
  const out: ProfileSweepResult = {
    checked: 0,
    errors: 0,
    ok: 0,
    profiles: [],
    skipped: 0,
    updateAvailable: 0,
  };
  const limitedHosts = new Set<string>();
  for (const row of rows) {
    const pinned = row.versions.find((v) => v.version === row.latestVersion);
    if (!pinned || limitedHosts.has(row.host)) {
      out.skipped++;
      continue;
    }
    let result: ProfileCheckResult;
    try {
      result = await checkHarnessProfile(
        prisma,
        {
          host: row.host,
          id: row.id,
          latestVersion: row.latestVersion,
          owner: row.owner,
          path: row.path,
          pinnedSha: pinned.commitSha,
          ref: row.ref,
          repo: row.repo,
        },
        deps
      );
    } catch {
      result = {
        code: 'NETWORK',
        error: SKILL_SOURCE_ERRORS.NETWORK,
        id: row.id,
        latestSha: null,
        recorded: false,
        status: 'ERROR',
      };
    }
    if (result.code === 'RATE_LIMIT_LOW' || result.code === 'RATE_LIMITED') {
      limitedHosts.add(row.host);
    }
    if (result.status === 'SKIPPED') {
      out.skipped++;
      out.profiles.push({ error: result.error, id: result.id, status: result.status });
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
    out.profiles.push({ error: result.error, id: result.id, status: result.status });
  }
  return out;
}
