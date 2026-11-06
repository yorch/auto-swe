import crypto from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, getArtifact, putArtifact } from '@auto-swe/shared/lib/artifactStore';
import {
  DEFAULT_SETUP_STEP_TIMEOUT_SECONDS,
  REPO_SETUP_FILE,
  REPO_SETUP_FILE_MAX_BYTES,
  type RepoSetup,
  type RepoSetupSource,
  resolveRepoSetup,
} from '@auto-swe/shared/lib/repoSetup';
import { resolveStorageConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import { currentRequestContext } from './config/contextLookup.js';
import type { CapturedResult } from './execUtils.js';
import { shellQuote } from './shellQuote.js';

/** The failure type a workspace whose setup could not complete fails with. */
export const WORKSPACE_SETUP_FAILED = 'WORKSPACE_SETUP_FAILED';

/** The artifact kind a dependency cache tarball is stored under. */
export const SETUP_CACHE_ARTIFACT_KIND = 'workspace-setup-cache';

/** A cache unused for this long is swept with its tarball. */
export const SETUP_CACHE_RETENTION_DAYS = 14;

const REPO_DIR = '/workspace/target-repo';
const CACHE_ARCHIVE = '/workspace/.auto-swe/setup-cache.tgz';
const MAX_SUBMODULES = 25;
const MAX_SUBMODULE_DEPTH = 3;
const SUBMODULE_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 2000;

/** A non-retryable failure: the definition, not the moment, is wrong. */
export function setupConfigFailure(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(`workspace setup: ${message}`, WORKSPACE_SETUP_FAILED);
}

/** A retryable failure: a step can fail on a registry hiccup and pass on the next attempt. */
function setupRunFailure(message: string): ApplicationFailure {
  return ApplicationFailure.retryable(`workspace setup: ${message}`, WORKSPACE_SETUP_FAILED);
}

/** What `createWorkspace` hands the setup: its execs, bound to one container. */
export interface RepoSetupHost {
  /** Provisioning exec as the workspace user, outside the checkout; throws on a non-zero exit. */
  root(command: string, timeoutMs?: number): Promise<string>;
  /** Exec in the checkout as the workspace user, without throwing on a non-zero exit. */
  capture(
    command: string,
    opts: { env?: string[]; maxOutputBytes?: number; timeoutMs: number }
  ): Promise<CapturedResult>;
  /** A hardened git call in `dir`, with `authHeader` (when given) injected for this call only. */
  git(dir: string, subcommand: string, authHeader?: string, timeoutMs?: number): Promise<string>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  stdin(command: string, body: Buffer): Promise<void>;
  /**
   * A credential minted for one same-host repository: its clean clone URL and the per-call
   * header. Throws when the platform cannot mint one for it.
   */
  mintCredential(
    organizationName: string,
    repoName: string
  ): Promise<{ cleanUrl: string; authHeader?: string }>;
  /** Scrubs known secrets out of text that may be shown or logged. */
  redact(text: string): string;
}

export interface RepoSetupReport {
  source: RepoSetupSource;
  submodules: number;
  lfs: boolean;
  cache: 'off' | 'hit' | 'miss' | 'saved' | 'too-large' | 'error';
  steps: Array<{ name: string; durationMs: number }>;
  durationMs: number;
}

export interface RepoSetupInputs {
  /** The repository's `Connection.setup`; null/undefined reads the file. */
  field: unknown;
  detectedStack?: unknown;
  teamId: string | null;
  /** The commit the definition is read from: the base the workspace was cut from, or the pin. */
  baseRef: string;
  cleanUrl: string;
  gitHost: string | null;
  image: string;
}

async function stackDefaultsEnabled(teamId: string | null): Promise<boolean> {
  const ctx = await currentRequestContext();
  let orgId = ctx.orgId;
  if (orgId === undefined && teamId) {
    const team = await prisma.team.findUnique({ select: { orgId: true }, where: { id: teamId } });
    orgId = team?.orgId ?? undefined;
  }
  return resolveSetting('workspace.repoSetupStackDefaults', {
    ...ctx,
    ...(orgId ? { orgId } : {}),
    ...(teamId ? { teamId } : {}),
  });
}

/** The text of `.auto-swe/setup.yml` at `ref`, or null when the commit has none. */
export async function readSetupFile(host: RepoSetupHost, ref: string): Promise<string | null> {
  const spec = shellQuote(`${ref}:${REPO_SETUP_FILE}`);
  const result = await host.capture(
    `if git cat-file -e ${spec} 2>/dev/null; then git cat-file blob ${spec}; else exit 3; fi`,
    { maxOutputBytes: REPO_SETUP_FILE_MAX_BYTES + 1, timeoutMs: 60_000 }
  );
  if (result.exitCode === 3) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw setupRunFailure(`could not read ${REPO_SETUP_FILE}: ${tail(host, result)}`);
  }
  return result.stdout;
}

/** Resolve the definition a workspace runs, or null when there is none. */
export async function resolveWorkspaceSetup(
  host: RepoSetupHost,
  inputs: RepoSetupInputs
): Promise<{ setup: RepoSetup; source: RepoSetupSource } | null> {
  const hasField = inputs.field !== null && inputs.field !== undefined;
  const fileText = hasField ? null : await readSetupFile(host, inputs.baseRef);
  const stackDefaults =
    !hasField && fileText === null ? await stackDefaultsEnabled(inputs.teamId) : false;
  const resolved = resolveRepoSetup({
    detectedStack: inputs.detectedStack,
    fileText,
    repositoryField: inputs.field,
    stackDefaults,
  });
  if (!resolved.ok) {
    throw setupConfigFailure(resolved.error);
  }
  return resolved.resolved.source === null
    ? null
    : { setup: resolved.resolved.setup, source: resolved.resolved.source };
}

function tail(host: RepoSetupHost, result: CapturedResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return host.redact(text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text);
}

/** Path inside a superproject: relative, plain characters, no `.`/`..` segments. */
const SUBMODULE_PATH_RE = /^[A-Za-z0-9_@+.][A-Za-z0-9_@+\-./]*$/;

/**
 * The `owner/repo` a submodule URL names on `gitHost`, or a reason it is refused. Relative URLs
 * resolve against the superproject's URL; `git@host:owner/repo` is read as the same repository
 * over HTTPS. Anything on another host, another scheme or another shape is refused: its
 * credential would be minted for, and sent to, somewhere the platform does not vouch for.
 */
export function submoduleRepo(
  rawUrl: string,
  parentCleanUrl: string,
  gitHost: string | null
): { organizationName: string; repoName: string } | { error: string } {
  let url: URL;
  try {
    const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(rawUrl);
    if (scp) {
      url = new URL(`https://${scp[1]}/${scp[2]}`);
    } else if (rawUrl.startsWith('./') || rawUrl.startsWith('../')) {
      url = new URL(rawUrl, `${parentCleanUrl.replace(/\/+$/, '')}/`);
    } else {
      url = new URL(rawUrl);
    }
  } catch {
    return { error: 'is not a URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'ssh:' && !rawUrl.startsWith('.'))) {
    return { error: `uses ${url.protocol} (only https, ssh or a relative URL)` };
  }
  if (!gitHost || url.host.toLowerCase() !== gitHost.toLowerCase()) {
    return { error: `is on ${url.host}, not the repository's host` };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: 'carries credentials, a query or a fragment' };
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const [organizationName, rawRepo] = parts;
  const repoName = rawRepo?.replace(/\.git$/, '');
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (parts.length !== 2 || !organizationName || !repoName) {
    return { error: 'does not name an owner/repository' };
  }
  if (!segment.test(organizationName) || !segment.test(repoName)) {
    return { error: 'does not name an owner/repository' };
  }
  return { organizationName, repoName };
}

/** Parse `git config -f .gitmodules --null --get-regexp` output into name → path/url. */
export function parseGitmodules(
  output: string
): Array<{ name: string; path?: string; url?: string }> {
  const byName = new Map<string, { name: string; path?: string; url?: string }>();
  for (const record of output.split('\0')) {
    const nl = record.indexOf('\n');
    if (nl < 0) {
      continue;
    }
    const key = record.slice(0, nl);
    const value = record.slice(nl + 1);
    const m = /^submodule\.(.+)\.(path|url)$/.exec(key);
    if (!m?.[1] || !m[2]) {
      continue;
    }
    const entry = byName.get(m[1]) ?? { name: m[1] };
    entry[m[2] as 'path' | 'url'] = value;
    byName.set(m[1], entry);
  }
  return [...byName.values()];
}

/**
 * Fetch the submodules the definition asks for, shallow, each with a credential minted for its
 * own repository. The URL each one is fetched from is pinned in `.git/config` before the fetch,
 * so nothing in `.gitmodules` but the validated URL is followed, and its `update` mode is pinned
 * to `checkout`. Returns how many were fetched.
 */
export async function fetchSubmodules(
  host: RepoSetupHost,
  mode: true | 'recursive',
  cleanUrl: string,
  gitHost: string | null
): Promise<number> {
  const queue = [{ depth: 0, dir: REPO_DIR, parentUrl: cleanUrl }];
  let fetched = 0;
  while (queue.length > 0) {
    const level = queue.shift() as (typeof queue)[number];
    const listing = await host.root(
      `cd ${shellQuote(level.dir)} && if [ -f .gitmodules ]; then git config -f .gitmodules --null --get-regexp '^submodule\\..*\\.(path|url)$' || true; fi`
    );
    for (const sub of parseGitmodules(listing)) {
      const label = `submodule "${sub.name}"`;
      if (!sub.path || !sub.url) {
        throw setupConfigFailure(`${label} has no path or url in .gitmodules`);
      }
      if (
        !SUBMODULE_PATH_RE.test(sub.path) ||
        sub.path.split('/').some((s) => s === '..' || s === '.' || s === '')
      ) {
        throw setupConfigFailure(`${label} has an unsafe path`);
      }
      const repo = submoduleRepo(sub.url, level.parentUrl, gitHost);
      if ('error' in repo) {
        throw setupConfigFailure(`${label} URL ${repo.error}`);
      }
      fetched += 1;
      if (fetched > MAX_SUBMODULES) {
        throw setupConfigFailure(`more than ${MAX_SUBMODULES} submodules`);
      }
      let credential: { cleanUrl: string; authHeader?: string };
      try {
        credential = await host.mintCredential(repo.organizationName, repo.repoName);
      } catch (err) {
        throw setupConfigFailure(
          `${label} (${repo.organizationName}/${repo.repoName}): no credential for it: ${host.redact(err instanceof Error ? err.message : String(err))}`
        );
      }
      if (new URL(credential.cleanUrl).host.toLowerCase() !== gitHost?.toLowerCase()) {
        throw setupConfigFailure(`${label}: its credential is for another host`);
      }
      const key = `submodule.${sub.name}`;
      await host.root(
        `cd ${shellQuote(level.dir)} && git config ${shellQuote(`${key}.url`)} ${shellQuote(credential.cleanUrl)} && git config ${shellQuote(`${key}.update`)} checkout`
      );
      try {
        await host.git(
          level.dir,
          `-c protocol.allow=never -c protocol.https.allow=always submodule update --init --depth=1 -- ${shellQuote(sub.path)}`,
          credential.authHeader,
          SUBMODULE_TIMEOUT_MS
        );
      } catch (err) {
        throw setupRunFailure(
          `${label} could not be fetched: ${host.redact(err instanceof Error ? err.message : String(err))}`
        );
      }
      if (mode === 'recursive' && level.depth + 1 < MAX_SUBMODULE_DEPTH) {
        queue.push({
          depth: level.depth + 1,
          dir: `${level.dir}/${sub.path}`,
          parentUrl: credential.cleanUrl,
        });
      }
    }
  }
  return fetched;
}

/**
 * Download the checkout's LFS objects. The endpoint is pinned to the repository's own URL, so an
 * `lfs.url` in a checked-in `.lfsconfig` cannot send the credential elsewhere.
 */
export async function pullLfs(host: RepoSetupHost, cleanUrl: string, authHeader?: string) {
  const version = await host.capture('git lfs version', { timeoutMs: 30_000 });
  if (version.exitCode !== 0) {
    throw setupConfigFailure('lfs: true needs git-lfs in the workspace image');
  }
  const endpoint = `${cleanUrl.replace(/\.git$/, '')}.git/info/lfs`;
  try {
    await host.git(REPO_DIR, `-c lfs.url=${shellQuote(endpoint)} lfs pull`, authHeader, 900_000);
  } catch (err) {
    throw setupRunFailure(
      `git lfs pull failed: ${host.redact(err instanceof Error ? err.message : String(err))}`
    );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/** The cache paths relative to `/`, for a shell that has `$HOME`. */
function cacheTarPaths(paths: readonly string[]): string {
  return paths
    .map((p) =>
      p.startsWith('~/')
        ? `"\${HOME#/}"/${shellQuote(p.slice(2))}`
        : shellQuote(`${REPO_DIR.slice(1)}/${p}`)
    )
    .join(' ');
}

/**
 * The identity of a dependency cache: team, repository, definition, key files, image and
 * architecture. The team keeps one team's cache from ever restoring into another's workspaces;
 * repositories without a team share one scope.
 */
async function setupCacheKey(
  host: RepoSetupHost,
  setup: RepoSetup,
  inputs: Pick<RepoSetupInputs, 'cleanUrl' | 'image' | 'teamId'>
): Promise<string> {
  const files = setup.cache?.keyFiles ?? [];
  const script = [
    'uname -m',
    ...files.map(
      (f) => `if [ -f ${shellQuote(f)} ]; then sha256sum < ${shellQuote(f)}; else echo absent; fi`
    ),
  ].join('; ');
  const result = await host.capture(script, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`hashing the cache key files failed: ${tail(host, result)}`);
  }
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        files: result.stdout.trim(),
        image: inputs.image,
        repository: repositoryId(inputs.cleanUrl),
        setup: canonical(setup),
        team: inputs.teamId ?? null,
        v: 2,
      })
    )
    .digest('hex');
}

function repositoryId(cleanUrl: string): string {
  const url = new URL(cleanUrl);
  return `${url.host}${url.pathname.replace(/\.git$/, '')}`.toLowerCase();
}

async function cacheLimitBytes(): Promise<number> {
  if (resolveStorageConfig().writeBackend === 'pg') {
    return 0;
  }
  const mb = await resolveSetting('workspace.setupCacheMaxMb', await currentRequestContext());
  return mb * 1024 * 1024;
}

async function restoreCache(host: RepoSetupHost, cacheKey: string): Promise<boolean> {
  const row = await prisma.workspaceSetupCache.findUnique({ where: { cacheKey } });
  if (!row) {
    return false;
  }
  const { body } = await getArtifact(row.artifactId);
  await host.stdin('tar -xzf - -C /', body);
  await prisma.workspaceSetupCache.update({
    data: { lastUsedAt: new Date() },
    where: { cacheKey },
  });
  return true;
}

async function saveCache(
  host: RepoSetupHost,
  setup: RepoSetup,
  cacheKey: string,
  cleanUrl: string,
  maxBytes: number
): Promise<'saved' | 'too-large'> {
  const paths = setup.cache?.paths ?? [];
  await host.root(
    [
      'mkdir -p /workspace/.auto-swe',
      'cd /',
      'set --',
      `for p in ${cacheTarPaths(paths)}; do if [ -e "$p" ]; then set -- "$@" "$p"; fi; done`,
      `if [ $# -eq 0 ]; then rm -f ${CACHE_ARCHIVE}; exit 0; fi`,
      `tar -czf ${CACHE_ARCHIVE} -- "$@"`,
    ].join('\n'),
    900_000
  );
  let body: Buffer;
  try {
    body = await host.readFile(CACHE_ARCHIVE, maxBytes);
  } catch (err) {
    if (err instanceof RangeError) {
      return 'too-large';
    }
    throw err;
  } finally {
    await host.root(`rm -f ${CACHE_ARCHIVE}`).catch(() => {});
  }
  const ref = await putArtifact({
    body,
    contentType: 'application/gzip',
    kind: SETUP_CACHE_ARTIFACT_KIND,
  });
  const previous = await prisma.workspaceSetupCache.findUnique({ where: { cacheKey } });
  await prisma.workspaceSetupCache.upsert({
    create: {
      artifactId: ref.id,
      cacheKey,
      repository: repositoryId(cleanUrl),
      sizeBytes: ref.sizeBytes,
    },
    update: { artifactId: ref.id, lastUsedAt: new Date(), sizeBytes: ref.sizeBytes },
    where: { cacheKey },
  });
  if (previous && previous.artifactId !== ref.id) {
    await deleteArtifact(previous.artifactId).catch(() => {});
  }
  return 'saved';
}

/** Run the definition's steps in order, as the workspace user; the first failure fails setup. */
async function runSteps(
  host: RepoSetupHost,
  setup: RepoSetup
): Promise<Array<{ name: string; durationMs: number }>> {
  const env = Object.entries(setup.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const done: Array<{ name: string; durationMs: number }> = [];
  for (const [i, step] of (setup.steps ?? []).entries()) {
    const name = step.name ?? `step ${i + 1}`;
    const started = Date.now();
    const command = step.workdir ? `cd ${shellQuote(step.workdir)} && ${step.run}` : step.run;
    let result: CapturedResult;
    try {
      result = await host.capture(command, {
        env,
        timeoutMs: (step.timeoutSeconds ?? DEFAULT_SETUP_STEP_TIMEOUT_SECONDS) * 1000,
      });
    } catch (err) {
      throw setupRunFailure(
        `"${name}" did not finish: ${host.redact(err instanceof Error ? err.message : String(err))}`
      );
    }
    if (result.exitCode !== 0) {
      throw setupRunFailure(
        `"${name}" failed (exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ''}): ${tail(host, result)}`
      );
    }
    done.push({ durationMs: Date.now() - started, name });
  }
  return done;
}

/**
 * The git half of setup: submodules, then LFS. It runs while the git host is reachable and
 * before any repository code has run, so it is provisioning like the clone itself.
 */
export async function runSetupGitPhase(
  host: RepoSetupHost,
  setup: RepoSetup,
  inputs: Pick<RepoSetupInputs, 'cleanUrl' | 'gitHost'>,
  authHeader?: string
): Promise<{ submodules: number; lfs: boolean }> {
  const submodules = setup.submodules
    ? await fetchSubmodules(host, setup.submodules, inputs.cleanUrl, inputs.gitHost)
    : 0;
  if (setup.lfs) {
    await pullLfs(host, inputs.cleanUrl, authHeader);
  }
  return { lfs: Boolean(setup.lfs), submodules };
}

/**
 * The steps half of setup: restore a matching dependency cache, run the steps, and save the cache
 * on a miss — before any agent has touched the tree, so an agent's edits never reach a cache. A
 * cache that cannot be read or written costs only time: setup runs without it.
 */
export async function runSetupStepsPhase(
  host: RepoSetupHost,
  setup: RepoSetup,
  inputs: Pick<RepoSetupInputs, 'cleanUrl' | 'image' | 'teamId'>
): Promise<Pick<RepoSetupReport, 'cache' | 'steps'>> {
  const maxBytes = setup.cache && setup.steps?.length ? await cacheLimitBytes() : 0;
  let cacheKey: string | null = null;
  let cache: RepoSetupReport['cache'] = 'off';
  if (maxBytes > 0) {
    try {
      cacheKey = await setupCacheKey(host, setup, inputs);
      cache = (await restoreCache(host, cacheKey)) ? 'hit' : 'miss';
    } catch (err) {
      logWarn('workspace setup: dependency cache restore failed; running without it', {
        error: host.redact(err instanceof Error ? err.message : String(err)),
      });
      cache = 'error';
    }
  }
  const steps = await runSteps(host, setup);
  if (cacheKey && cache === 'miss') {
    try {
      cache = await saveCache(host, setup, cacheKey, inputs.cleanUrl, maxBytes);
    } catch (err) {
      logWarn('workspace setup: dependency cache save failed', {
        error: host.redact(err instanceof Error ? err.message : String(err)),
      });
      cache = 'error';
    }
  }
  return { cache, steps };
}

/**
 * Delete dependency caches nobody restored within the retention window, tarball first, so a
 * failed delete leaves a row the next sweep retries. Returns how many were removed.
 */
export async function sweepSetupCaches(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SETUP_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const stale = await prisma.workspaceSetupCache.findMany({
    select: { artifactId: true, id: true },
    take: 500,
    where: { lastUsedAt: { lt: cutoff } },
  });
  let removed = 0;
  for (const row of stale) {
    try {
      await deleteArtifact(row.artifactId);
      await prisma.workspaceSetupCache.delete({ where: { id: row.id } });
      removed += 1;
    } catch (err) {
      logWarn('setup cache sweep: delete failed', {
        error: err instanceof Error ? err.message : String(err),
        id: row.id,
      });
    }
  }
  return removed;
}
