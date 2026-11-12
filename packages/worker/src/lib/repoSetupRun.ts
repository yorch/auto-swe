import crypto from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, getArtifact, putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import type { EgressPolicy } from '@auto-swe/shared/lib/egressPolicy';
import {
  DEFAULT_SETUP_STEP_TIMEOUT_SECONDS,
  isKeyFileGlob,
  MAX_KEY_FILE_GLOB_MATCHES,
  MIN_REPO_SETUP_SECRET_CHARS,
  REPO_SETUP_FILE,
  REPO_SETUP_FILE_MAX_BYTES,
  type RepoSetup,
  type RepoSetupSource,
  resolveRepoSetup,
} from '@auto-swe/shared/lib/repoSetup';
import { classifySetupStepFailure, type SetupBlocker } from '@auto-swe/shared/lib/setupBlocker';
import { resolveStorageConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { currentWorkflowId, currentWorkflowRunId } from './activityContext.js';
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
export function setupConfigFailure(message: string, blocker: SetupBlocker): ApplicationFailure {
  return ApplicationFailure.create({
    details: [blocker],
    message: `workspace setup: ${message}`,
    nonRetryable: true,
    type: WORKSPACE_SETUP_FAILED,
  });
}

/** A retryable failure: a step can fail on a registry hiccup and pass on the next attempt. */
function setupRunFailure(message: string, blocker: SetupBlocker): ApplicationFailure {
  return ApplicationFailure.create({
    details: [blocker],
    message: `workspace setup: ${message}`,
    nonRetryable: false,
    type: WORKSPACE_SETUP_FAILED,
  });
}

function blocker(
  kind: SetupBlocker['kind'],
  detail: string,
  subject = '',
  step?: string
): SetupBlocker {
  return { detail: detail.slice(-OUTPUT_TAIL_CHARS), kind, subject, ...(step ? { step } : {}) };
}

function gitBlocker(detail: string, subject: string): SetupBlocker {
  return blocker(
    /\b(?:401|403)\b|Authentication failed|could not read Username/i.test(detail)
      ? 'git_auth'
      : 'git_fetch',
    detail,
    subject
  );
}

async function failedStepBlocker(started: number, fallback: SetupBlocker): Promise<SetupBlocker> {
  try {
    const workflowId = currentWorkflowId();
    const runId = await currentWorkflowRunId();
    if (workflowId) {
      const denied = await prisma.workflowHttpCall.findFirst({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { host: true },
        where: {
          blocked: true,
          createdAt: { gte: new Date(started) },
          runId: runId ?? null,
          source: 'egress_proxy',
          workflowId,
        },
      });
      if (denied) {
        return { ...fallback, kind: 'egress_denied', subject: denied.host };
      }
    }
  } catch {}
  return fallback;
}

/** What `createWorkspace` hands the setup: its execs, bound to one container. */
export interface RepoSetupHost {
  /** Provisioning exec as the workspace user, outside the checkout; throws on a non-zero exit. */
  root(command: string, timeoutMs?: number): Promise<string>;
  /** Exec in the checkout as the workspace user, without throwing on a non-zero exit. */
  capture(
    command: string,
    opts: {
      env?: string[];
      maxOutputBytes?: number;
      /** Values that must never reach a command line: delivered as secret environment. */
      secretEnv?: Record<string, string>;
      timeoutMs: number;
    }
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
  /**
   * Stop every process in the workspace except its keeper, so nothing a setup step left running
   * still holds a secret when the agent starts.
   */
  sweepProcesses(): Promise<void>;
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
  setupEgressPolicy?: EgressPolicy;
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
    throw setupRunFailure(
      `could not read ${REPO_SETUP_FILE}: ${tail(host, result)}`,
      blocker('internal', tail(host, result))
    );
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
    throw setupConfigFailure(
      resolved.error,
      blocker('invalid_config', host.redact(resolved.error))
    );
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

/** A fetched submodule: its checkout and the credential minted for its repository. */
export interface FetchedSubmodule {
  dir: string;
  cleanUrl: string;
  authHeader?: string;
}

/**
 * Fetch the submodules the definition asks for, shallow, each with a credential minted for its
 * own repository. The URL each one is fetched from is pinned in `.git/config` before the fetch,
 * so nothing in `.gitmodules` but the validated URL is followed, and its `update` mode is pinned
 * to `checkout`. Returns each fetched submodule's checkout and credential, for LFS.
 */
export async function fetchSubmodules(
  host: RepoSetupHost,
  mode: true | 'recursive',
  cleanUrl: string,
  gitHost: string | null
): Promise<FetchedSubmodule[]> {
  const queue = [{ depth: 0, dir: REPO_DIR, parentUrl: cleanUrl }];
  const fetched: FetchedSubmodule[] = [];
  while (queue.length > 0) {
    const level = queue.shift() as (typeof queue)[number];
    const listing = await host.root(
      `cd ${shellQuote(level.dir)} && if [ -f .gitmodules ]; then git config -f .gitmodules --null --get-regexp '^submodule\\..*\\.(path|url)$' || true; fi`
    );
    for (const sub of parseGitmodules(listing)) {
      const label = `submodule "${sub.name}"`;
      if (!sub.path || !sub.url) {
        throw setupConfigFailure(
          `${label} has no path or url in .gitmodules`,
          blocker(
            'invalid_config',
            host.redact(`${label} has no path or url in .gitmodules`),
            sub.name
          )
        );
      }
      if (
        !SUBMODULE_PATH_RE.test(sub.path) ||
        sub.path.split('/').some((s) => s === '..' || s === '.' || s === '')
      ) {
        throw setupConfigFailure(
          `${label} has an unsafe path`,
          blocker('invalid_config', host.redact(`${label} has an unsafe path`), sub.name)
        );
      }
      const repo = submoduleRepo(sub.url, level.parentUrl, gitHost);
      if ('error' in repo) {
        throw setupConfigFailure(
          `${label} URL ${repo.error}`,
          blocker('invalid_config', host.redact(`${label} URL ${repo.error}`), sub.name)
        );
      }
      if (fetched.length >= MAX_SUBMODULES) {
        throw setupConfigFailure(
          `more than ${MAX_SUBMODULES} submodules`,
          blocker('invalid_config', `more than ${MAX_SUBMODULES} submodules`)
        );
      }
      let credential: { cleanUrl: string; authHeader?: string };
      try {
        credential = await host.mintCredential(repo.organizationName, repo.repoName);
      } catch (err) {
        throw setupConfigFailure(
          `${label} (${repo.organizationName}/${repo.repoName}): no credential for it: ${host.redact(err instanceof Error ? err.message : String(err))}`,
          blocker(
            'invalid_config',
            host.redact(err instanceof Error ? err.message : String(err)),
            sub.name
          )
        );
      }
      if (new URL(credential.cleanUrl).host.toLowerCase() !== gitHost?.toLowerCase()) {
        throw setupConfigFailure(
          `${label}: its credential is for another host`,
          blocker(
            'invalid_config',
            host.redact(`${label}: its credential is for another host`),
            sub.name
          )
        );
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
          `${label} could not be fetched: ${host.redact(err instanceof Error ? err.message : String(err))}`,
          gitBlocker(host.redact(err instanceof Error ? err.message : String(err)), gitHost ?? '')
        );
      }
      const dir = `${level.dir}/${sub.path}`;
      fetched.push({ dir, ...credential });
      if (mode === 'recursive' && level.depth + 1 < MAX_SUBMODULE_DEPTH) {
        queue.push({ depth: level.depth + 1, dir, parentUrl: credential.cleanUrl });
      }
    }
  }
  return fetched;
}

/**
 * The LFS filter, set for the call: hardened git reads no global or system config, where
 * `git lfs install` would have put it, and without it `git lfs pull` downloads the objects but
 * leaves the pointer files in the checkout ("Git LFS is not installed").
 */
const LFS_FILTER_CONFIG = [
  'filter.lfs.clean=git-lfs clean -- %f',
  'filter.lfs.smudge=git-lfs smudge -- %f',
  'filter.lfs.process=git-lfs filter-process',
  'filter.lfs.required=true',
]
  .map((kv) => `-c ${shellQuote(kv)}`)
  .join(' ');

/**
 * Download the checkout's LFS objects. The endpoint is pinned to the repository's own URL, so an
 * `lfs.url` in a checked-in `.lfsconfig` cannot send the credential elsewhere.
 */
export async function pullLfs(
  host: RepoSetupHost,
  checkouts: ReadonlyArray<{ dir: string; cleanUrl: string; authHeader?: string }>
) {
  const version = await host.capture('git lfs version', { timeoutMs: 30_000 });
  if (version.exitCode !== 0) {
    throw setupConfigFailure(
      'lfs: true needs git-lfs in the workspace image',
      blocker('lfs_missing', 'lfs: true needs git-lfs in the workspace image', 'git-lfs')
    );
  }
  for (const { authHeader, cleanUrl, dir } of checkouts) {
    // Each checkout's endpoint is pinned to its own repository, so a `.lfsconfig` in it cannot
    // send its credential, or the LFS traffic, anywhere else.
    const endpoint = `${cleanUrl.replace(/\.git$/, '')}.git/info/lfs`;
    try {
      await host.git(
        dir,
        `${LFS_FILTER_CONFIG} -c lfs.url=${shellQuote(endpoint)} lfs pull`,
        authHeader,
        900_000
      );
    } catch (err) {
      const where = dir === REPO_DIR ? '' : ` in ${dir.slice(REPO_DIR.length + 1)}`;
      throw setupRunFailure(
        `git lfs pull${where} failed: ${host.redact(err instanceof Error ? err.message : String(err))}`,
        gitBlocker(
          host.redact(err instanceof Error ? err.message : String(err)),
          new URL(cleanUrl).host
        )
      );
    }
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
  inputs: Pick<RepoSetupInputs, 'cleanUrl' | 'image' | 'teamId' | 'setupEgressPolicy'>
): Promise<string> {
  const entries = setup.cache?.keyFiles ?? [];
  const globs = entries.filter(isKeyFileGlob);
  const matched = globs.length ? await trackedFilesMatching(host, globs) : [];
  const hash = (f: string) =>
    `if [ -f ${shellQuote(f)} ]; then sha256sum < ${shellQuote(f)}; else echo absent; fi`;
  const script = [
    'uname -m',
    'id -u',
    'printf "%s\\n" "$HOME"',
    ...entries.filter((e) => !isKeyFileGlob(e)).map(hash),
    // A matched file's path is part of the key, so adding or removing a subproject changes it.
    ...matched.map((f) => `printf '%s\\n' ${shellQuote(f)}; ${hash(f)}`),
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
        ...(inputs.setupEgressPolicy ? { setupEgressPolicy: inputs.setupEgressPolicy } : {}),
        team: inputs.teamId ?? null,
        v: 2,
      })
    )
    .digest('hex');
}

/**
 * The tracked files the key file globs match, sorted. Only git's index is searched, so a glob
 * never walks an untracked tree such as `node_modules`; more than
 * {@link MAX_KEY_FILE_GLOB_MATCHES} matches is an error, and the workspace runs without a cache.
 */
async function trackedFilesMatching(host: RepoSetupHost, globs: readonly string[]) {
  const pathspecs = globs.map((g) => shellQuote(`:(glob)${g}`)).join(' ');
  const result = await host.capture(`git ls-files -z -- ${pathspecs}`, {
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`listing the cache key files failed: ${tail(host, result)}`);
  }
  const files = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  if (files.length > MAX_KEY_FILE_GLOB_MATCHES) {
    throw new Error(
      `the cache key file globs match ${files.length} files (at most ${MAX_KEY_FILE_GLOB_MATCHES})`
    );
  }
  return files;
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

/**
 * The values of the setup secrets a definition names, from the repository's encrypted store.
 * A name with no stored value, or no repository to read from, fails setup: a step run without
 * the credential it was promised fails later and less clearly.
 */
export async function loadSetupSecrets(
  connectionId: string | null,
  names: readonly string[]
): Promise<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }
  if (!connectionId) {
    throw setupRunFailure(
      `setup names secrets (${names.join(', ')}), but this workspace has no repository to read them from`,
      blocker(
        'invalid_config',
        'setup names secrets but this workspace has no repository',
        [...names].sort().join(', ')
      )
    );
  }
  const rows = await prisma.repoSetupSecret.findMany({
    where: { connectionId, name: { in: [...names] } },
  });
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) {
    throw setupRunFailure(
      `setup secret${missing.length > 1 ? 's' : ''} not set on the repository: ${missing.join(', ')}`,
      blocker(
        'missing_secret',
        `setup secrets not set: ${[...missing].sort().join(', ')}`,
        [...missing].sort().join(', ')
      )
    );
  }
  const values: Record<string, string> = {};
  for (const row of rows) {
    try {
      values[row.name] = decryptSecret({
        authTag: row.valueAuthTag,
        ciphertext: row.valueCiphertext,
        keyVersion: row.valueKeyVersion,
        nonce: row.valueNonce,
      });
    } catch {
      throw setupRunFailure(
        `setup secret ${row.name} could not be decrypted; save it again`,
        blocker(
          'secret_decrypt_failed',
          `setup secret ${row.name} could not be decrypted; save it again`,
          row.name
        )
      );
    }
  }
  return values;
}

/** Run the definition's steps in order, as the workspace user; the first failure fails setup. */
async function runSteps(
  host: RepoSetupHost,
  setup: RepoSetup,
  secretEnv: Record<string, string>
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
        ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
        timeoutMs: (step.timeoutSeconds ?? DEFAULT_SETUP_STEP_TIMEOUT_SECONDS) * 1000,
      });
    } catch (err) {
      throw setupRunFailure(
        `"${name}" did not finish: ${host.redact(err instanceof Error ? err.message : String(err))}`,
        await failedStepBlocker(
          started,
          blocker(
            'step_timeout',
            host.redact(err instanceof Error ? err.message : String(err)),
            name,
            name
          )
        )
      );
    }
    if (result.exitCode !== 0) {
      throw setupRunFailure(
        `"${name}" failed (exit ${result.exitCode}${result.signal ? `, ${result.signal}` : ''}): ${tail(host, result)}`,
        await failedStepBlocker(
          started,
          classifySetupStepFailure({
            command: host.redact(step.run),
            exitCode: result.exitCode,
            output: tail(host, result),
            step: name,
          })
        )
      );
    }
    done.push({ durationMs: Date.now() - started, name });
  }
  return done;
}

const MIN_SCANNED_SECRET_CHARS = MIN_REPO_SETUP_SECRET_CHARS;
const SCAN_TIMEOUT_MS = 300_000;
const SCAN_MAX_FILE_KB = 20 * 1024;
const SCAN_MAX_REPORTED = 20;

/** A setup path as a shell word: `~/…` under the workspace user's home, else in the checkout. */
function setupPathWord(p: string): string {
  return p.startsWith('~/') ? `"$HOME"/${shellQuote(p.slice(2))}` : shellQuote(`${REPO_DIR}/${p}`);
}

/** Delete the files the definition lists under `cleanup`, as the workspace user. */
async function runCleanup(host: RepoSetupHost, setup: RepoSetup): Promise<void> {
  const paths = setup.cleanup ?? [];
  if (paths.length === 0) {
    return;
  }
  const result = await host.capture(`rm -rf -- ${paths.map(setupPathWord).join(' ')}`, {
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw setupRunFailure(
      `cleanup failed: ${tail(host, result)}`,
      blocker('internal', tail(host, result))
    );
  }
}

/** The longest non-empty line of a value: what the scan searches for a multi-line secret. */
function longestLine(value: string): string {
  return value.split(/\r?\n/).reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), '');
}

/**
 * The base64 characters that depend on `bytes` alone, at each of the three byte offsets they can
 * start at inside a longer encoded string, so a value found inside `base64(user:token)` matches.
 */
function base64Fragments(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const own = encoded.slice(
      Math.ceil((offset * 8) / 6),
      Math.floor(((offset + bytes.length) * 8) / 6)
    );
    if (own.length >= MIN_SCANNED_SECRET_CHARS) {
      out.push(own);
    }
  }
  return out;
}

/**
 * The strings the leak scan searches for one secret value: its longest line as written, URL
 * encoded, hex encoded in either case, base64 encoded at any offset in both the standard and
 * URL-safe alphabets ({@link base64Fragments}), and base64 encoded twice. Empty for a value too
 * short to search without matching by chance.
 */
export function secretScanNeedles(value: string): string[] {
  const line = longestLine(value);
  if (line.length < MIN_SCANNED_SECRET_CHARS) {
    return [];
  }
  const bytes = Buffer.from(line, 'utf8');
  const hex = bytes.toString('hex');
  const out = new Set([line, encodeURIComponent(line), hex, hex.toUpperCase()]);
  for (const own of base64Fragments(bytes)) {
    out.add(own);
    out.add(own.replaceAll('+', '-').replaceAll('/', '_'));
  }
  for (const own of base64Fragments(Buffer.from(bytes.toString('base64')))) {
    out.add(own);
  }
  return [...out];
}

/** Directories outside the checkout and home where a step can leave a file the agent can read. */
const SCAN_TEMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'];

/**
 * Holds the workspace clock's time (epoch seconds) right before the steps: a file modified since
 * then, give or take two minutes, was written by setup, so the scan reads it whatever its size.
 * By minutes rather than `-newer`, since BusyBox `find` (the Alpine images) compares whole seconds
 * and a file written in the marker's second would not count as newer.
 */
const SCAN_MARKER = '/tmp/.auto-swe-setup-started';

async function markStepsStart(host: RepoSetupHost): Promise<void> {
  const result = await host.capture(`date +%s > ${SCAN_MARKER}`, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw setupRunFailure(
      `marking the start of the steps failed: ${tail(host, result)}`,
      blocker('internal', tail(host, result))
    );
  }
}

/**
 * Fail setup when a secret value is still in a file the agent or the cache could read: the
 * checkout, the workspace user's home (which holds every `~/` cache path), and the temporary
 * directories. Files up to {@link SCAN_MAX_FILE_KB} KiB are read, and larger ones only when setup
 * wrote them ({@link SCAN_MARKER}); every file when the marker is gone. Each value is searched for
 * as written and encoded ({@link secretScanNeedles}), through secret environment, never the
 * command line. Only the file names are reported.
 */
async function scanForSecrets(
  host: RepoSetupHost,
  secretEnv: Record<string, string>
): Promise<void> {
  const needles = [...new Set(Object.values(secretEnv).flatMap(secretScanNeedles))];
  if (needles.length === 0) {
    return;
  }
  const scanEnv = Object.fromEntries(needles.map((v, i) => [`AUTO_SWE_SCAN_${i}`, v]));
  const patterns = needles.map((_, i) => `-e "$AUTO_SWE_SCAN_${i}"`).join(' ');
  const roots = [shellQuote(REPO_DIR), '"$HOME"', ...SCAN_TEMP_ROOTS].join(' ');
  const script = [
    `if s=$(cat ${SCAN_MARKER} 2>/dev/null) && [ "$s" -gt 0 ] 2>/dev/null;`,
    `then since="-mmin -$(( ($(date +%s) - s) / 60 + 2 ))"; else since="-type f"; fi;`,
    `find ${roots} -xdev -type f \\( -size -${SCAN_MAX_FILE_KB}k -o $since \\) -print0 2>/dev/null`,
    `| xargs -0 -r grep -lF ${patterns} -- 2>/dev/null`,
    `| head -n ${SCAN_MAX_REPORTED}`,
    `| sed -e ${shellQuote(`s|^${REPO_DIR}/||`)} -e "s|^$HOME/|~/|"; rm -f ${SCAN_MARKER}; true`,
  ].join(' ');
  let result: CapturedResult;
  try {
    result = await host.capture(script, { secretEnv: scanEnv, timeoutMs: SCAN_TIMEOUT_MS });
  } catch (err) {
    throw setupRunFailure(
      `the secret scan did not finish: ${host.redact(err instanceof Error ? err.message : String(err))}`,
      blocker('internal', host.redact(err instanceof Error ? err.message : String(err)))
    );
  }
  const files = result.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length) {
    throw setupConfigFailure(
      `setup left a secret value in ${host.redact(files.join(', '))}; list those files under cleanup, or have the step not write the value to disk`,
      blocker('secret_leak', host.redact(files.join(', ')))
    );
  }
}

/**
 * The git half of setup: submodules, then LFS in the checkout and in every fetched submodule. It runs while the git host is reachable and
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
    : [];
  if (setup.lfs) {
    await pullLfs(host, [
      { cleanUrl: inputs.cleanUrl, dir: REPO_DIR, ...(authHeader ? { authHeader } : {}) },
      ...submodules,
    ]);
  }
  return { lfs: Boolean(setup.lfs), submodules: submodules.length };
}

/**
 * The steps half of setup: restore a matching dependency cache, run the steps, and save the cache
 * on a miss — before any agent has touched the tree, so an agent's edits never reach a cache. A
 * cache that cannot be read or written costs only time: setup runs without it.
 */
export async function runSetupStepsPhase(
  host: RepoSetupHost,
  setup: RepoSetup,
  inputs: Pick<RepoSetupInputs, 'cleanUrl' | 'image' | 'teamId' | 'setupEgressPolicy'>,
  /** The values of the secrets `setup.secrets` names, already resolved. */
  secretEnv: Record<string, string> = {}
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
  const short = Object.entries(secretEnv)
    .filter(([, value]) => longestLine(value).length < MIN_SCANNED_SECRET_CHARS)
    .map(([name]) => name);
  if (short.length) {
    throw setupConfigFailure(
      `setup secret${short.length > 1 ? 's' : ''} ${short.join(', ')} ${short.length > 1 ? 'are' : 'is'} shorter than ${MIN_SCANNED_SECRET_CHARS} characters, too short to scan for; save a longer value`,
      blocker(
        'invalid_config',
        `setup secrets too short to scan: ${[...short].sort().join(', ')}`,
        [...short].sort().join(', ')
      )
    );
  }
  if (Object.keys(secretEnv).length) {
    await markStepsStart(host);
  }
  const steps = await runSteps(host, setup, secretEnv);
  if (steps.length) {
    try {
      await host.sweepProcesses();
    } catch (err) {
      throw setupRunFailure(
        `stopping the processes setup left running failed: ${host.redact(err instanceof Error ? err.message : String(err))}`,
        blocker('internal', host.redact(err instanceof Error ? err.message : String(err)))
      );
    }
  }
  await runCleanup(host, setup);
  await scanForSecrets(host, secretEnv);
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
