import crypto from 'node:crypto';
import { resolveSettings } from '@auto-swe/shared/config';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import {
  type CapturedResult,
  execShellAsync,
  type OnTimeout,
  spawnCaptureAsync,
  spawnWithStdinAsync,
} from '../lib/execUtils.js';
import { redactExecError } from '../lib/redactToken.js';

export type CapturedExec = CapturedResult;

export interface Workspace {
  containerId: string;
  /**
   * Run a command and resolve with stdout; rejects on non-zero exit. The
   * default 2-minute timeout suits git/file operations — pass `timeoutMs` for
   * anything that legitimately runs longer (test suites, builds).
   */
  exec: (command: string, options?: { timeoutMs?: number }) => Promise<string>;
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

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
];

/**
 * Environment for a credential-bearing git call: ignore the system and global
 * config files (`/etc/gitconfig`, `~/.gitconfig` — both writable by an agent
 * running as root in its workspace), and never prompt.
 */
const HARDENED_GIT_ENV = 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0';

/**
 * Build a hardened `git` invocation, with the clone credential (when there is
 * one) injected for this call only via `-c http.extraheader`, so it is never
 * written to disk. See {@link HARDENED_GIT_CONFIG} for what the hardening
 * neutralises. The empty `http.extraheader=` first resets the multi-valued
 * list, so no header from a config file rides along.
 *
 * The header is `shellQuote`d here — callers embed the result in a shell
 * script, so this stays the escaping boundary for the credential value.
 */
export function gitWithAuthHeader(subcommand: string, gitAuthHeader?: string): string {
  const flags = HARDENED_GIT_CONFIG.map((kv) => `-c ${kv}`);
  if (gitAuthHeader) {
    flags.push('-c http.extraheader=', `-c http.extraheader=${shellQuote(gitAuthHeader)}`);
  }
  return `${HARDENED_GIT_ENV} git ${flags.join(' ')} ${subcommand}`;
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
 *  - The credential is on git's command line (`-c http.extraheader=…`), and a
 *    process the agent left running (`nohup … &`) can read every other
 *    process's `/proc/<pid>/cmdline`.
 *  - The same process could rewrite `.git/config` between the allow-list
 *    rewrite and git reading it.
 *
 * Processes are stopped (twice, to catch a child forked mid-scan) before any
 * is killed, as in {@link killTaggedProcessesScript}. The keeper is the
 * lowest-numbered child of PID 1 — the first thing the container started. If
 * PID reuse ever handed an agent process a lower number, the keeper is the
 * one killed and the container stops before the git call runs: the failure
 * is closed. Uses only `/proc`, `sed` and `kill`.
 */
export function killStrayProcessesScript(): string {
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
    'asw_keeper=',
    'for asw_d in /proc/[0-9]*; do',
    `  asw_p=\${asw_d#/proc/}`,
    '  if [ "$(asw_ppid "$asw_p")" = 1 ] && { [ -z "$asw_keeper" ] || [ "$asw_p" -lt "$asw_keeper" ]; }; then asw_keeper=$asw_p; fi',
    'done',
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
  opts: { cleanUrl: string; gitAuthHeader?: string }
): string {
  const explicit = subcommand.replace(
    /^push origin(?=\s|$)/,
    `push --no-verify ${shellQuote(opts.cleanUrl)}`
  );
  return [
    'set -e',
    `cd ${shellQuote(repoDir)}`,
    sanitizeGitRepoConfigScript(opts.cleanUrl),
    gitWithAuthHeader(explicit, opts.gitAuthHeader),
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
 * check below.
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
// are resolved per-call from the DB-backed workflow defaults — see
// `createWorkspace` (defaults: 4g / 2 CPU / 512 pids / node:24-alpine).

// Cloud metadata-IP egress block (deferred follow-up to the `--add-host`
// hardening below): can be disabled per-deployment if it misbehaves on a given
// Docker runtime (e.g. `--network container:` unsupported). Default ON.
//
// Both this and the sidecar image are now registry settings rather than a
// module-scope constant and an env var read once at import: a security control
// an operator cannot see the current value of is one they cannot audit. The
// `WORKSPACE_BLOCK_METADATA` env var still works as the fallback, so a
// deployment that sets it keeps its behaviour until an admin saves an override.

/**
 * Build the `docker run` invocation for the short-lived metadata-block sidecar.
 *
 * Why a sidecar rather than doing this in the workspace container itself: the
 * workspace runs with `--cap-drop=ALL` (see `createWorkspace` below) so it has
 * no `NET_ADMIN` and cannot install routes on its own network stack. Instead,
 * a *separate*, throwaway container joins the workspace's network namespace
 * via `--network container:<containerName>` with `NET_ADMIN` added just long
 * enough to install blackhole routes for the cloud metadata IPs, then exits
 * (`--rm`). The routes live in the shared netns and persist after the sidecar
 * is gone, so the long-lived agent-controlled workspace container never holds
 * `NET_ADMIN` itself.
 *
 * Blocked addresses: `169.254.169.254` (AWS/GCP/Azure IMDS), `169.254.170.2`
 * (ECS task metadata endpoint), `fd00:ec2::254` (IPv6 IMDS). Each `ip route
 * add` is `|| true`'d so a route that already exists (or an `ip -6` on a
 * netns without IPv6) doesn't fail the whole sidecar.
 *
 * Pure and side-effect-free — returns the command string for the caller to
 * exec, so it's unit-testable without a Docker daemon. The route-install
 * behavior itself (does the workspace actually lose IMDS reachability
 * afterward?) still requires a real-Docker smoke test; there is no Docker
 * daemon available in CI or this sandbox to exercise it end-to-end.
 */
export function buildMetadataBlockArgs(containerName: string, image: string): string {
  // Install the IPv4 IMDS blackholes, then VERIFY at least one landed: if the
  // runtime's `ip` applet doesn't support `blackhole` routes, the adds fail
  // silently and this control would otherwise be a no-op with no signal. The
  // final `grep`/`exit 1` makes that case surface as a non-zero exit, which the
  // caller's try/catch logs as a warning instead of a false success. The IPv6
  // add stays soft (a netns without IPv6 legitimately can't add it, and IMDS is
  // IPv4), so it isn't part of the success check.
  const routeCmd = [
    'ip route add blackhole 169.254.169.254/32 2>/dev/null',
    'ip route add blackhole 169.254.170.2/32 2>/dev/null',
    'ip -6 route add blackhole fd00:ec2::254/128 2>/dev/null || true',
    'ip route show 2>/dev/null | grep -q blackhole || ' +
      '{ echo "metadata block: no blackhole route installed (ip may lack blackhole support)" >&2; exit 1; }',
  ].join('; ');
  return `docker run --rm --network container:${containerName} --cap-add=NET_ADMIN -- ${shellQuote(image)} sh -c ${shellQuote(routeCmd)}`;
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
 * applies the same scrub to every dependency clone — the credential is used for
 * the clone itself and then removed from `origin`, so no token survives in the
 * container. Dependency credentials are never attached to the returned
 * `Workspace`: these checkouts are read-only reference material, and nothing in
 * the workspace can push to them.
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
    const { cleanUrl } = splitCloneCredential(dep.authedCloneUrl);
    const branchArg = dep.branch ? `-b ${shellQuote(dep.branch)} ` : '';
    try {
      // `--` terminates option parsing: a URL that begins with a dash is then
      // a path, not a git flag (`--upload-pack=…` and friends).
      await workspace.exec(
        `git clone --depth=1 ${branchArg}-- ${shellQuote(dep.authedCloneUrl)} ${shellQuote(path)}`
      );
      // Same scrub as the target repo: `git clone` bakes the credential into
      // `.git/config`, where an agent could read it back out.
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
   * Pass `repo.executorImage ?? undefined`, never `repo.executorImage ?? '<some
   * image>'`. A literal here is not a fallback — it is a value, so it wins the
   * `??` below and `workspaceImage` is never consulted. Every caller used to do
   * exactly that, which made the admin's /govern/workflow-defaults setting unreachable
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
  existingBranch?: boolean
): Promise<Workspace> {
  // Resolve container caps + default base image from the DB-backed workflow
  // defaults. A caller-supplied `image` still wins (executor-image override).
  const cfg = await resolveWorkflowDefaults();
  const effectiveImage = image ?? cfg.workspaceImage;

  // Metadata-blocking policy for this workspace. Resolved through the run's
  // scope so a deployment can see and change it from the dashboard; both keys
  // are platform-wide, so the context only affects caching, not the answer.
  const {
    'workspace.blockMetadata': blockMetadata,
    'workspace.metadataBlockImage': metadataBlockImage,
  } = await resolveSettings(
    ['workspace.blockMetadata', 'workspace.metadataBlockImage'],
    await currentRequestContext()
  );

  if (!DOCKER_IMAGE_REF_RE.test(effectiveImage)) {
    throw new Error(`Invalid Docker image name: ${effectiveImage}`);
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

  // Every command run in the container carries a fresh tag, and a command that
  // outlives its timeout has its whole in-container process tree killed by
  // that tag. Killing the local `docker exec` client alone — all a timeout used
  // to do — leaves the command running inside the container.
  const newExecTag = (): { env: string; onTimeout: OnTimeout } => {
    const execId = crypto.randomBytes(8).toString('hex');
    return {
      env: `${EXEC_TAG_ENV}=${execId}`,
      onTimeout: async () => {
        await execShellAsync(
          `docker exec ${containerName} sh -c ${shellQuote(killTaggedProcessesScript(execId))}`,
          { heartbeatLabel: 'workspace: killing timed-out command', timeoutMs: 30_000 }
        );
      },
    };
  };

  // Start container — use '--' to separate docker flags from the image argument.
  // Pin public DNS resolvers (Cloudflare + Google) so name resolution doesn't
  // depend on Docker's embedded forwarder, which intermittently times out when
  // the host's upstream DNS is briefly unreachable (e.g. VPN/hotspot/sleep) and
  // breaks long-running git operations like clone/push mid-job.
  //
  // Hardening notes (unlike the locked-down `ephemeralContainer` runner, this
  // workspace intentionally keeps default bridge networking and omits
  // `--read-only`/`--tmpfs`: the implementer agent needs outbound git
  // clone/push + `npm install` and writes freely to its own container layer
  // for the duration of the run):
  //  - `--memory`/`--cpus`/`--pids-limit` bound a runaway agent-driven build
  //    or test process instead of letting it exhaust the host.
  //  - `--cap-drop=ALL` + `--security-opt=no-new-privileges` remove Linux
  //    capabilities and privilege-escalation the workspace never needs.
  //  - `--add-host` blackholes the *hostname* form of the GCP metadata
  //    endpoint (`metadata.google.internal`/`metadata.gke.internal`) so an
  //    agent can't trivially exfiltrate the host's cloud credentials through
  //    it. This does NOT block the metadata service's link-local IP
  //    (169.254.169.254) directly — an agent could still reach it by IP.
  //    That gap is closed below via a short-lived privileged sidecar (see
  //    `buildMetadataBlockArgs`) run right after this container starts, since
  //    installing the route here would need `NET_ADMIN`, which conflicts
  //    with `--cap-drop=ALL`.
  //
  // Everything from `docker run` on sits inside one try: the container has a
  // deterministic name before it exists, so any failure — including a
  // `docker run` whose client timed out after the daemon had already created
  // the container — removes it by that name instead of leaking it.
  try {
    await execShellAsync(
      // `workspaceMemory` is a DB-backed string, so shell-quote it (the numeric
      // caps can't carry shell metacharacters); defense-in-depth on top of the
      // route-level format validation.
      `docker run -d --name ${containerName} --init --dns=1.1.1.1 --dns=8.8.8.8 --memory=${shellQuote(cfg.workspaceMemory)} --cpus=${cfg.workspaceCpus} --pids-limit=${cfg.workspacePidsLimit} --cap-drop=ALL --security-opt=no-new-privileges --add-host=metadata.google.internal:0.0.0.0 --add-host=metadata.gke.internal:0.0.0.0 -- ${shellQuote(effectiveImage)} sleep infinity`,
      { heartbeatLabel: 'workspace: starting container' }
    );

    // Cloud metadata-IP egress block (deferred follow-up, now implemented): run
    // a throwaway sidecar that shares this container's network namespace to
    // install blackhole routes for the metadata IPs — see `buildMetadataBlockArgs`
    // for the full rationale. Best-effort and non-fatal: a failure here (e.g. an
    // unsupported `--network container:` mode on some Docker runtime) must not
    // break every workspace run, especially since the primary IMDS
    // credential-exfil vector — leaking the *host's* cloud credentials pulled
    // from the metadata service — is already mitigated by the credential
    // scrubbing elsewhere in this function. This path has no daemon available to
    // smoke-test in CI/this sandbox; it still needs a real-Docker validation
    // pass before being relied on in production.
    if (blockMetadata) {
      try {
        await execShellAsync(buildMetadataBlockArgs(containerName, metadataBlockImage), {
          heartbeatLabel: 'workspace: blocking metadata-IP egress',
        });
      } catch (err) {
        console.warn(
          `workspace ${containerName}: metadata-IP egress block failed, continuing without it — ` +
            `agent may be able to reach cloud metadata endpoints by IP: ${
              err instanceof Error ? err.message : String(err)
            }`
        );
      }
    }

    // Initial exec function (root of container)
    const rootExec = (command: string, timeoutMs?: number): Promise<string> => {
      const tag = newExecTag();
      return execShellAsync(
        `docker exec -e ${tag.env} ${containerName} sh -c ${shellQuote(command)}`,
        { heartbeatLabel: 'workspace: provisioning', onTimeout: tag.onTimeout, timeoutMs }
      );
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
        gitAuthHeader
      );

    // Install git if not present (alpine images may not have it)
    await rootExec('which git || apk add --no-cache git');

    // Configure git identity — required for commits in ephemeral containers.
    // Without this, `git commit` fails with "Author identity unknown".
    await rootExec("git config --global user.name 'auto-swe'");
    await rootExec("git config --global user.email 'auto-swe@localhost'");

    // Clone repo — shell-quote branch names to prevent injection. With a pinned
    // SHA we need full history (a shallow clone at HEAD may not contain an older
    // commit), then cut the working branch from that exact commit. Without one,
    // the cheap shallow clone at defaultBranch HEAD is used.
    if (checkoutSha) {
      await rootExec(cloneCmd(''), CLONE_TIMEOUT_MS);
      await rootExec(
        `cd /workspace/target-repo && git checkout -b ${shellQuote(branch)} ${shellQuote(checkoutSha)}`
      );
    } else if (existingBranch) {
      // Check out an existing remote branch directly (the eval-gate path), so
      // the workspace holds the candidate's pushed code rather than a fresh
      // branch cut from defaultBranch HEAD.
      await rootExec(cloneCmd(`--depth=50 -b ${shellQuote(branch)}`), CLONE_TIMEOUT_MS);
    } else {
      await rootExec(cloneCmd(`--depth=50 -b ${shellQuote(defaultBranch)}`), CLONE_TIMEOUT_MS);
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
  } catch (err) {
    try {
      await execShellAsync(`docker rm -f ${containerName}`);
    } catch {
      /* already gone */
    }
    // A failed git command rejects with the full command line in
    // `error.message` (and stdout/stderr/cmd) — scrub the credential before
    // it reaches Temporal history or a log line.
    redactExecError(err, cloneSecrets);
    throw err;
  }

  return {
    containerId: containerName,
    destroy: async () => {
      try {
        await execShellAsync(`docker rm -f ${containerName}`);
      } catch {
        // Container may already be gone
      }
    },
    exec: (command: string, options) => {
      const tag = newExecTag();
      return execShellAsync(
        `docker exec -w /workspace/target-repo -e ${tag.env} ${containerName} sh -c ${shellQuote(command)}`,
        {
          heartbeatLabel: 'workspace: exec',
          onTimeout: tag.onTimeout,
          timeoutMs: options?.timeoutMs,
        }
      );
    },
    execCapture: (command: string, options) => {
      const tag = newExecTag();
      return spawnCaptureAsync(
        'docker',
        ['exec', '-w', '/workspace/target-repo', '-e', tag.env, containerName, 'sh', '-c', command],
        {
          heartbeatLabel: 'workspace: exec (capture)',
          onTimeout: tag.onTimeout,
          timeoutMs: options?.timeoutMs ?? 600_000,
        }
      );
    },
    execStdin: async (command: string, stdin: string | Buffer) => {
      const tag = newExecTag();
      const result = await spawnWithStdinAsync(
        'docker',
        [
          'exec',
          '-i',
          '-w',
          '/workspace/target-repo',
          '-e',
          tag.env,
          containerName,
          'sh',
          '-c',
          command,
        ],
        stdin,
        { heartbeatLabel: 'workspace: exec (stdin)', onTimeout: tag.onTimeout }
      );
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
        // Nothing the agent left running may witness the call — see
        // `killStrayProcessesScript` — so the sweep, the rewrite and the git
        // call share one exec.
        const script = [
          killStrayProcessesScript(),
          authedGitScript('/workspace/target-repo', subcommand, { cleanUrl, gitAuthHeader }),
        ].join('\n');
        const tag = newExecTag();
        return await execShellAsync(
          `docker exec -e ${tag.env} ${containerName} sh -c ${shellQuote(script)}`,
          { heartbeatLabel: 'workspace: git', onTimeout: tag.onTimeout }
        );
      } catch (err) {
        // Same leak as a failed clone: the auth header is on the command line.
        redactExecError(err, cloneSecrets);
        throw err;
      }
    },
  };
}
