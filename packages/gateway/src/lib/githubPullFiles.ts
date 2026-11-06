/**
 * A pull request's changed files, read live from its host for the review page. Patches are never
 * stored: a read is held in memory for a few minutes, keyed by the head it was read at.
 *
 * The credential rule is the one the check-run and PR-feedback reads apply: the repository's own
 * API base on an approved host, and a platform credential that never leaves its own host. Every
 * failure is a typed `unavailable` result, so the page degrades to what is stored instead of
 * erroring, and nothing here puts a token, a response body or an error's text in a result.
 */
import { createHash } from 'node:crypto';
import { repositoryHostsAllowed } from '@auto-swe/shared/lib/connectionCredential';
import { resolvePlatformCredential } from '@auto-swe/shared/lib/githubHostCredential';
import { hostFamily, installationTargetFor } from '@auto-swe/shared/lib/githubHostScope';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import type { ChangedFile } from '@auto-swe/shared/lib/prEvaluation';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { z } from 'zod';

/** GitHub lists at most 3000 files of a pull request: 30 pages of 100. */
const MAX_FILE_PAGES = 30;
const PER_PAGE = 100;
/** A patch longer than this is treated as absent, as the evaluator does. */
const MAX_PATCH_CHARS = 200_000;
const REQUEST_TIMEOUT_MS = 15_000;

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 20;
/** A read holding more patch text than this is served but not kept. */
const CACHE_MAX_PATCH_CHARS = 5_000_000;

/** A changed file plus the digest that tells whether its patch is the one a reviewer marked viewed. */
export type ReviewFile = ChangedFile & { patchDigest?: string };

export type PullFilesRepo = {
  githubApiUrl: string | null;
  githubUrl: string | null;
  id: string;
  installation: { host: string; installationId: string } | null;
  organizationName: string | null;
  repoName: string | null;
};

export type PullFilesUnavailable =
  | 'host-not-approved'
  | 'no-credential'
  | 'not-found'
  | 'rate-limited'
  | 'failed';

export type PullFilesResult =
  | {
      type: 'ok';
      /** The head the host reports now; the stored row can lag it. */
      headSha: string;
      /** The host's state for the pull request: `open` or `closed`. */
      state: string;
      files: ReviewFile[];
      /** The host lists more files than were read. */
      truncated: boolean;
    }
  | { type: 'unavailable'; reason: PullFilesUnavailable };

export type PullFilesDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Where the platform credential comes from; replaced in tests. */
  target?: (
    repo: PullFilesRepo
  ) => Promise<{ apiUrl: string; token: string } | 'host-not-approved' | null>;
};

type CachedRead = { at: number; read: Promise<PullFilesResult> };
const cache = new Map<string, CachedRead>();

/** Forgets every cached read. For tests. */
export function resetPullFilesCache(): void {
  cache.clear();
}

async function platformTarget(
  repo: PullFilesRepo
): Promise<{ apiUrl: string; token: string } | 'host-not-approved' | null> {
  const ghConfig = await resolveGitHubConfig();
  const hosts = await repositoryHostsAllowed({
    githubApiUrl: repo.githubApiUrl,
    githubUrl: repo.githubUrl,
  });
  if (!hosts.ok) {
    return 'host-not-approved';
  }
  const scoped = {
    apiUrl: repo.githubApiUrl,
    baseUrl: repo.githubUrl,
    installationHost: repo.installation?.host ?? null,
    installationId: repo.installation?.installationId ?? null,
    organizationName: repo.organizationName,
    repoName: repo.repoName,
  };
  try {
    const credential = await resolvePlatformCredential(scoped, ghConfig);
    if (credential.scope !== 'instance' && credential.scope !== 'host') {
      return null;
    }
    const target = installationTargetFor(scoped, credential.config);
    const token = await resolveGitHubToken(credential.config, target);
    return { apiUrl: target.apiUrl, token };
  } catch {
    return null;
  }
}

const PullSchema = z.object({
  changed_files: z.number().int().nonnegative().optional(),
  head: z.object({ sha: z.string().min(1) }),
  state: z.string(),
});

const FileSchema = z.object({
  additions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative(),
  filename: z.string().min(1),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
  status: z.string(),
});

function toReviewFile(f: z.infer<typeof FileSchema>): ReviewFile {
  // `copied`, `changed` and `unchanged` become `modified`, as the evaluator maps them.
  const status: ChangedFile['status'] =
    f.status === 'added' || f.status === 'removed' || f.status === 'renamed'
      ? f.status
      : 'modified';
  const patch = f.patch !== undefined && f.patch.length <= MAX_PATCH_CHARS ? f.patch : undefined;
  const pureRename =
    status === 'renamed' && f.additions === 0 && f.deletions === 0 && (f.changes ?? 0) === 0;
  return {
    additions: f.additions,
    deletions: f.deletions,
    path: f.filename,
    status,
    ...(f.previous_filename !== undefined && { previousPath: f.previous_filename }),
    ...(pureRename && { similarity: 100 }),
    ...(patch !== undefined && {
      patch,
      patchDigest: createHash('sha256').update(patch).digest('hex'),
    }),
  };
}

type Reply = { ok: true; body: unknown } | { ok: false; reason: PullFilesUnavailable };

async function get(
  doFetch: typeof fetch,
  target: { apiUrl: string; token: string },
  path: string
): Promise<Reply> {
  try {
    const res = await doFetch(`${target.apiUrl.replace(/\/$/, '')}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) {
      return { ok: false, reason: 'not-found' };
    }
    if (
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
    ) {
      return { ok: false, reason: 'rate-limited' };
    }
    if (!res.ok) {
      return { ok: false, reason: 'failed' };
    }
    return { body: await res.json(), ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

async function readFiles(
  doFetch: typeof fetch,
  target: { apiUrl: string; token: string },
  repoPath: string,
  prNumber: number,
  headSha: string,
  state: string,
  changedFiles: number | undefined
): Promise<PullFilesResult> {
  const files: ReviewFile[] = [];
  let listed = 0;
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const reply = await get(
      doFetch,
      target,
      `${repoPath}/pulls/${prNumber}/files?per_page=${PER_PAGE}&page=${page}`
    );
    if (!reply.ok) {
      return { reason: reply.reason, type: 'unavailable' };
    }
    const parsed = z.array(FileSchema).safeParse(reply.body);
    if (!parsed.success) {
      return { reason: 'failed', type: 'unavailable' };
    }
    listed += parsed.data.length;
    files.push(...parsed.data.map(toReviewFile));
    if (parsed.data.length < PER_PAGE) {
      break;
    }
  }
  // The host's own count says whether the listing stopped short; without one, a full last page does.
  const truncated =
    changedFiles !== undefined ? listed < changedFiles : listed >= MAX_FILE_PAGES * PER_PAGE;
  return { files, headSha, state, truncated, type: 'ok' };
}

function patchChars(result: PullFilesResult): number {
  return result.type === 'ok'
    ? result.files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0)
    : 0;
}

/**
 * The files of one pull request at the head the host reports now. The caller has already decided
 * the user may see this repository; this function never does.
 */
export async function readPullFiles(
  repo: PullFilesRepo,
  prNumber: number,
  deps: PullFilesDeps = {}
): Promise<PullFilesResult> {
  if (repo.organizationName === null || repo.repoName === null) {
    return { reason: 'not-found', type: 'unavailable' };
  }
  const target = await (deps.target ?? platformTarget)(repo);
  if (target === 'host-not-approved') {
    return { reason: 'host-not-approved', type: 'unavailable' };
  }
  if (target === null) {
    return { reason: 'no-credential', type: 'unavailable' };
  }
  const doFetch =
    deps.fetchImpl ??
    createGuardedFetch({ allowPrivate: hostFamily(target.apiUrl) !== 'github.com' });
  const repoPath = `/repos/${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}`;

  const pull = await get(doFetch, target, `${repoPath}/pulls/${prNumber}`);
  if (!pull.ok) {
    return { reason: pull.reason, type: 'unavailable' };
  }
  const head = PullSchema.safeParse(pull.body);
  if (!head.success) {
    return { reason: 'failed', type: 'unavailable' };
  }

  const now = (deps.now ?? Date.now)();
  const key = `${repo.id}:${prNumber}:${head.data.head.sha}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.read;
  }
  const read = readFiles(
    doFetch,
    target,
    repoPath,
    prNumber,
    head.data.head.sha,
    head.data.state,
    head.data.changed_files
  );
  cache.set(key, { at: now, read });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  // Only a complete, modest read is reused; the next view asks a failed or huge one again.
  void read.then(
    (result) => {
      if (result.type !== 'ok' || patchChars(result) > CACHE_MAX_PATCH_CHARS) {
        cache.delete(key);
      }
    },
    () => cache.delete(key)
  );
  return read;
}
