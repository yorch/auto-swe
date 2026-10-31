import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@auto-swe/shared/db';
import { detectedStacks } from '@auto-swe/shared/lib/stackDetection';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { assertShellImageAllowed, DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { beginWorkspaceEgress, gitHostOf } from '../lib/egressWiring.js';
import type { CapturedResult, OnTimeout } from '../lib/execUtils.js';
import {
  type GitIdentity,
  gitIdentityConfigScript,
  resolveGitIdentity,
} from '../lib/gitIdentity.js';
import { redactExecError } from '../lib/redactToken.js';
import {
  beginWorkspaceRegistries,
  buildRegistryAllowlist,
  renderMavenSettings,
  renderNpmrc,
  renderYarnrc,
  splitRegistryWorkspaceEnv,
  type WorkspaceRegistryAccess,
} from '../lib/registryProxy/workspaceWiring.js';
import { shellQuote } from '../lib/shellQuote.js';
import { workspaceBackend } from '../lib/workspaceBackend/index.js';
import { readSingleFileFromArchive } from '../lib/workspaceBackend/kubernetes/safeTar.js';
import { agentWorkspaceSpec } from '../lib/workspaceBackend/spec.js';
import type { WorkspaceHandle, WorkspaceServiceSpec } from '../lib/workspaceBackend/types.js';

export type CapturedExec = CapturedResult;

export { buildMetadataBlockArgs } from '../lib/workspaceBackend/docker.js';
export { shellQuote };

export interface Workspace {
  containerId: string;
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
 * config files (`/etc/gitconfig`, `~/.gitconfig` — both writable by an agent
 * running as root in its workspace), and never prompt.
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
 * PID 1 (`docker-init`), the container's `sleep infinity` keeper, and the
 * script's own process tree. `gitAuthed` runs it first, in the same exec as
 * the config rewrite and the credential-bearing git call, for two reasons:
 *
 *  - The credential is in git's environment and `-c http.extraheader=…` is
 *    expanded into its command line, so a process the agent left running
 *    (`nohup … &`) can read it from `/proc/<pid>/cmdline` or `environ`.
 *  - The same process could rewrite `.git/config` between the allow-list
 *    rewrite and git reading it.
 *
 * Processes are stopped (twice, to catch a child forked mid-scan) before any
 * is killed, as in {@link killTaggedProcessesScript}. The keeper's PID comes
 * from the workspace driver, which records it at creation when the `sleep
 * infinity` process is provably the only child of PID 1 — it is not found
 * here because a Kubernetes pod has no `--init`: there the keeper is itself
 * PID 1, so "the lowest-numbered child of PID 1" would name the agent's
 * first process instead, and sparing it would leave it alive to read the
 * git credential off git's command line. Uses only `/proc`, `sed` and `kill`.
 */
export function killStrayProcessesScript(keeperPid: number): string {
  if (!Number.isInteger(keeperPid) || keeperPid <= 0) {
    throw new Error(`invalid keeper pid: ${keeperPid}`);
  }
  return [
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
    '    if [ "$asw_p" = 1 ] || [ "$asw_p" = "$asw_keeper" ] || asw_mine "$asw_p"; then continue; fi',
    '    kill -"$1" "$asw_p" 2>/dev/null || true',
    '  done',
    '}',
    'asw_sweep STOP',
    'asw_sweep STOP',
    'asw_sweep KILL',
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

// Cloud metadata-IP egress block (deferred follow-up to the `--add-host`
// hardening below): can be disabled per-deployment if it misbehaves on a given
// Docker runtime (e.g. `--network container:` unsupported). Default ON.
// `WORKSPACE_BLOCK_METADATA=false` is the only value that turns it off, and the
// sidecar image is `WORKSPACE_METADATA_BLOCK_IMAGE`. Both are deploy-time
// settings: nothing a run, a team, or an admin session can change. The driver
// runs the sidecar in create() — see `buildMetadataBlockArgs`, re-exported
// above.

/**
 * `sh` script that leaves a working `git` on PATH, run as the first exec in a
 * fresh workspace. Three cases:
 *
 *  - git already ships in the image — nothing to do;
 *  - git is missing but a package manager can install it: `apk` on Alpine,
 *    then `apt-get` on Debian/Ubuntu (with `APT::Sandbox::User=root`, because
 *    the container runs `--cap-drop=ALL` and apt's default privilege drop to
 *    the `_apt` user fails without it);
 *  - neither — the image cannot meet the executor image contract (git is
 *    required; see docs/repositories.md) and provisioning fails naming it.
 */
export function gitBootstrapScript(image: string): string {
  return [
    'if ! command -v git >/dev/null 2>&1; then',
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
export const MAX_DEPENDENCY_CHECKOUTS = 4;

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
  workspace: Pick<Workspace, 'exec'>,
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
    } catch {
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
    teamId?: string | null;
    services?: WorkspaceServiceSpec[];
    /**
     * The repository's stored stack detection (`repo.detectedStack`). It decides which
     * non-npm registries are wired; absent or unusable means "unknown".
     */
    detectedStack?: unknown;
  }
): Promise<Workspace> {
  // Container caps, default base image and metadata-blocking policy all come
  // from the environment. A caller-supplied `image` still wins (executor-image
  // override).
  const infra = resolveWorkspaceInfra();
  const effectiveImage = image ?? infra.image;

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
  try {
    const spec = agentWorkspaceSpec(containerName, effectiveImage, infra, options?.services);
    const gitHost = gitHostOf(cleanUrl);
    egress = await beginWorkspaceEgress(options?.teamId ?? null, gitHost ? [gitHost] : []);
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

    // Initial exec function (root of container)
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
        ...(secretEnv ? { secretEnv } : {}),
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
      let ref = 'HEAD';
      if (checkoutSha) {
        ref = checkoutSha;
      } else if (existingBranch) {
        const fetchScript = [
          killStrayProcessesScript(handle.keeperPid),
          authedGitScript('/workspace/target-repo', fetchBranchesSubcommand([defaultBranch]), {
            authed: Boolean(gitAuthHeader),
            cleanUrl,
          }),
        ].join('\n');
        const tag = newExecTag();
        await backend.execShell(handle, ['sh', '-c', fetchScript], {
          env: [tag.env],
          ...(cloneSecretEnv ? { secretEnv: cloneSecretEnv } : {}),
          heartbeatLabel: 'workspace: fetching base for registry allowlist',
          onTimeout: tag.onTimeout,
        });
        ref = `origin/${defaultBranch}`;
      }
      const execCapture = (command: string, maxOutputBytes?: number) =>
        backend.exec(handle, ['sh', '-c', command], {
          heartbeatLabel: 'workspace: building registry allowlist',
          ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
          timeoutMs: 60_000,
        });
      registry.registration.setAllowlist(await buildRegistryAllowlist(registry, ref, execCapture));
    }
  } catch (err) {
    await registry?.registration.release().catch(() => {});
    await egress?.registration.release().catch(() => {});
    await backend.remove(containerName);
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

  return {
    containerId: containerName,
    destroy: async () => {
      await egress?.registration.release().catch(() => {});
      await registry?.registration.release().catch(() => {});
      await backend.remove(containerName);
    },
    exec: (command: string, options) => {
      const tag = newExecTag();
      return backend.execShell(handle, ['sh', '-c', command], {
        env: [tag.env],
        heartbeatLabel: 'workspace: exec',
        onTimeout: tag.onTimeout,
        ...(options?.secretEnv ? { secretEnv: options.secretEnv } : {}),
        timeoutMs: options?.timeoutMs,
        workdir: '/workspace/target-repo',
      });
    },
    execCapture: (command: string, options) => {
      const tag = newExecTag();
      return backend.exec(handle, ['sh', '-c', command], {
        env: [tag.env],
        heartbeatLabel: 'workspace: exec (capture)',
        onTimeout: tag.onTimeout,
        timeoutMs: options?.timeoutMs ?? 600_000,
        workdir: '/workspace/target-repo',
      });
    },
    execStdin: async (command: string, stdin: string | Buffer) => {
      const tag = newExecTag();
      const result = await backend.exec(handle, ['sh', '-c', command], {
        env: [tag.env],
        heartbeatLabel: 'workspace: exec (stdin)',
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
          ...(secretEnv ? { secretEnv } : {}),
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
    readFile: async (filePath: string, maxBytes: number) => {
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
    },
  };
}
