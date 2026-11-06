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
/** One read of a pull request is the pull plus up to 30 pages of files; this bounds all of them. */
const OVERALL_TIMEOUT_MS = 60_000;

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 20;
/** Pull requests whose ETag is remembered; the facts are small, so far more than the file reads. */
const PULL_FACTS_MAX_ENTRIES = 500;
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
  /** Bounds the whole read; replaced in tests. */
  deadlineMs?: number;
  /** Where the platform credential comes from; replaced in tests. */
  target?: (
    repo: PullFilesRepo
  ) => Promise<{ apiUrl: string; token: string } | 'host-not-approved' | null>;
};

type CachedRead = { at: number; read: Promise<PullFilesResult> };
const cache = new Map<string, CachedRead>();

/**
 * What the last full read of a pull request said, with the ETag it came with, so the next read can
 * ask "has it changed" and be answered with a 304, which costs the host's rate limit nothing.
 */
type PullFacts = { etag: string; changedFiles: number | undefined; headSha: string; state: string };
const pullFacts = new Map<string, PullFacts>();

/** Commit pairs already compared; a pair's answer does not change, so only the size is bounded. */
const COMPARE_MAX_ENTRIES = 200;
const compares = new Map<string, Promise<CompareResult>>();

/** Forgets every cached read and ETag. For tests. */
export function resetPullFilesCache(): void {
  cache.clear();
  pullFacts.clear();
  compares.clear();
}

function rememberPullFacts(key: string, facts: PullFacts): void {
  pullFacts.delete(key);
  pullFacts.set(key, facts);
  while (pullFacts.size > PULL_FACTS_MAX_ENTRIES) {
    const oldest = pullFacts.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pullFacts.delete(oldest);
  }
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

type Reply =
  | { ok: true; body: unknown; etag: string | null }
  /** The host answered 304 to a conditional read: what the caller already holds is current. */
  | { ok: true; notModified: true }
  | { ok: false; reason: PullFilesUnavailable };

async function get(
  doFetch: typeof fetch,
  target: { apiUrl: string; token: string },
  path: string,
  options: { deadline: AbortSignal; etag?: string }
): Promise<Reply> {
  try {
    const res = await doFetch(`${target.apiUrl.replace(/\/$/, '')}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.etag !== undefined && { 'If-None-Match': options.etag }),
      },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.deadline]),
    });
    if (res.status === 304 && options.etag !== undefined) {
      return { notModified: true, ok: true };
    }
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
    return { body: await res.json(), etag: res.headers.get('etag'), ok: true };
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
  changedFiles: number | undefined,
  deadline: AbortSignal
): Promise<PullFilesResult> {
  const files: ReviewFile[] = [];
  let listed = 0;
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const reply = await get(
      doFetch,
      target,
      `${repoPath}/pulls/${prNumber}/files?per_page=${PER_PAGE}&page=${page}`,
      { deadline }
    );
    if (!reply.ok) {
      return { reason: reply.reason, type: 'unavailable' };
    }
    if ('notModified' in reply) {
      // Not asked conditionally, so never answered so; treat it as the host misbehaving.
      return { reason: 'failed', type: 'unavailable' };
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

/** What every read of one repository needs: where to ask, as whom, and a fetch that is guarded. */
async function connect(
  repo: PullFilesRepo,
  deps: PullFilesDeps
): Promise<
  | { doFetch: typeof fetch; repoPath: string; target: { apiUrl: string; token: string } }
  | { reason: PullFilesUnavailable }
> {
  if (repo.organizationName === null || repo.repoName === null) {
    return { reason: 'not-found' };
  }
  const target = await (deps.target ?? platformTarget)(repo);
  if (target === 'host-not-approved') {
    return { reason: 'host-not-approved' };
  }
  if (target === null) {
    return { reason: 'no-credential' };
  }
  const doFetch =
    deps.fetchImpl ??
    createGuardedFetch({ allowPrivate: hostFamily(target.apiUrl) !== 'github.com' });
  const repoPath = `/repos/${encodeURIComponent(repo.organizationName)}/${encodeURIComponent(repo.repoName)}`;
  return { doFetch, repoPath, target };
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
  const link = await connect(repo, deps);
  if ('reason' in link) {
    return { reason: link.reason, type: 'unavailable' };
  }
  const { doFetch, repoPath, target } = link;

  const deadline = AbortSignal.timeout(deps.deadlineMs ?? OVERALL_TIMEOUT_MS);

  // The pull request is read on every call, because that is how the current head and state are
  // known; asked with the last ETag, an unchanged one costs a 304 and no rate limit.
  const factsKey = `${repo.id}:${prNumber}`;
  const known = pullFacts.get(factsKey);
  const pull = await get(doFetch, target, `${repoPath}/pulls/${prNumber}`, {
    deadline,
    ...(known !== undefined && { etag: known.etag }),
  });
  if (!pull.ok) {
    return { reason: pull.reason, type: 'unavailable' };
  }
  let head: { changedFiles: number | undefined; sha: string; state: string };
  if ('notModified' in pull) {
    if (known === undefined) {
      return { reason: 'failed', type: 'unavailable' };
    }
    head = { changedFiles: known.changedFiles, sha: known.headSha, state: known.state };
  } else {
    const parsed = PullSchema.safeParse(pull.body);
    if (!parsed.success) {
      return { reason: 'failed', type: 'unavailable' };
    }
    head = {
      changedFiles: parsed.data.changed_files,
      sha: parsed.data.head.sha,
      state: parsed.data.state,
    };
    if (pull.etag !== null) {
      rememberPullFacts(factsKey, {
        changedFiles: head.changedFiles,
        etag: pull.etag,
        headSha: head.sha,
        state: head.state,
      });
    } else {
      pullFacts.delete(factsKey);
    }
  }

  // The files are what is cached; the state is not, since a pull request can close or merge at the
  // head it was read at, and the page must say so now and not in five minutes.
  const withLiveState = (result: PullFilesResult): PullFilesResult =>
    result.type === 'ok' ? { ...result, state: head.state } : result;

  const now = (deps.now ?? Date.now)();
  const key = `${repo.id}:${prNumber}:${head.sha}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.read.then(withLiveState);
  }
  const read = readFiles(
    doFetch,
    target,
    repoPath,
    prNumber,
    head.sha,
    head.state,
    head.changedFiles,
    deadline
  );
  const entry: CachedRead = { at: now, read };
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  // Only a complete, modest read is reused; the next view asks a failed or huge one again. This
  // removes its own entry only: a newer read of the same key may have replaced it since.
  const forgetIfUnusable = () => {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
  };
  void read.then((result) => {
    if (result.type !== 'ok' || patchChars(result) > CACHE_MAX_PATCH_CHARS) {
      forgetIfUnusable();
    }
  }, forgetIfUnusable);
  return read.then(withLiveState);
}

/** The commits of a compare read that are shown; the host returns at most this many per page. */
const COMPARE_PER_PAGE = 100;
const SUBJECT_MAX_CHARS = 200;
/** A commit id as the host spells one, SHA-1 or SHA-256; the only thing put into a compare path. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type CompareCommit = { sha: string; subject: string };

export type CompareResult =
  | {
      type: 'ok';
      /** The earlier head is no longer an ancestor of the later one: the branch was rewritten. */
      rewritten: boolean;
      /** The commits the later head has beyond the common ancestor, oldest first, capped. */
      commits: CompareCommit[];
      totalCommits: number;
    }
  | { type: 'unavailable'; reason: PullFilesUnavailable };

const CompareSchema = z.object({
  commits: z.array(z.object({ commit: z.object({ message: z.string() }), sha: z.string().min(1) })),
  status: z.string(),
  total_commits: z.number().int().nonnegative().optional(),
});

/**
 * What changed between two heads of a pull request, for "since you last looked". A base the host no
 * longer knows, a head that went backwards and a diverged one all read as a rewritten branch, which
 * is the usual result of a force-push. Only a successful answer is kept, per pair of commits.
 */
export async function readCompare(
  repo: PullFilesRepo,
  base: string,
  head: string,
  deps: PullFilesDeps = {}
): Promise<CompareResult> {
  // Both ends go into a URL path; anything but a commit id is refused before the host is asked.
  if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
    return { reason: 'not-found', type: 'unavailable' };
  }
  const link = await connect(repo, deps);
  if ('reason' in link) {
    return { reason: link.reason, type: 'unavailable' };
  }
  const key = `${repo.id}:${base.toLowerCase()}...${head.toLowerCase()}`;
  const hit = compares.get(key);
  if (hit) {
    return hit;
  }
  const read = (async (): Promise<CompareResult> => {
    const reply = await get(
      link.doFetch,
      link.target,
      `${link.repoPath}/compare/${base}...${head}?per_page=${COMPARE_PER_PAGE}`,
      { deadline: AbortSignal.timeout(deps.deadlineMs ?? OVERALL_TIMEOUT_MS) }
    );
    if (!reply.ok) {
      return reply.reason === 'not-found'
        ? { commits: [], rewritten: true, totalCommits: 0, type: 'ok' }
        : { reason: reply.reason, type: 'unavailable' };
    }
    if ('notModified' in reply) {
      return { reason: 'failed', type: 'unavailable' };
    }
    const parsed = CompareSchema.safeParse(reply.body);
    if (!parsed.success) {
      return { reason: 'failed', type: 'unavailable' };
    }
    const { commits, status, total_commits } = parsed.data;
    return {
      commits: commits.map((c) => ({
        sha: c.sha,
        subject: (c.commit.message.split('\n')[0] ?? '').slice(0, SUBJECT_MAX_CHARS),
      })),
      rewritten: status === 'diverged' || status === 'behind',
      totalCommits: total_commits ?? commits.length,
      type: 'ok',
    };
  })();
  compares.set(key, read);
  while (compares.size > COMPARE_MAX_ENTRIES) {
    const oldest = compares.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    compares.delete(oldest);
  }
  // A failed answer is asked again next time; this removes its own entry only.
  const forgetIfFailed = () => {
    if (compares.get(key) === read) {
      compares.delete(key);
    }
  };
  void read.then((result) => {
    if (result.type !== 'ok') {
      forgetIfFailed();
    }
  }, forgetIfFailed);
  return read;
}
