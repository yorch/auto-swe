import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@auto-swe/shared/db';
import { type EgressPolicy, effectiveSetupEgressPolicy } from '@auto-swe/shared/lib/egressPolicy';
import { MAX_DEPENDENCY_CHECKOUTS } from '@auto-swe/shared/lib/knowledgeBaseResolution';
import { detectedStacks } from '@auto-swe/shared/lib/stackDetection';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { assertShellImageAllowed, DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { currentWorkflowId } from '../lib/activityContext.js';
import { auditLog, logWarn } from '../lib/activityLog.js';
import { currentNodeTag } from '../lib/activityNodeTag.js';
import {
  beginWorkspaceEgress,
  blockedEgressAllow,
  egressPolicyFailure,
  gitHostOf,
  lfsStorageHostEntries,
  lfsStorageHosts,
  resolveOnboardingDraftEgress,
  resolveRunEgressPolicy,
  resolveRunSetupEgressPolicy,
} from '../lib/egressWiring.js';
import type { CapturedResult, OnTimeout } from '../lib/execUtils.js';
import {
  type GitIdentity,
  gitIdentityConfigScript,
  resolveGitIdentity,
} from '../lib/gitIdentity.js';
import { redactExecError, redactSecrets } from '../lib/redactToken.js';
import {
  beginWorkspaceRegistries,
  buildRegistryAllowlist,
  renderMavenSettings,
  renderNpmrc,
  renderYarnrc,
  splitRegistryWorkspaceEnv,
  type WorkspaceRegistryAccess,
} from '../lib/registryProxy/workspaceWiring.js';
import {
  loadSetupSecrets,
  type RepoSetupHost,
  type RepoSetupReport,
  readSetupFile,
  resolveWorkspaceSetup,
  runSetupGitPhase,
  runSetupStepsPhase,
} from '../lib/repoSetupRun.js';
import type { KnowledgeBaseCheckout, MountedKnowledgeBase } from '../lib/runKnowledgeBases.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import type { RepoRef } from '../lib/scm/types.js';
import { recordSetupFailure, resolveSetupBlockers } from '../lib/setupBlockerRecorder.js';
import { shellQuote } from '../lib/shellQuote.js';
import { loadToolCatalog } from '../lib/toolCatalogLoader.js';
import {
  resolveToolRequests,
  type ToolCatalogEntry,
  ToolInstallError,
  type ToolRequest,
  toolsPathEnv,
} from '../lib/toolInstall.js';
import { workspaceBackend } from '../lib/workspaceBackend/index.js';
import {
  extractSingleFileFromArchive,
  readSingleFileFromArchive,
} from '../lib/workspaceBackend/kubernetes/safeTar.js';
import { agentWorkspaceSpec } from '../lib/workspaceBackend/spec.js';
import type { WorkspaceHandle, WorkspaceServiceSpec } from '../lib/workspaceBackend/types.js';
import {
  type InstalledTool,
  installLateTools,
  installResolvedTools,
  planWorkspaceTools,
  readToolsFileFromBase,
  recordToolInstallEvent,
  ToolRefusal,
  toToolInstallFailure,
} from '../lib/workspaceTools.js';

export type CapturedExec = CapturedResult;

export {
  buildBaselineEgressScript,
  buildEgressHelperCommand,
} from '../lib/workspaceBackend/docker.js';
export { shellQuote };

export interface Workspace {
  /** Scrub credentials known to this workspace before publishing diagnostics. */
  redact?: (text: string) => string;
  readonly baseSha: string;
  readBaseFile: (path: string) => Promise<string | null>;
  knowledgeBaseSnapshotIds?: string[];
  knowledgeBases?: MountedKnowledgeBase[];
  containerId: string;
  /** The network posture this workspace was created under (absent on test doubles). */
  egressPolicy?: EgressPolicy;
  setupEgressPolicy?: EgressPolicy;
  finishSetup?: () => Promise<void>;
  /** The author and committer every platform commit in this workspace carries. */
  gitIdentity: GitIdentity;
  /**
   * Run a command and resolve with stdout; rejects on non-zero exit. The
   * default 2-minute timeout suits git/file operations — pass `timeoutMs` for
   * anything that legitimately runs longer (test suites, builds).
   */
  exec: (
    command: string,
    options?: {
      timeoutMs?: number;
      /** Values the command reads by name, kept off every command line (see the backend). */
      secretEnv?: Record<string, string>;
    }
  ) => Promise<string>;
  /**
   * Run a command and capture stdout/stderr/exitCode without throwing on
   * non-zero exits. Used by quality-gate activities that interpret exit
   * code themselves rather than relying on exec's throw-on-error semantics.
   */
  execCapture: (command: string, options?: { timeoutMs?: number }) => Promise<CapturedExec>;
  /**
   * Run a command with `stdin` streamed to it (`docker exec -i`); resolves
   * with stdout, rejects on non-zero exit. This is how file contents reach the
   * container: passing them on the command line is capped by the kernel's
   * argv limit, a pipe is not.
   */
  execStdin: (command: string, stdin: string | Buffer) => Promise<string>;
  /** Read one regular file from the workspace without sending its contents through stdout. */
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  copyFileOut: (
    path: string,
    maxBytes: number
  ) => Promise<{ path: string; sizeBytes: number; cleanup(): Promise<void> }>;
  /**
   * Run a git subcommand (e.g. `push origin main`) against `origin` with the
   * clone credential injected for this call only via `-c http.extraheader`,
   * rather than a persisted `origin` URL. The credential is never written to
   * `.git/config` — see the scrub in `createWorkspace` after clone. The call
   * is hardened against anything the agent planted in `.git/` (hooks,
   * `insteadOf`, proxies …) — see `authedGitScript`; a `push origin …` goes to
   * the scrubbed URL explicitly.
   */
  gitAuthed: (subcommand: string) => Promise<string>;
  /**
   * Run the repository's setup (`createWorkspace`'s `repoSetup` with `defer`) on the tree as it
   * is now: call it once the workspace is on the branch it will work on. A second call, or one
   * on a workspace whose setup already ran, returns the first report; `again` runs it anew, for a
   * caller that has cleaned the tree since.
   */
  runSetup?: (opts?: { again?: boolean }) => Promise<RepoSetupReport | null>;
  /**
   * Catalog tools installed into `/workspace/.tools/bin` before the workspace was handed over;
   * `createWorkspace` always sets it (empty when none). Optional in the type only so a test
   * double built elsewhere need not name it.
   */
  installedTools?: InstalledTool[];
  /**
   * Install more catalog tools mid-run, on an agent's request: the platform runs the same install
   * script as the container user, under the connection's authority (its deny list, the per-run
   * cap, the catalog). Defined only when the workspace was created with `toolsFor`; resolves with
   * one entry per requested key (a key already installed is returned as it is) and throws a
   * `ToolInstallError` on refusal or failure. After a success every later `exec`, `execCapture`
   * and `execStdin` has the tools directory first on `PATH`; `gitAuthed` never does.
   */
  installTools?: (requests: ToolRequest[]) => Promise<InstalledTool[]>;
  /**
   * Kill every process in the container except PID 1 and the keeper
   * ({@link killStrayProcessesScript}): what an earlier turn left running,
   * whatever environment it was started with. Absent on a workspace that cannot
   * say which process the keeper is.
   */
  killStrays?: () => Promise<void>;
  destroy: () => Promise<void>;
}

export interface SplitCloneCredential {
  /**
   * The clone URL with any embedded credential removed. Safe to persist as the
   * `origin` remote inside a container an agent (or an author-supplied shell
   * command) can read.
   */
  cleanUrl: string;
  /**
   * `AUTHORIZATION: basic <base64>` header value for `git -c http.extraheader`,
   * or `undefined` when the source URL carried no credential.
   */
  gitAuthHeader?: string;
  /**
   * The raw (decoded) credential, exposed only so callers can redact it — and
   * its base64 form in `gitAuthHeader` — out of child-process failures.
   */
  token?: string;
}

/**
 * Split a credential-embedded clone URL (`https://x-access-token:<tok>@host/…`)
 * into a scrubbed URL plus a per-call `http.extraheader` value.
 *
 * This is the single source of truth for "never persist the token in
 * `.git/config`": `createWorkspace` (agent workspaces), `runShellStep`
 * (ephemeral shell-step volumes) and `cloneDependencyRepos` (cross-repo
 * checkouts) all clone into a filesystem that untrusted code later reads, so
 * each sets `origin` to `cleanUrl` right after clone and injects
 * `gitAuthHeader` only on the network calls that need it.
 *
 * Backward compatible: a plain (unauthenticated) or non-URL string falls
 * through unchanged with no auth header.
 */
export function splitCloneCredential(authedRepoUrl: string): SplitCloneCredential {
  let parsed: URL | undefined;
  try {
    parsed = new URL(authedRepoUrl);
  } catch {
    // Not a URL at all (e.g. an scp-style git@host:org/repo). There is no
    // embedded credential to strip, so it passes through unchanged.
    return { cleanUrl: authedRepoUrl };
  }

  if (!parsed.password) {
    return { cleanUrl: authedRepoUrl };
  }

  // Strip the credential FIRST and unconditionally. Decoding can throw — a token
  // containing a bare `%` is not valid percent-encoding — and if that throw
  // escaped before the strip, the "scrubbed" URL would still carry the token and
  // `git remote set-url` would write the secret to disk where untrusted code
  // later reads it. Failing closed costs the auth header, not the secret.
  const rawPassword = parsed.password;
  parsed.username = '';
  parsed.password = '';
  const cleanUrl = parsed.toString();

  let token: string;
  try {
    token = decodeURIComponent(rawPassword);
  } catch {
    // Undecodable token: use it verbatim rather than dropping auth entirely.
    token = rawPassword;
  }
  const gitAuthHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return { cleanUrl, gitAuthHeader, token };
}

/**
 * `-c` overrides applied to every git invocation that may carry the clone
 * credential. Command-line config is read last, so for single-valued keys it
 * wins over anything the repository (i.e. the agent, or an author-supplied
 * shell command) wrote into `.git/config`:
 *
 *  - `core.hooksPath=/dev/null` — no hook runs. A hook inherits
 *    `GIT_CONFIG_PARAMETERS`, which holds the `http.extraheader` below, so any
 *    hook (`pre-push`, `reference-transaction`, `post-checkout` …) could read
 *    the token.
 *  - `core.fsmonitor=false`, `core.askPass=`, `credential.helper=` — config
 *    keys whose value is a command git executes.
 *  - `protocol.ext.allow=never` — the `ext::` transport runs a command.
 *  - `*.recurseSubmodules` off — a submodule fetch/push would send the header
 *    to whatever host `.gitmodules` names.
 *  - `gc.auto=0`, `maintenance.auto=false` — no automatic `gc` or `maintenance`
 *    after a fetch or commit. Either can detach into the background, and the
 *    detached process keeps the call's environment (the header) after it returns.
 *
 * Keys a `-c` cannot neutralise — `url.<base>.insteadOf` (longest match
 * wins), `http.<url>.proxy` (a URL-specific key beats `http.proxy`),
 * `include.path` — are why the repository config is also rewritten from an
 * allow-list before every authenticated call; see
 * {@link sanitizeGitRepoConfigScript}.
 */
const HARDENED_GIT_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.askPass=',
  'credential.helper=',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'push.recurseSubmodules=no',
  'gc.auto=0',
  'maintenance.auto=false',
];

/**
 * Environment for a credential-bearing git call: ignore the system and global
 * config files (`~/.gitconfig`, and `/etc/gitconfig` under the root opt-out),
 * and never prompt.
 */
const HARDENED_GIT_ENV = 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0';

/** Name of the environment variable that carries the `http.extraheader` value into a git script. */
export const GIT_AUTH_ENV = 'ASW_GIT_AUTH';

/**
 * Build a hardened `git` invocation, with the clone credential (when there is
 * one) injected for this call only via `-c http.extraheader`, so it is never
 * written to disk. See {@link HARDENED_GIT_CONFIG} for what the hardening
 * neutralises. The empty `http.extraheader=` first resets the multi-valued
 * list, so no header from a config file rides along.
 *
 * The header VALUE is never part of the script. A script goes through
 * `backend.exec`, and under Kubernetes an exec's argv is an apiserver URL
 * (`?command=…`) recorded in audit logs for as long as they are kept. The script
 * reads the value from {@link GIT_AUTH_ENV}, and the caller delivers it with
 * `secretEnv: gitAuthSecretEnv(header)`, which the driver keeps off every
 * command line. `authed` must match whether the caller passes that env: an
 * unset or empty variable aborts the shell (`${…:?}`) rather than sending the
 * request unauthenticated.
 */
export function gitWithAuthHeader(subcommand: string, authed?: boolean): string {
  const flags = HARDENED_GIT_CONFIG.map((kv) => `-c ${kv}`);
  if (authed) {
    flags.push(
      '-c http.extraheader=',
      `-c "http.extraheader=\${${GIT_AUTH_ENV}:?git credential not delivered}"`
    );
  }
  return `${HARDENED_GIT_ENV} git ${flags.join(' ')} ${subcommand}`;
}

/** The `secretEnv` that supplies {@link GIT_AUTH_ENV}; undefined when there is no credential. */
export function gitAuthSecretEnv(gitAuthHeader?: string): Record<string, string> | undefined {
  return gitAuthHeader ? { [GIT_AUTH_ENV]: gitAuthHeader } : undefined;
}

/** Quote a value for a git config file (`"…"` with `\` and `"` escaped). */
function gitConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Shell script (run from the repository's working-tree root, under `set -e`)
 * that rewrites `.git/config` from an allow-list before an authenticated git
 * call, so nothing an agent or author command planted there can redirect or
 * intercept the credential: `url.*.insteadOf`, `http.proxy` /
 * `http.<url>.proxy`, `http.curloptResolve`, `core.sshCommand`,
 * `credential.*`, `include.path` / `includeIf.*`, a rewritten
 * `remote.origin.url` or an extra `pushurl`.
 *
 * What survives is only what the platform itself relies on: the repository
 * format (`extensions.objectformat=sha256` when present, `core.ignorecase`
 * on a case-insensitive filesystem), `origin` pinned to
 * the scrubbed clone URL, and `origin`'s fetch refspecs when they have the
 * plain `refs/heads/…:refs/remotes/origin/…` shape (so `git fetch origin <b>`
 * keeps updating `origin/<b>` exactly as before). Branch tracking and any
 * other local setting is dropped — the platform never reads them.
 *
 * It also refuses to proceed when `.git` is not a plain directory (a gitfile
 * or symlink would point git at a config outside this check), and removes
 * `commondir` / `config.worktree`, the two files that make git read config
 * from somewhere else.
 *
 * And it pins the repository for every git command after it in the same
 * script: `GIT_DIR` and `GIT_WORK_TREE` are exported to this directory (with
 * `GIT_CEILING_DIRECTORIES` at its parent as a second fence), then
 * `git rev-parse --absolute-git-dir` must name exactly that `.git`. Without
 * the pin, a `.git` the agent broke on purpose (deleting `HEAD` is enough)
 * makes git ignore it and walk up to `/workspace/.git` or `/.git` — whose
 * config this rewrite never touched, so its `url.*.insteadOf` would receive
 * the credential and its `filter.*.clean` would run during `git add`. With
 * the pin, a broken `.git` is an error, not a fallback.
 */
export function sanitizeGitRepoConfigScript(cleanUrl: string): string {
  if (/[\r\n]/.test(cleanUrl)) {
    throw new Error('Refusing a remote URL containing a line break');
  }
  const readConfig = 'GIT_CONFIG_NOSYSTEM=1 git config --file .git/config';
  return [
    'if [ -L .git ] || [ ! -d .git ]; then',
    "  echo 'auto-swe: refusing authenticated git: .git is not a plain directory' >&2",
    '  exit 1',
    'fi',
    // Physical path, because `rev-parse --absolute-git-dir` resolves symlinks.
    'asw_root=$(pwd -P)',
    'GIT_DIR="$asw_root/.git"',
    'GIT_WORK_TREE="$asw_root"',
    'GIT_CEILING_DIRECTORIES=$(dirname "$asw_root")',
    'export GIT_DIR GIT_WORK_TREE GIT_CEILING_DIRECTORIES',
    // The temp file too: a pre-planted symlink there would redirect the write.
    'rm -f .git/commondir .git/config.worktree .git/config.auto-swe-tmp',
    `asw_fmt=$(${readConfig} --get extensions.objectformat 2>/dev/null || true)`,
    `asw_fetch=$(${readConfig} --get-all remote.origin.fetch 2>/dev/null | grep -E '^[+]?refs/heads/[^[:space:]:"\\;#]+:refs/remotes/origin/[^[:space:]:"\\;#]+$' || true)`,
    `asw_ic=$(${readConfig} --type=bool --get core.ignorecase 2>/dev/null || true)`,
    'case "$asw_fmt" in sha256) asw_ver=1 ;; *) asw_fmt=; asw_ver=0 ;; esac',
    '{',
    `  printf '[core]\\n\\trepositoryformatversion = %s\\n\\tfilemode = true\\n\\tbare = false\\n\\tlogallrefupdates = true\\n' "$asw_ver"`,
    `  printf '[remote "origin"]\\n\\turl = %s\\n' ${shellQuote(gitConfigQuote(cleanUrl))}`,
    '  printf \'%s\\n\' "$asw_fetch" | while IFS= read -r asw_l; do',
    '    if [ -n "$asw_l" ]; then printf \'\\tfetch = %s\\n\' "$asw_l"; fi',
    '  done',
    '  if [ "$asw_ic" = true ]; then printf \'[core]\\n\\tignorecase = true\\n\'; fi',
    '  if [ -n "$asw_fmt" ]; then printf \'[extensions]\\n\\tobjectformat = %s\\n\' "$asw_fmt"; fi',
    '} > .git/config.auto-swe-tmp',
    'mv -f .git/config.auto-swe-tmp .git/config',
    `asw_gd=$(${HARDENED_GIT_ENV} git rev-parse --absolute-git-dir 2>/dev/null || true)`,
    'if [ "$asw_gd" != "$GIT_DIR" ]; then',
    "  echo 'auto-swe: refusing authenticated git: .git is not a valid repository' >&2",
    '  exit 1',
    'fi',
  ].join('\n');
}

/**
 * The `fetch` subcommand that brings `branches` into `origin/<branch>`.
 *
 * Every workspace is a single-branch clone (`clone -b <branch>` implies
 * `--single-branch`), so `origin`'s configured refspec covers one branch and a
 * bare `git fetch origin <other>` only writes `FETCH_HEAD` — `origin/<other>`
 * never appears, and a following `reset --hard origin/<other>` fails (or, on a
 * retry path that swallows the error, silently keeps the stale tree). An
 * explicit, forced refspec per branch updates the remote-tracking ref whatever
 * the clone was configured with, including after a force-push.
 */
export function fetchBranchesSubcommand(branches: string[]): string {
  const refspecs = branches.map((b) => shellQuote(`+refs/heads/${b}:refs/remotes/origin/${b}`));
  return `fetch origin ${refspecs.join(' ')}`;
}

/**
 * Shell script that SIGKILLs every process in the agent workspace except
 * PID 1 (the container or pod init process), the workspace's `sleep infinity`
 * keeper, and the script's own process tree. `gitAuthed` runs it first, in the
 * same exec as the config rewrite and the credential-bearing git call, for two
 * reasons:
 *
 *  - The credential is in git's environment and `-c http.extraheader=…` is
 *    expanded into its command line, so a process the agent left running
 *    (`nohup … &`) can read it from `/proc/<pid>/cmdline` or `environ`.
 *  - The same process could rewrite `.git/config` between the allow-list
 *    rewrite and git reading it.
 *
 * Processes are stopped (twice, to catch a child forked mid-scan) before any
 * is killed, as in {@link killTaggedProcessesScript}. The keeper's PID comes
 * from the workspace driver. The sweep captures its own mount namespace and
 * skips processes in other or unreadable mount namespaces, so Kubernetes
 * service sidecars are not signalled even though their PIDs are visible.
 * Workspace processes have no `CAP_SYS_ADMIN` and use the runtime-default
 * seccomp profile, which prevents them from calling `unshare` or `setns` to
 * move into another mount namespace and evade the sweep. Uses `/proc`,
 * `readlink`, `sed` and `kill`.
 */
export function killStrayProcessesScript(keeperPid: number, useKeeperNamespace = false): string {
  if (!Number.isInteger(keeperPid) || keeperPid <= 0) {
    throw new Error(`invalid keeper pid: ${keeperPid}`);
  }
  return [
    useKeeperNamespace
      ? `asw_mnt=$(readlink "/proc/${keeperPid}/ns/mnt" 2>/dev/null) || asw_mnt=`
      : 'asw_mnt=$(readlink "/proc/$$/ns/mnt" 2>/dev/null) || asw_mnt=',
    'if [ -z "$asw_mnt" ]; then echo "stray-process sweep: cannot read own mount namespace" >&2; exit 1; fi',
    'asw_ppid() { sed -n \'s/^PPid:[[:space:]]*//p\' "/proc/$1/status" 2>/dev/null; }',
    'asw_mine() {',
    '  asw_a=$1',
    '  while [ -n "$asw_a" ] && [ "$asw_a" -gt 1 ]; do',
    '    if [ "$asw_a" = "$$" ]; then return 0; fi',
    '    asw_a=$(asw_ppid "$asw_a")',
    '  done',
    '  return 1',
    '}',
    `asw_keeper=${keeperPid}`,
    'asw_sweep() {',
    '  for asw_d in /proc/[0-9]*; do',
    `    asw_p=\${asw_d#/proc/}`,
    '    asw_ns=$(readlink "$asw_d/ns/mnt" 2>/dev/null) || continue',
    '    [ "$asw_ns" = "$asw_mnt" ] || continue',
    '    if [ "$asw_p" = 1 ] || [ "$asw_p" = "$asw_keeper" ] || asw_mine "$asw_p"; then continue; fi',
    '    kill -"$1" "$asw_p" 2>/dev/null || true',
    '  done',
    '}',
    'asw_sweep STOP',
    'asw_sweep STOP',
    'asw_sweep KILL',
  ].join('\n');
}

export function clearSetupProcessesScript(keeperPid: number, useKeeperNamespace = false): string {
  return [
    killStrayProcessesScript(keeperPid, useKeeperNamespace),
    'asw_uid=$(id -u) || exit 1',
    'asw_check() {',
    '  for asw_d in /proc/[0-9]*; do',
    `    asw_p=\${asw_d#/proc/}`,
    '    if [ "$asw_p" = 1 ] || [ "$asw_p" = "$asw_keeper" ] || asw_mine "$asw_p"; then continue; fi',
    '    asw_ns=$(readlink "$asw_d/ns/mnt" 2>/dev/null) || {',
    '      [ ! -d "$asw_d" ] && continue',
    '      asw_owner=$(sed -n \'s/^Uid:[[:space:]]*\\([0-9]*\\).*/\\1/p\' "$asw_d/status" 2>/dev/null)',
    '      if [ -n "$asw_owner" ] && [ "$asw_owner" != "$asw_uid" ]; then continue; fi',
    '      return 1',
    '    }',
    '    [ "$asw_ns" != "$asw_mnt" ] || return 1',
    '  done',
    '  return 0',
    '}',
    'for asw_retry in 1 2 3 4 5; do',
    '  if asw_check; then exit 0; fi',
    '  asw_sweep STOP; asw_sweep KILL; sleep 0.1',
    'done',
    'echo "setup transition: workspace processes remain or cannot be inspected" >&2',
    'exit 1',
  ].join('\n');
}

/**
 * The full script for one credential-bearing git call against the repository
 * at `repoDir`: fail fast, rewrite the repo config from the allow-list, then
 * run the hardened invocation. A `push origin …` is additionally sent to the
 * scrubbed URL explicitly (with `--no-verify`) rather than resolved through
 * the remote name, so the destination is fixed by the worker, not by the
 * repository.
 *
 * Shared by the agent workspace's `gitAuthed` and the shell step's finalize
 * push. The one thing it cannot defend against is code already running as
 * root in the same container replacing the `git` binary itself — see the
 * Limitations in docs/architecture.md.
 */
export function authedGitScript(
  repoDir: string,
  subcommand: string,
  opts: { cleanUrl: string; authed?: boolean }
): string {
  const explicit = subcommand.replace(
    /^push origin(?=\s|$)/,
    `push --no-verify ${shellQuote(opts.cleanUrl)}`
  );
  return [
    'set -e',
    `cd ${shellQuote(repoDir)}`,
    sanitizeGitRepoConfigScript(opts.cleanUrl),
    gitWithAuthHeader(explicit, opts.authed),
  ].join('\n');
}

/**
 * Environment variable that tags every command the worker runs in a workspace
 * with a per-call id. Children inherit their parent's environment, so the tag
 * marks the command's whole process tree — including grandchildren that were
 * reparented when an intermediate process exited.
 */
export const EXEC_TAG_ENV = 'AUTO_SWE_EXEC_ID';

/**
 * Shell script, run inside the workspace, that kills every process carrying
 * `EXEC_TAG_ENV=<execId>`. Two passes: SIGSTOP everything first, so a process
 * cannot fork a new child between the scan and the kill, then SIGKILL. Uses
 * only `/proc`, `grep` and `kill`, which busybox and coreutils images both
 * have. The id is worker-generated hex, so it needs no quoting beyond the
 * check below. It matches as a prefix: a process tagged `<execId><more hex>`
 * dies too, which is how a harness turn's kill reaches every command it ran
 * under a tag of its own (`harness/runtime.ts`).
 */
export function killTaggedProcessesScript(execId: string): string {
  if (!/^[0-9a-f]+$/.test(execId)) {
    throw new Error(`invalid exec tag: ${execId}`);
  }
  return [
    'asw_kill() {',
    '  for p in /proc/[0-9]*; do',
    `    if grep -qs '${EXEC_TAG_ENV}=${execId}' "$p/environ"; then kill -"$1" "\${p#/proc/}" 2>/dev/null || true; fi`,
    '  done',
    '}',
    'asw_kill STOP',
    'asw_kill KILL',
  ].join('\n');
}

// Resource caps applied to every workspace container (bound worst-case
// memory/CPU usage from a runaway agent-driven build/test process, and cap
// process count to blunt fork-bomb-style failures) and the default base image
// come from the environment — see `resolveWorkspaceInfra` and `createWorkspace`
// (defaults: 4g / 2 CPU / 512 pids / node:24-alpine).

// The Docker driver installs and verifies the baseline before services or agent commands run.

/**
 * `sh` script that leaves a working `git` on PATH, run as the first exec in a
 * fresh workspace. Three cases:
 *
 *  - git already ships in the image — nothing to do;
 *  - git is missing and the workspace is non-root — fail naming the image contract;
 *  - git is missing and root can install it: `apk` on Alpine,
 *    then `apt-get` on Debian/Ubuntu (with `APT::Sandbox::User=root`, because
 *    the container runs `--cap-drop=ALL` and apt's default privilege drop to
 *    the `_apt` user fails without it);
 *  - neither — the image cannot meet the executor image contract (git is
 *    required; see docs/repositories.md) and provisioning fails naming it.
 */
export function gitBootstrapScript(image: string): string {
  return [
    'if ! command -v git >/dev/null 2>&1; then',
    '  if [ "$(id -u)" != 0 ]; then',
    `    echo ${shellQuote(`auto-swe: executor image '${image}' must ship git for non-root workspaces. Install git when building the image; repository setup and catalog tools run as the workspace user. See docs/repositories.md`)} >&2`,
    '    exit 1',
    '  fi',
    '  if command -v apk >/dev/null 2>&1; then',
    '    apk add --no-cache git',
    '  elif command -v apt-get >/dev/null 2>&1; then',
    '    apt-get -o APT::Sandbox::User=root update &&',
    '      apt-get -o APT::Sandbox::User=root install -y --no-install-recommends git',
    '  else',
    `    echo ${shellQuote(`auto-swe: executor image '${image}' does not ship git and provides neither apk nor apt-get to install it. An executor image must provide sh, git and tar — see the executor image contract in docs/repositories.md`)} >&2`,
    '    exit 1',
    '  fi',
    'fi',
  ].join('\n');
}

/** Hard cap on `full_checkout` dependency clones per workspace. */
export { MAX_DEPENDENCY_CHECKOUTS };

export interface DependencyCheckout {
  /** Clone URL carrying the credential, from `ScmProvider.cloneCredentials()`. */
  authedCloneUrl: string;
  /** Branch to clone; omitted means the remote's default branch. */
  branch?: string;
  /** Human name for the checkout directory — sanitized before use. */
  name: string;
}

/**
 * Reduce an arbitrary repo name to a safe single path segment. Belt-and-braces:
 * every interpolated path is shell-quoted as well, but a name that cannot
 * contain a separator or a leading dash cannot escape `/workspace/deps` even if
 * a future caller forgets to quote.
 */
export function safeDepDirName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'dep';
}

/**
 * Optional `full_checkout` tier: clone dependency repos read-only into
 * `/workspace/deps/<name>` alongside the target repo.
 *
 * Runs *after* `createWorkspace` has cloned and scrubbed the target repo, and
 * clones every dependency the same way: from the clean URL, hardened, with the
 * credential sent for the clone alone as a per-call header delivered through
 * `secretEnv` (`gitWithAuthHeader`), so it is on no command line outside the
 * container and no token survives in it. Dependency credentials are never
 * attached to the returned `Workspace`: these checkouts are read-only reference
 * material, and nothing in the workspace can push to them.
 *
 * Best-effort per dependency and capped at {@link MAX_DEPENDENCY_CHECKOUTS} —
 * one repo that fails to clone does not fail the run or the other clones.
 */
export async function cloneDependencyRepos(
  workspace: Pick<Workspace, 'exec' | 'egressPolicy'>,
  deps: DependencyCheckout[]
): Promise<{ label: string; path: string }[]> {
  const cloned: { label: string; path: string }[] = [];
  const used = new Set<string>();

  for (const dep of deps.slice(0, MAX_DEPENDENCY_CHECKOUTS)) {
    let dir = safeDepDirName(dep.name);
    while (used.has(dir)) {
      dir = `${dir}-x`;
    }
    used.add(dir);
    const path = `/workspace/deps/${dir}`;
    const { cleanUrl, gitAuthHeader } = splitCloneCredential(dep.authedCloneUrl);
    const secretEnv = gitAuthSecretEnv(gitAuthHeader);
    const branchArg = dep.branch ? `-b ${shellQuote(dep.branch)} ` : '';
    try {
      // The clean URL, with the credential as a per-call header read from the
      // environment: a Kubernetes exec's command is an apiserver URL kept in
      // audit logs. `--` terminates option parsing: a URL that begins with a
      // dash is then a path, not a git flag (`--upload-pack=…` and friends).
      await workspace.exec(
        gitWithAuthHeader(
          `clone --depth=1 ${branchArg}-- ${shellQuote(cleanUrl)} ${shellQuote(path)}`,
          Boolean(gitAuthHeader)
        ),
        secretEnv ? { secretEnv } : undefined
      );
      // Belt and braces, as for the target repo: the clone used the clean URL,
      // so `origin` holds no credential an agent could read back out.
      await workspace.exec(
        `cd ${shellQuote(path)} && git remote set-url origin ${shellQuote(cleanUrl)}`
      );
      // Label with the sanitized directory, not the raw name: the caller renders
      // this into an agent prompt, and the sanitized form is also what is on disk.
      cloned.push({ label: dir, path });
    } catch (err) {
      if (workspace.egressPolicy === 'blocked' || workspace.egressPolicy === 'restricted') {
        // The workspace's network was locked before this checkout: a host other than the
        // repository's own git host is unreachable, so say why instead of vanishing silently.
        logWarn('dependency checkout failed in a network-locked workspace', {
          dependency: dir,
          egressPolicy: workspace.egressPolicy,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Remove a half-cloned directory so the agent never sees a partial repo.
      try {
        await workspace.exec(`rm -rf ${shellQuote(path)}`);
      } catch {
        /* nothing to clean up */
      }
    }
  }

  return cloned;
}

export async function cloneKnowledgeBases(
  workspace: Pick<Workspace, 'exec'>,
  bases: KnowledgeBaseCheckout[]
): Promise<MountedKnowledgeBase[]> {
  const mounted: MountedKnowledgeBase[] = [];
  const used = new Set<string>();
  for (const kb of bases.slice(0, MAX_DEPENDENCY_CHECKOUTS)) {
    let name = safeDepDirName(kb.mountName);
    while (used.has(name)) {
      name = `${name}-x`;
    }
    used.add(name);
    const destination = `/workspace/kb/${name}`;
    const staging = `/workspace/.kb-checkout-${name}`;
    try {
      const basePath = kb.path.replace(/\/+$/, '');
      const safePath = (value: string) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        value.split('/').every((part) => part !== '.' && part !== '..' && part !== '');
      if (
        !/^[0-9a-f]{40,64}$/i.test(kb.sha) ||
        (kb.path !== '' && !safePath(basePath)) ||
        kb.flaggedFiles.some((file) => !safePath(file))
      ) {
        throw new Error('invalid knowledge base checkout');
      }
      const { cleanUrl, gitAuthHeader } = splitCloneCredential(kb.authedCloneUrl);
      const source = basePath ? `${staging}/${basePath}` : staging;
      const script = [
        'set -eu',
        `mkdir -p /workspace/kb ${shellQuote(staging)}`,
        `cd ${shellQuote(staging)}`,
        'git init -q',
        `git remote add origin ${shellQuote(cleanUrl)}`,
        ...(basePath
          ? [
              'git sparse-checkout init --cone',
              `git sparse-checkout set -- ${shellQuote(basePath)}`,
            ]
          : []),
        gitWithAuthHeader(
          `fetch --depth=1 --no-tags origin ${shellQuote(kb.sha)}`,
          Boolean(gitAuthHeader)
        ),
        'git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD',
        `find ${shellQuote(staging)} -type l -delete`,
        ...kb.flaggedFiles.map((file) => `rm -f -- ${shellQuote(`${staging}/${file}`)}`),
        `rm -rf -- ${shellQuote(`${staging}/.git`)}`,
        `test -d ${shellQuote(source)}`,
        `test "$(find ${shellQuote(source)} -type f -exec sh -c 'for file do wc -c < "$file"; done' sh {} + | awk '{bytes += $1} END {print bytes+0}')" -le 52428800`,
        `mkdir ${shellQuote(destination)}`,
        `cp -a ${shellQuote(source)}/. ${shellQuote(destination)}/`,
        `rm -rf -- ${shellQuote(staging)}`,
        `find ${shellQuote(destination)} -type f -exec chmod 444 {} +`,
        `find ${shellQuote(destination)} -type d -exec chmod 555 {} +`,
      ].join('\n');
      await workspace.exec(script, {
        secretEnv: gitAuthSecretEnv(gitAuthHeader),
        timeoutMs: 600_000,
      });
      mounted.push({
        knowledgeBaseId: kb.knowledgeBaseId,
        mountPath: destination,
        owner: kb.owner,
        repo: kb.repo,
        sha: kb.sha,
        snapshotId: kb.snapshotId,
      });
    } catch {
      logWarn('knowledge base checkout failed; continuing without this reference');
      try {
        await workspace.exec(
          `chmod -R u+w ${shellQuote(destination)} 2>/dev/null || true; rm -rf -- ${shellQuote(destination)} ${shellQuote(staging)}`
        );
      } catch {}
    }
  }
  return mounted;
}

/**
 * Provision an ephemeral Docker workspace with the repo cloned at the default
 * branch and a fresh local branch checked out. `authedRepoUrl` must already
 * carry credentials — callers obtain it from
 * `ScmProvider.cloneCredentials().authedCloneUrl` (lib/scm), which keeps the
 * provider-specific credential embedding out of this file. All execs are
 * async (the old execSync versions blocked the worker event loop, starving
 * Temporal heartbeats for every concurrent activity) and pump heartbeats
 * while the child process runs.
 */
export async function createWorkspace(
  authedRepoUrl: string,
  branch: string,
  defaultBranch: string,
  /**
   * Base image for the workspace container. When omitted, the DB-backed
   * workflow default (`workspaceImage`, default `node:24-alpine`) is used, so a
   * caller that passes nothing gets the GLOBAL config image; callers passing an
   * explicit `executorImage` still override it.
   *
   * Pass `executorImageFor(repo)` (lib/executorImage.ts: the connection's
   * `executorImage`, else the deployer's image for its detected stack, else
   * `undefined`), never `executorImageFor(repo) ?? '<some image>'`. A literal here is not a fallback — it is a value, so it wins the
   * `??` below and `workspaceImage` is never consulted. Every caller used to do
   * exactly that, which made the admin's /admin/workflow-defaults setting unreachable
   * while both this comment and the docs said otherwise. The one deliberate
   * exception is the eval harness, which pins its image for benchmark
   * comparability and says so at the call site.
   */
  image?: string,
  /**
   * Optional commit SHA to pin the workspace to (P1 frozen-benchmark fixtures —
   * docs/evals-p1.md). When set, the repo is cloned with full history and the
   * working branch is cut from that exact commit, so a fixture is deterministic
   * by construction regardless of where `defaultBranch` has moved. When unset,
   * the cheap shallow clone at `defaultBranch` HEAD is used (the normal path).
   */
  checkoutSha?: string,
  /**
   * When true, `branch` is an existing remote branch to check out directly
   * (shallow-clone `-b <branch>`), rather than a new working branch to cut from
   * `defaultBranch` HEAD. Used by the node-level eval gate, which must score the
   * candidate's already-pushed branch — not a fresh branch off main. Ignored
   * when `checkoutSha` is set (the pinned-fixture path takes precedence).
   */
  existingBranch?: boolean,
  options?: {
    /** Resume snapshot pins may contain agent commits; configuration still comes from this base branch. */
    trustedBaseBranch?: string;
    knowledgeBaseSnapshotIds?: string[];
    knowledgeBases?: KnowledgeBaseCheckout[];
    teamId?: string | null;
    services?: WorkspaceServiceSpec[];
    /**
     * The repository's stored stack detection (`repo.detectedStack`). It decides which
     * non-npm registries are wired; absent or unusable means "unknown".
     */
    detectedStack?: unknown;
    /** Catalog tools to install regardless of any setting: the programmatic path. */
    tools?: ToolRequest[];
    /** The catalog requests resolve against; when omitted the `ToolCatalogEntry` table is read. */
    toolCatalog?: readonly ToolCatalogEntry[];
    /**
     * The network posture of this workspace. Absent, it is the run's pinned
     * `workspace.egressPolicy`. A caller passes it only to override that — the trusted
     * delivery workspace passes `'blocked'` under any restricting policy and `'open'` under
     * `open` (see `runAgentTask`).
     */
    egressPolicy?: EgressPolicy;
    /** Internal trials must test setup under the real run policy, without setup-phase widening. */
    inheritSetupEgress?: boolean;
    /** Set only by the worker after verifying the seeded onboarding run and agent. */
    onboardingDraft?: boolean;
    /**
     * Run the repository's setup (`.auto-swe/setup.yml`, or `field` — the repository's
     * `Connection.setup` — which overrides it). Absent, the workspace gets none: only the trusted
     * delivery workspace leaves it out. With `defer`, setup waits for `workspace.runSetup()`, for
     * a caller that moves the checkout to another branch first.
     */
    repoSetup?: {
      field: unknown;
      defer?: boolean;
      connectionId?: string | null;
      recordBlockers?: boolean;
    };
    /**
     * Install what this connection declares (its admin list and, when enabled, the base ref's
     * `.auto-swe/tools.yml`), if `workspace.toolInstall.enabled` is on.
     */
    toolsFor?: { connectionId: string };
    trusted?: boolean;
  }
): Promise<Workspace> {
  // Container caps, default base image and metadata-blocking policy all come
  // from the environment. A caller-supplied `image` still wins (executor-image
  // override).
  const infra = resolveWorkspaceInfra();
  const effectiveImage = image ?? infra.image;
  const realEgressPolicy =
    options?.egressPolicy ?? (await resolveRunEgressPolicy(options?.teamId ?? null));
  const onboardingEgress =
    options?.onboardingDraft && !options.inheritSetupEgress
      ? await resolveOnboardingDraftEgress(options.teamId ?? null, realEgressPolicy)
      : null;
  const egressPolicy: EgressPolicy = onboardingEgress ? 'restricted' : realEgressPolicy;
  let setupEgressPolicy = effectiveSetupEgressPolicy(
    egressPolicy,
    options?.trusted || options?.inheritSetupEgress || onboardingEgress
      ? 'inherit'
      : await resolveRunSetupEgressPolicy(options?.teamId ?? null)
  );
  let setupPhase = setupEgressPolicy !== egressPolicy;
  let transitioning = false;
  let transitionFailed = false;
  const phaseSecrets = (secretEnv?: Record<string, string>) => {
    const clearProxy =
      setupEgressPolicy !== egressPolicy &&
      ((setupPhase && setupEgressPolicy === 'open') || (!setupPhase && egressPolicy === 'blocked'));
    return clearProxy
      ? {
          secretEnv: {
            ALL_PROXY: '',
            all_proxy: '',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            http_proxy: '',
            https_proxy: '',
            ...secretEnv,
          },
        }
      : secretEnv
        ? { secretEnv }
        : {};
  };

  if (!DOCKER_IMAGE_REF_RE.test(effectiveImage)) {
    throw new Error(`Invalid Docker image name: ${effectiveImage}`);
  }

  if (options?.services?.length) {
    const names = new Set<string>();
    for (const service of options.services) {
      if (names.has(service.name)) {
        throw new Error(`duplicate workspace service name: ${service.name}`);
      }
      names.add(service.name);
    }
    const team = options.teamId
      ? await prisma.team.findUnique({
          select: { shellImageAllowlist: true },
          where: { id: options.teamId },
        })
      : null;
    const teamAllowlist = (team?.shellImageAllowlist as string[] | null) ?? [];
    for (const service of options.services) {
      assertShellImageAllowed(service.image, teamAllowlist);
    }
  }

  // Extract the embedded credential from the authed clone URL (if any) so it
  // can be injected per-call via `git -c http.extraheader` instead of being
  // persisted in the cloned repo's `.git/config` as the `origin` remote URL —
  // see the `git remote set-url` scrub below and `gitAuthed` on the returned
  // Workspace. Backward compatible: a plain (unauthenticated) URL just falls
  // through with no auth header.
  const { cleanUrl, gitAuthHeader, token } = splitCloneCredential(authedRepoUrl);
  // Every form the credential can take in a failed git command line or its
  // stderr: the raw token, the full header, and the header's bare base64 value.
  const cloneSecrets = [
    token,
    gitAuthHeader,
    gitAuthHeader?.slice(gitAuthHeader.lastIndexOf(' ') + 1),
  ];

  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;
  const backend = workspaceBackend();

  // Resolved before any container exists: a database failure here throws with
  // nothing to clean up, and the activity retries rather than committing under
  // a fallback identity.
  const gitIdentity = await resolveGitIdentity({ teamId: options?.teamId ?? null });

  // Every command run in the container carries a fresh tag, and a command that
  // outlives its timeout has its whole in-container process tree killed by
  // that tag. Killing the local `docker exec` client alone — all a timeout used
  // to do — leaves the command running inside the container.
  const newExecTag = (): { env: string; onTimeout: OnTimeout } => {
    if (transitioning || transitionFailed) {
      throw egressPolicyFailure('workspace setup transition is incomplete or failed');
    }
    const execId = crypto.randomBytes(8).toString('hex');
    return {
      env: `${EXEC_TAG_ENV}=${execId}`,
      onTimeout: async () => {
        await backend.execShell(
          backend.attach(containerName),
          ['sh', '-c', killTaggedProcessesScript(execId)],
          { heartbeatLabel: 'workspace: killing timed-out command', timeoutMs: 30_000 }
        );
      },
    };
  };

  // The container has a deterministic name before it exists, so any failure —
  // including a `docker run` whose client timed out after the daemon had
  // already created the container — removes it by that name instead of
  // leaking it. The driver adds the hardening (init, cap-drop, keeper PID,
  // metadata sidecar); `agentWorkspaceSpec` carries the deployment's caps,
  // resolvers, network and host aliases.
  // Registry wiring registers before the container exists: the token goes in
  // as env on `docker run`, and the registration answers 503 until the
  // lockfile allowlist is set — a state the agent never reaches.
  let registry: WorkspaceRegistryAccess | null = null;
  let egress: Awaited<ReturnType<typeof beginWorkspaceEgress>> = null;
  try {
    // A detected non-Go repository is not given a Go proxy it has no use for (a smaller
    // reach for the token). An unknown detection wires Go: the registry only exists when
    // the team configured one, and a Go module fetched around it would bypass the allowlist.
    const stacks = detectedStacks(options?.detectedStack);
    const wantGo = stacks === null || stacks.includes('go');
    const wantPypi = stacks === null || stacks.includes('python');
    const wantMaven = stacks === null || stacks.includes('jvm');
    registry = await beginWorkspaceRegistries(options?.teamId ?? null, containerName, {
      go: wantGo,
      maven: wantMaven,
      pypi: wantPypi,
    });
  } catch (err) {
    // A resolution/registration failure fails workspace creation — a workspace
    // with the wrong registries (or none, when some should apply) is not safe
    // to hand the agent.
    // redactExecError scrubs in place and returns nothing: throw the error itself.
    const failure = err instanceof Error ? err : new Error(String(err));
    redactExecError(failure, cloneSecrets);
    throw failure;
  }
  let handle: WorkspaceHandle = backend.attach(containerName);
  async function readWorkspaceFile(filePath: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative safe integer');
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-file-'));
    const archivePath = path.join(dir, 'file.tar');
    try {
      const archiveLimit = Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 128 * 1024);
      const copied = await backend.copyOut(handle, filePath, archivePath, {
        heartbeatLabel: 'workspace: reading a file',
        maxBytes: archiveLimit,
        timeoutMs: 60_000,
      });
      if (copied.exceeded) {
        throw new RangeError(`workspace file exceeds the ${maxBytes} byte limit`);
      }
      if (copied.exitCode !== 0) {
        throw new Error(
          `Could not read workspace file "${filePath}": ${copied.stderr.trim() || 'copy failed'}`
        );
      }
      return await readSingleFileFromArchive(archivePath, maxBytes);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }
  async function copyWorkspaceFileOut(
    filePath: string,
    maxBytes: number
  ): Promise<{ path: string; sizeBytes: number; cleanup(): Promise<void> }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative safe integer');
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-file-'));
    const archivePath = path.join(dir, 'file.tar');
    const destPath = path.join(dir, 'file');
    try {
      const copied = await backend.copyOut(handle, filePath, archivePath, {
        heartbeatLabel: 'workspace: copying a file out',
        maxBytes: Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 128 * 1024),
        timeoutMs: 60_000,
      });
      if (copied.exceeded) {
        throw new RangeError(`workspace file exceeds the ${maxBytes} byte limit`);
      }
      if (copied.exitCode !== 0) {
        throw new Error(
          `Could not read workspace file "${filePath}": ${copied.stderr.trim() || 'copy failed'}`
        );
      }
      const extracted = await extractSingleFileFromArchive(archivePath, destPath, maxBytes);
      return {
        cleanup: () => rm(dir, { force: true, recursive: true }),
        path: destPath,
        sizeBytes: extracted.sizeBytes,
      };
    } catch (error) {
      await rm(dir, { force: true, recursive: true });
      throw error;
    }
  }
  let baseRef: () => Promise<string> = async () => 'HEAD';
  let trustedBaseSha = '';
  let baseRefFetch: Promise<string> | undefined;
  // Secrets minted during setup (submodule credentials), scrubbed like the clone's own.
  const setupSecrets: string[] = [];
  const setupHost: RepoSetupHost = {
    capture: (command, opts) => {
      const tag = newExecTag();
      return backend.exec(handle, ['sh', '-c', command], {
        env: [tag.env, ...toolsEnv, ...(opts.env ?? [])],
        heartbeatLabel: 'workspace: setup',
        onTimeout: tag.onTimeout,
        ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
        ...phaseSecrets(opts.secretEnv),
        timeoutMs: opts.timeoutMs,
        workdir: '/workspace/target-repo',
      });
    },
    git: (dir, subcommand, authHeader, timeoutMs) => {
      const tag = newExecTag();
      const secretEnv = gitAuthSecretEnv(authHeader);
      return backend.execShell(
        handle,
        [
          'sh',
          '-c',
          `cd ${shellQuote(dir)} && ${gitWithAuthHeader(subcommand, Boolean(authHeader))}`,
        ],
        {
          env: [tag.env],
          heartbeatLabel: 'workspace: setup (git)',
          onTimeout: tag.onTimeout,
          ...phaseSecrets(secretEnv),
          timeoutMs,
        }
      );
    },
    mintCredential: async (organizationName, repoName) => {
      const row = await prisma.connection.findFirst({
        include: { installation: { select: { host: true, installationId: true } } },
        where: {
          isActive: true,
          organizationName: { equals: organizationName, mode: 'insensitive' },
          repoName: { equals: repoName, mode: 'insensitive' },
          type: 'git_repo',
        },
      });
      const ref: RepoRef = row
        ? toRepoRef(row)
        : { installationHost: null, installationId: null, organizationName, repoName };
      const { authedCloneUrl } = await getScmProvider(ref).cloneCredentials(ref);
      const split = splitCloneCredential(authedCloneUrl);
      setupSecrets.push(
        ...[
          split.token,
          split.gitAuthHeader,
          split.gitAuthHeader?.slice(split.gitAuthHeader.lastIndexOf(' ') + 1),
        ].filter((x): x is string => !!x)
      );
      return { authHeader: split.gitAuthHeader, cleanUrl: split.cleanUrl };
    },
    readFile: (filePath, maxBytes) => readWorkspaceFile(filePath, maxBytes),
    redact: (text) => redactSecrets(text, [...cloneSecrets, ...setupSecrets]),
    root: (command, timeoutMs) => {
      const tag = newExecTag();
      return backend.execShell(handle, ['sh', '-c', command], {
        env: [tag.env],
        heartbeatLabel: 'workspace: setup',
        ...phaseSecrets(),
        onTimeout: tag.onTimeout,
        timeoutMs,
      });
    },
    stdin: async (command, body) => {
      const result = await backend.exec(handle, ['sh', '-c', command], {
        heartbeatLabel: 'workspace: restoring the dependency cache',
        ...phaseSecrets(),
        stdin: body,
        timeoutMs: 900_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`${command} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
      }
    },
    sweepProcesses: async () => {
      const tag = newExecTag();
      await backend.execShell(handle, ['sh', '-c', killStrayProcessesScript(handle.keeperPid)], {
        env: [tag.env],
        heartbeatLabel: 'workspace: setup',
        onTimeout: tag.onTimeout,
        timeoutMs: 60_000,
      });
    },
  };
  const setupInputs = () => ({
    cleanUrl,
    detectedStack: options?.detectedStack,
    field: options?.repoSetup?.field,
    gitHost: gitHostOf(cleanUrl),
    image: effectiveImage,
    ...(setupPhase ? { setupEgressPolicy } : {}),
    teamId: options?.teamId ?? null,
  });
  let setupReport: Promise<RepoSetupReport | null> | undefined;
  // Resolved before the network lock (it is read from the base commit, not the tree a caller
  // may move to), so the lock can make room for what the definition needs (LFS storage).
  let resolvedSetup: Awaited<ReturnType<typeof resolveWorkspaceSetup>> = null;
  // Submodules, LFS, cache and steps: all after the lock, on the tree the workspace works on.
  const runResolvedSetup = async (): Promise<RepoSetupReport | null> => {
    if (!resolvedSetup) {
      if (options?.repoSetup?.connectionId && options.repoSetup.recordBlockers !== false) {
        await resolveSetupBlockers(options.repoSetup.connectionId);
      }
      return null;
    }
    const started = Date.now();
    const { setup, source } = resolvedSetup;
    const git = await runSetupGitPhase(setupHost, setup, setupInputs(), gitAuthHeader);
    const secretEnv = await loadSetupSecrets(
      options?.repoSetup?.connectionId ?? null,
      setup.secrets ?? []
    );
    setupSecrets.push(...Object.values(secretEnv));
    const { cache, steps } = await runSetupStepsPhase(setupHost, setup, setupInputs(), secretEnv);
    const report: RepoSetupReport = {
      cache,
      durationMs: Date.now() - started,
      lfs: git.lfs,
      source,
      steps,
      submodules: git.submodules,
    };
    auditLog(`workspace.setup ${containerName} ${JSON.stringify(report)}`);
    if (options?.repoSetup?.connectionId && options.repoSetup.recordBlockers !== false) {
      await resolveSetupBlockers(options.repoSetup.connectionId);
    }
    return report;
  };
  // `PATH=…` pair put on every agent-facing exec once tools are installed; empty otherwise.
  let toolsEnv: string[] = [];
  let mountedKnowledgeBases: MountedKnowledgeBase[] = [];
  let installedTools: InstalledTool[] = [];
  let installLate: Workspace['installTools'];
  // What an error text must never carry: scrubbed before it reaches a trace or a log, not only
  // by the outer catch (a trace is written from inside the try).
  const redactForRecord = (message: string): string =>
    redactSecrets(message, [
      ...cloneSecrets,
      ...(options?.services ?? []).flatMap((service) => Object.values(service.env ?? {})),
      registry?.token,
      egress?.registration.token,
    ]);
  const applyPolicy = async (policy: EgressPolicy, replace = false, prepareOnly = false) => {
    if (policy === 'open') {
      return;
    }
    try {
      await backend.lockEgress(
        handle,
        blockedEgressAllow(gitHostOf(cleanUrl), {
          cleanUrl,
          ...(policy === 'restricted' && egress ? { egressProxyUrl: egress.registration.url } : {}),
          ...(resolvedSetup?.setup.lfs
            ? { lfsHosts: lfsStorageHosts(gitHostOf(cleanUrl), await lfsStorageHostEntries()) }
            : {}),
          registryUrl: registry?.baseUrl,
        }),
        {
          mode: policy,
          ...(replace ? { replace: true } : {}),
          ...(prepareOnly ? { prepareOnly: true } : {}),
        }
      );
    } catch (err) {
      throw egressPolicyFailure(
        `egress policy '${policy}' could not be enforced: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  let transition: Promise<void> | undefined;
  let setupMountNamespace: string | undefined;
  const finishSetup = () => {
    transition ??= (async () => {
      try {
        await setupReport;
        transitioning = true;
        if (backend.kind === 'docker' && infra.runAsRoot) {
          if (!setupMountNamespace || !backend.clearSetupProcesses) {
            throw new Error('trusted setup process cleanup is unavailable');
          }
          await backend.clearSetupProcesses(
            handle,
            clearSetupProcessesScript(handle.keeperPid, true),
            setupMountNamespace
          );
        } else {
          await backend.execShell(
            handle,
            [
              '/usr/bin/env',
              '-i',
              'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
              '/bin/sh',
              '-c',
              clearSetupProcessesScript(handle.keeperPid),
            ],
            {
              heartbeatLabel: 'workspace: verifying setup processes stopped',
              secretEnv: {
                BASH_ENV: '',
                ENV: '',
                LD_AUDIT: '',
                LD_LIBRARY_PATH: '',
                LD_PRELOAD: '',
              },
              timeoutMs: 60_000,
            }
          );
        }
        await applyPolicy(egressPolicy, true);
        if (egressPolicy === 'blocked') {
          await egress?.registration.release();
        }
        setupPhase = false;
        transitioning = false;
        auditLog(
          `workspace.egress ${containerName} ${JSON.stringify({ egressPolicy, setupEgressPolicy })}`
        );
      } catch (err) {
        transitionFailed = true;
        await egress?.registration.release().catch(() => {});
        await registry?.registration.release().catch(() => {});
        await backend.remove(containerName);
        redactExecError(err, [...cloneSecrets, ...setupSecrets]);
        throw egressPolicyFailure(
          `setup transition failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
    return transition;
  };
  try {
    const spec = agentWorkspaceSpec(containerName, effectiveImage, infra, options?.services);
    if (options?.trusted) {
      spec.trusted = true;
    }
    const gitHost = gitHostOf(cleanUrl);
    spec.baselineAllow = gitHost ? [{ host: gitHost }] : [];
    egress = await beginWorkspaceEgress(
      options?.teamId ?? null,
      gitHost ? [gitHost] : [],
      setupEgressPolicy === 'restricted' ? setupEgressPolicy : egressPolicy,
      ...(onboardingEgress ? ([onboardingEgress] as const) : ([] as const))
    );
    if (setupEgressPolicy === 'restricted' && setupPhase && !egress) {
      setupEgressPolicy = egressPolicy;
      setupPhase = false;
    }
    if (egress) {
      spec.reachWorker = true;
      spec.env = [...(spec.env ?? []), ...egress.env];
      spec.secretEnv = { ...spec.secretEnv, ...egress.secretEnv };
    }
    if (registry) {
      // The proxy token is a secret the container needs for its whole life
      // (Corepack and Yarn Berry read it from the environment of every
      // command), so it goes in `secretEnv`: Docker passes it as `-e`, as
      // before; Kubernetes keeps it out of the Pod object.
      const { env, secretEnv } = splitRegistryWorkspaceEnv(registry.env);
      spec.env = [...(spec.env ?? []), ...env];
      spec.secretEnv = { ...spec.secretEnv, ...secretEnv };
    }
    handle = await backend.create(spec);
    if (setupPhase && backend.kind === 'docker' && infra.runAsRoot) {
      setupMountNamespace = (
        await backend.execShell(
          handle,
          [
            '/usr/bin/env',
            '-i',
            'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
            '/bin/readlink',
            `/proc/${handle.keeperPid}/ns/mnt`,
          ],
          {
            heartbeatLabel: 'workspace: recording setup mount namespace',
          }
        )
      ).trim();
      if (!/^mnt:\[\d+\]$/.test(setupMountNamespace)) {
        throw egressPolicyFailure('cannot record the workspace setup mount namespace');
      }
    }

    // Initial exec function (container working directory).
    const rootExec = (
      command: string,
      timeoutMs?: number,
      secretEnv?: Record<string, string>
    ): Promise<string> => {
      const tag = newExecTag();
      return backend.execShell(handle, ['sh', '-c', command], {
        env: [tag.env],
        heartbeatLabel: 'workspace: provisioning',
        onTimeout: tag.onTimeout,
        ...phaseSecrets(secretEnv),
        timeoutMs,
      });
    };

    // A clone of a large repository legitimately outlasts the 2-minute exec
    // default; give it the same 10-minute ceiling as a test run.
    const CLONE_TIMEOUT_MS = 600_000;
    // Clone with the CLEAN url and the credential injected per-call via
    // `-c http.extraheader`, so the token is never on the command line (where a
    // failure would echo it back in `error.message`) and never written to
    // `.git/config`. `--` terminates option parsing so a URL beginning with a
    // dash cannot be read as a git flag.
    const cloneCmd = (args: string): string =>
      gitWithAuthHeader(
        `clone ${args}${args ? ' ' : ''}-- ${shellQuote(cleanUrl)} /workspace/target-repo`,
        Boolean(gitAuthHeader)
      );
    const cloneSecretEnv = gitAuthSecretEnv(gitAuthHeader);

    // Leave a working git on PATH: use it if shipped, install via apk/apt-get
    // when the image can, else fail naming the image contract.
    await rootExec(gitBootstrapScript(effectiveImage));

    // Configure git identity — required for commits in ephemeral containers.
    // Without this, `git commit` fails with "Author identity unknown".
    await rootExec(gitIdentityConfigScript(gitIdentity));

    // Clone repo — shell-quote branch names to prevent injection. With a pinned
    // SHA we need full history (a shallow clone at HEAD may not contain an older
    // commit), then cut the working branch from that exact commit. Without one,
    // the cheap shallow clone at defaultBranch HEAD is used.
    if (checkoutSha) {
      await rootExec(cloneCmd(''), CLONE_TIMEOUT_MS, cloneSecretEnv);
      await rootExec(
        `cd /workspace/target-repo && git checkout -b ${shellQuote(branch)} ${shellQuote(checkoutSha)}`
      );
    } else if (existingBranch) {
      // Check out an existing remote branch directly (the eval-gate path), so
      // the workspace holds the candidate's pushed code rather than a fresh
      // branch cut from defaultBranch HEAD.
      await rootExec(
        cloneCmd(`--depth=50 -b ${shellQuote(branch)}`),
        CLONE_TIMEOUT_MS,
        cloneSecretEnv
      );
    } else {
      await rootExec(
        cloneCmd(`--depth=50 -b ${shellQuote(defaultBranch)}`),
        CLONE_TIMEOUT_MS,
        cloneSecretEnv
      );
      await rootExec(`cd /workspace/target-repo && git checkout -b ${shellQuote(branch)}`);
    }

    // Belt and braces: the clone above already used the clean URL, so `origin`
    // holds no credential — pin it explicitly anyway so a future change to the
    // clone invocation cannot silently persist a token in `.git/config`, where
    // it would leak into any `git remote -v`/`cat .git/config` an agent runs.
    // Network git ops going forward use `workspace.gitAuthed`, which injects
    // the credential per-call instead.
    await rootExec(
      `cd /workspace/target-repo && git remote set-url origin ${shellQuote(cleanUrl)}`
    );
    // The commit the workspace was cut from: where the registry allowlist and the setup
    // definition are read from. HEAD is that commit until after provisioning.
    const cutFrom = options?.trustedBaseBranch
      ? null
      : checkoutSha
        ? checkoutSha
        : existingBranch
          ? null
          : 'HEAD';
    const configBaseBranch = options?.trustedBaseBranch ?? defaultBranch;
    baseRef = async () => {
      if (cutFrom) {
        return cutFrom;
      }
      baseRefFetch ??= (async () => {
        const fetchScript = [
          killStrayProcessesScript(handle.keeperPid),
          authedGitScript('/workspace/target-repo', fetchBranchesSubcommand([configBaseBranch]), {
            authed: Boolean(gitAuthHeader),
            cleanUrl,
          }),
        ].join('\n');
        const tag = newExecTag();
        await backend.execShell(handle, ['sh', '-c', fetchScript], {
          env: [tag.env],
          ...(cloneSecretEnv ? { secretEnv: cloneSecretEnv } : {}),
          heartbeatLabel: 'workspace: fetching the base branch',
          onTimeout: tag.onTimeout,
        });
        return `origin/${configBaseBranch}`;
      })();
      return baseRefFetch;
    };
    trustedBaseSha = (
      await rootExec(`cd /workspace/target-repo && git rev-parse ${shellQuote(await baseRef())}`)
    ).trim();

    // On-demand tools: installed as the exec user into `/workspace/.tools/bin`, then put LAST on
    // the PATH of every later exec (the image's own binaries always win). What a connection declares is read from the BASE ref before
    // the agent has run (never its branch). A failed install fails creation: the run never starts
    // on a toolchain it was told it needs.
    if (options?.tools?.length || options?.toolsFor) {
      const toolExec = (command: string, timeoutMs?: number) => rootExec(command, timeoutMs);
      const attempt = { durationMs: 0, installed: [] as InstalledTool[] };
      let failure: unknown;
      try {
        const requests = [...(options.tools ?? [])];
        if (options.toolsFor) {
          const baseRef = checkoutSha ?? (existingBranch ? 'FETCH_HEAD' : 'HEAD');
          const { requests: declared } = await planWorkspaceTools({
            connectionId: options.toolsFor.connectionId,
            readFile: () =>
              readToolsFileFromBase({
                exec: toolExec,
                prepare: async () => {
                  if (!existingBranch || checkoutSha) {
                    return;
                  }
                  // HEAD is a candidate branch that may carry edits: read the default branch.
                  const fetchScript = [
                    killStrayProcessesScript(handle.keeperPid),
                    authedGitScript(
                      '/workspace/target-repo',
                      `fetch --depth=1 origin ${shellQuote(defaultBranch)}`,
                      { authed: Boolean(gitAuthHeader), cleanUrl }
                    ),
                  ].join('\n');
                  const tag = newExecTag();
                  await backend.execShell(handle, ['sh', '-c', fetchScript], {
                    env: [tag.env],
                    ...(cloneSecretEnv ? { secretEnv: cloneSecretEnv } : {}),
                    heartbeatLabel: 'workspace: fetching base for tools file',
                    onTimeout: tag.onTimeout,
                  });
                },
                ref: baseRef,
              }),
            teamId: options.teamId ?? null,
          });
          const explicit = new Set(requests.map((r) => r.key));
          requests.push(...declared.filter((r) => !explicit.has(r.key)));
        }
        if (requests.length > 0) {
          const catalog = options.toolCatalog ?? (await loadToolCatalog());
          const resolved = resolveToolRequests(requests, catalog);
          for (const r of resolved) {
            if (r.warning) {
              logWarn(r.warning, { tool: r.entry.key, version: r.entry.version });
            }
          }
          const result = await installResolvedTools(toolExec, resolved);
          attempt.durationMs = result.durationMs;
          attempt.installed = result.installed;
          installedTools = result.installed;
          const basePath = (await rootExec('echo "$PATH"')).trim();
          toolsEnv = [toolsPathEnv(basePath)];
        }
      } catch (err) {
        failure = toToolInstallFailure(err);
        throw failure;
      } finally {
        if (attempt.installed.length > 0 || failure !== undefined) {
          await recordToolInstallEvent({
            ...attempt,
            ...(failure !== undefined
              ? {
                  error: redactForRecord(
                    failure instanceof Error ? failure.message : String(failure)
                  ),
                }
              : {}),
          });
        }
      }
    }

    if (options?.toolsFor) {
      const { connectionId } = options.toolsFor;
      let queue: Promise<unknown> = Promise.resolve();
      let failedInstalls = 0;
      const installNow = async (requests: ToolRequest[]): Promise<InstalledTool[]> => {
        let fresh: InstalledTool[] = [];
        let durationMs = 0;
        let failure: unknown;
        try {
          const outcome = await installLateTools({
            ...(options.toolCatalog ? { catalog: options.toolCatalog } : {}),
            connectionId,
            egressPolicy,
            exec: (command, timeoutMs) => rootExec(command, timeoutMs),
            failedAttempts: failedInstalls,
            installed: installedTools,
            requests,
            teamId: options.teamId ?? null,
          });
          fresh = outcome.fresh;
          durationMs = outcome.durationMs;
          if (fresh.length > 0) {
            if (toolsEnv.length === 0) {
              const basePath = (await rootExec('echo "$PATH"')).trim();
              toolsEnv = [toolsPathEnv(basePath)];
            }
            installedTools.push(...fresh);
          }
          return outcome.results;
        } catch (err) {
          failure = err;
          // A refusal ran no installer; only a failed install counts toward the cap.
          if (err instanceof ToolInstallError && !(err instanceof ToolRefusal)) {
            failedInstalls += 1;
          }
          throw err;
        } finally {
          if (fresh.length > 0 || failure !== undefined) {
            await recordToolInstallEvent({
              durationMs,
              installed: fresh,
              ...(failure !== undefined
                ? {
                    error: redactForRecord(
                      failure instanceof Error ? failure.message : String(failure)
                    ),
                  }
                : {}),
            });
          }
        }
      };
      // One install at a time: two concurrent calls must not both count the same free slot.
      installLate = (requests) => {
        const run = queue.then(() => installNow(requests));
        queue = run.catch(() => undefined);
        return run;
      };
    }

    if (registry) {
      const mavenSettings = renderMavenSettings(
        registry.registries,
        registry.baseUrl,
        registry.token
      );
      if (mavenSettings) {
        // Via stdin, like the npmrc: the token lands in a file, never on a command line.
        await rootExec('mkdir -p /workspace/.auto-swe');
        await backend.exec(
          handle,
          [
            'sh',
            '-c',
            'cat > /workspace/.auto-swe/maven-settings.xml && chmod 600 /workspace/.auto-swe/maven-settings.xml',
          ],
          {
            heartbeatLabel: 'workspace: writing registry config',
            stdin: mavenSettings,
          }
        );
      }
      // A workspace with no npm registry (go, pypi and/or maven only) gets none of the npm client files.
      if (registry.registries.some((r) => r.ecosystem === 'npm')) {
        // npmrc via stdin: the token lands in a file, never on a command line.
        const npmrc = renderNpmrc(registry.registries, registry.baseUrl, registry.token);
        await rootExec('mkdir -p /workspace/.auto-swe');
        await backend.exec(
          handle,
          ['sh', '-c', 'cat > /workspace/.auto-swe/npmrc && chmod 600 /workspace/.auto-swe/npmrc'],
          {
            heartbeatLabel: 'workspace: writing registry config',
            stdin: npmrc,
          }
        );
        // The same npmrc lands in the exec user's home: Yarn classic reads
        // `~/.npmrc` (it never honours NPM_CONFIG_USERCONFIG), and npm/pnpm pick
        // it up too — the project .npmrc a repo might carry cannot weaken it.
        const home = (await rootExec('echo $HOME')).trim();
        await backend.exec(
          handle,
          ['sh', '-c', `cat > ${shellQuote(home)}/.npmrc && chmod 600 ${shellQuote(home)}/.npmrc`],
          {
            heartbeatLabel: 'workspace: writing registry config',
            stdin: npmrc,
          }
        );
        // Berry scope overrides live in the exec user's home rc — a project
        // .yarnrc.yml scope entry wins over it, which fails closed.
        const yarnrc = renderYarnrc(registry.registries, registry.baseUrl);
        if (yarnrc) {
          await backend.exec(handle, ['sh', '-c', `cat >> ${shellQuote(home)}/.yarnrc.yml`], {
            heartbeatLabel: 'workspace: writing yarn registry config',
            stdin: yarnrc,
          });
        }
      }
      // The allowlist comes from the ref the workspace was cut from, never the
      // working tree: HEAD after clone, the pinned SHA, or — for an existing
      // branch clone that has no local default — the fetched origin/defaultBranch.
      const ref = await baseRef();
      const execCapture = (command: string, maxOutputBytes?: number) =>
        backend.exec(handle, ['sh', '-c', command], {
          heartbeatLabel: 'workspace: building registry allowlist',
          ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
          timeoutMs: 60_000,
        });
      registry.registration.setAllowlist(await buildRegistryAllowlist(registry, ref, execCapture));
    }

    if (options?.repoSetup) {
      resolvedSetup = await resolveWorkspaceSetup(setupHost, {
        ...setupInputs(),
        baseRef: trustedBaseSha,
      });
    }

    mountedKnowledgeBases = await cloneKnowledgeBases(
      { exec: (command, options) => rootExec(command, options?.timeoutMs, options?.secretEnv) },
      options?.knowledgeBases ?? []
    );

    // Provisioning is done (clone, registry wiring) and no agent code has run: cut the network
    // off now. It fails closed — a throw lands in the catch below, which removes the workspace.
    // `restricted` is locked too: the egress proxy is only cooperative (`HTTP_PROXY`), so the
    // network is confined to the proxy's address (plus the model/registry proxies and git host)
    // and `--noproxy` or a raw socket reaches nothing. `restricted` with an empty team allowlist
    // has no proxy (`egress` is null) and is locked exactly as `blocked`.
    if (setupPhase) {
      if (backend.kind === 'docker' && setupEgressPolicy === 'open') {
        await applyPolicy(egressPolicy, true, true);
      }
      await applyPolicy(setupEgressPolicy, true);
    } else if (egressPolicy === 'blocked' || egressPolicy === 'restricted') {
      try {
        await backend.lockEgress(
          handle,
          blockedEgressAllow(gitHost, {
            cleanUrl,
            ...(egressPolicy === 'restricted' && egress
              ? { egressProxyUrl: egress.registration.url }
              : {}),
            ...(resolvedSetup?.setup.lfs
              ? { lfsHosts: lfsStorageHosts(gitHost, await lfsStorageHostEntries()) }
              : {}),
            registryUrl: registry?.baseUrl,
          }),
          { mode: egressPolicy === 'restricted' ? 'restricted' : 'blocked' }
        );
      } catch (err) {
        throw egressPolicyFailure(
          `egress policy '${egressPolicy}' could not be enforced: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // Setup runs after the lock, as the workspace user: package installs reach the registry
    // proxy, submodules the git host, and nothing else a restricting policy forbids.
    if (onboardingEgress && egress) {
      auditLog(
        `workspace.onboardingDraftEgress ${JSON.stringify({ containerName, draftHostCount: onboardingEgress.additionalHosts.length, nodeId: currentNodeTag()?.specNodeId ?? null, workflowId: currentWorkflowId() })}`
      );
    }
    if (options?.repoSetup && !options.repoSetup.defer) {
      setupReport = Promise.resolve(await runResolvedSetup());
    }
  } catch (err) {
    if (options?.repoSetup?.connectionId && options.repoSetup.recordBlockers !== false) {
      await recordSetupFailure(options.repoSetup.connectionId, err);
    }
    await registry?.registration.release().catch(() => {});
    await egress?.registration.release().catch(() => {});
    await backend.remove(containerName);
    redactExecError(err, setupSecrets);
    // A failed git command rejects with the full command line in
    // `error.message` (and stdout/stderr/cmd) — scrub the credential before
    // it reaches Temporal history or a log line.
    redactExecError(err, [
      ...cloneSecrets,
      ...(options?.services ?? []).flatMap((service) => Object.values(service.env ?? {})),
      registry?.token,
      egress?.registration.token,
    ]);
    throw err;
  }

  if (setupPhase && !options?.repoSetup?.defer) {
    await finishSetup();
  }

  return {
    baseSha: trustedBaseSha,
    containerId: containerName,
    copyFileOut: copyWorkspaceFileOut,
    destroy: async () => {
      await egress?.registration.release().catch(() => {});
      await registry?.registration.release().catch(() => {});
      await backend.remove(containerName);
    },
    egressPolicy,
    readBaseFile: (path) => readSetupFile(setupHost, trustedBaseSha, path),
    ...(setupPhase ? { finishSetup } : {}),
    exec: (command: string, options) => {
      const tag = newExecTag();
      return backend.execShell(handle, ['sh', '-c', command], {
        env: [tag.env, ...toolsEnv],
        heartbeatLabel: 'workspace: exec',
        onTimeout: tag.onTimeout,
        ...phaseSecrets(options?.secretEnv),
        timeoutMs: options?.timeoutMs,
        workdir: '/workspace/target-repo',
      });
    },
    execCapture: (command: string, options) => {
      const tag = newExecTag();
      return backend.exec(handle, ['sh', '-c', command], {
        env: [tag.env, ...toolsEnv],
        heartbeatLabel: 'workspace: exec (capture)',
        ...phaseSecrets(),
        onTimeout: tag.onTimeout,
        timeoutMs: options?.timeoutMs ?? 600_000,
        workdir: '/workspace/target-repo',
      });
    },
    execStdin: async (command: string, stdin: string | Buffer) => {
      const tag = newExecTag();
      const result = await backend.exec(handle, ['sh', '-c', command], {
        env: [tag.env, ...toolsEnv],
        heartbeatLabel: 'workspace: exec (stdin)',
        ...phaseSecrets(),
        onTimeout: tag.onTimeout,
        stdin,
        workdir: '/workspace/target-repo',
      });
      if (result.exitCode !== 0) {
        throw Object.assign(
          new Error(
            `Command failed (exit code ${result.exitCode}${result.signal ? `, ${result.signal}` : ''}): ${command}`
          ),
          { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }
        );
      }
      return result.stdout;
    },
    gitAuthed: async (subcommand: string) => {
      try {
        // The repo has been writable by the agent since clone, so every
        // authenticated call rewrites its config and runs git hardened — see
        // `authedGitScript`. The credential is injected for this call only.
        // Nothing the agent left running may witness the call — the sweep
        // spares only PID 1, the recorded keeper and the script's own tree —
        // so the sweep, the rewrite and the git call share one exec.
        const script = [
          killStrayProcessesScript(handle.keeperPid),
          authedGitScript('/workspace/target-repo', subcommand, {
            authed: Boolean(gitAuthHeader),
            cleanUrl,
          }),
        ].join('\n');
        const tag = newExecTag();
        const secretEnv = gitAuthSecretEnv(gitAuthHeader);
        return await backend.execShell(handle, ['sh', '-c', script], {
          env: [tag.env],
          ...phaseSecrets(secretEnv),
          heartbeatLabel: 'workspace: git',
          onTimeout: tag.onTimeout,
        });
      } catch (err) {
        // Defense in depth: nothing carries the header on a command line now, but a
        // git that echoes its config would still put it in the error text.
        redactExecError(err, cloneSecrets);
        throw err;
      }
    },
    gitIdentity,
    installedTools,
    knowledgeBaseSnapshotIds: [
      ...(options?.knowledgeBaseSnapshotIds ??
        options?.knowledgeBases?.map((kb) => kb.snapshotId) ??
        []),
    ],
    knowledgeBases: mountedKnowledgeBases,
    redact: (text) => redactSecrets(redactForRecord(text), setupSecrets),
    setupEgressPolicy,
    ...(installLate ? { installTools: installLate } : {}),
    readFile: readWorkspaceFile,
    ...(options?.repoSetup
      ? {
          runSetup: (opts?: { again?: boolean }) => {
            if (opts?.again) {
              setupReport = undefined;
            }
            setupReport ??= (async () => {
              try {
                return await runResolvedSetup();
              } catch (err) {
                if (options.repoSetup?.connectionId && options.repoSetup.recordBlockers !== false) {
                  await recordSetupFailure(options.repoSetup.connectionId, err);
                }
                if (setupPhase) {
                  transitionFailed = true;
                  await egress?.registration.release().catch(() => {});
                  await registry?.registration.release().catch(() => {});
                  await backend.remove(containerName);
                }
                redactExecError(err, [...cloneSecrets, ...setupSecrets]);
                throw err;
              }
            })();
            return setupReport;
          },
        }
      : {}),
    killStrays: async () => {
      const tag = newExecTag();
      await backend.execShell(handle, ['sh', '-c', killStrayProcessesScript(handle.keeperPid)], {
        env: [tag.env],
        heartbeatLabel: 'workspace: stopping stray processes',
        onTimeout: tag.onTimeout,
        timeoutMs: 60_000,
      });
    },
  };
}
