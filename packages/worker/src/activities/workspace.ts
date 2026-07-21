import crypto from 'node:crypto';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { type CapturedResult, execShellAsync, spawnCaptureAsync } from '../lib/execUtils.js';

export type CapturedExec = CapturedResult;

export interface Workspace {
  containerId: string;
  exec: (command: string) => Promise<string>;
  /**
   * Run a command and capture stdout/stderr/exitCode without throwing on
   * non-zero exits. Used by quality-gate activities that interpret exit
   * code themselves rather than relying on exec's throw-on-error semantics.
   */
  execCapture: (command: string, options?: { timeoutMs?: number }) => Promise<CapturedExec>;
  /**
   * Run a git subcommand (e.g. `push origin main`) against `origin` with the
   * clone credential injected for this call only via `-c http.extraheader`,
   * rather than a persisted `origin` URL. The credential is never written to
   * `.git/config` — see the scrub in `createWorkspace` after clone.
   */
  gitAuthed: (subcommand: string) => Promise<string>;
  destroy: () => Promise<void>;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Resource caps applied to every workspace container: bound worst-case memory/CPU
// usage from a runaway agent-driven build/test process, and cap process count to
// blunt fork-bomb-style failures.
const WORKSPACE_MEMORY = '4g';
const WORKSPACE_CPUS = 2;
const WORKSPACE_PIDS_LIMIT = 512;

// Cloud metadata-IP egress block (deferred follow-up to the `--add-host`
// hardening below): can be disabled per-deployment with
// `WORKSPACE_BLOCK_METADATA=false` if it misbehaves on a given Docker runtime
// (e.g. `--network container:` unsupported). Default ON.
const BLOCK_METADATA = process.env.WORKSPACE_BLOCK_METADATA !== 'false';

// Small, well-known image with busybox `ip` — used only for the short-lived
// route-install sidecar in `buildMetadataBlockArgs`, never for the workspace
// itself.
const METADATA_BLOCK_IMAGE = 'alpine:3.20';

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
  const routeCmd = [
    'ip route add blackhole 169.254.169.254/32 2>/dev/null || true',
    'ip route add blackhole 169.254.170.2/32 2>/dev/null || true',
    'ip -6 route add blackhole fd00:ec2::254/128 2>/dev/null || true',
    'true',
  ].join('; ');
  return `docker run --rm --network container:${containerName} --cap-add=NET_ADMIN -- ${shellQuote(image)} sh -c ${shellQuote(routeCmd)}`;
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
  image: string = 'node:24-alpine',
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
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    throw new Error(`Invalid Docker image name: ${image}`);
  }

  // Extract the embedded credential from the authed clone URL (if any) so it
  // can be injected per-call via `git -c http.extraheader` instead of being
  // persisted in the cloned repo's `.git/config` as the `origin` remote URL —
  // see the `git remote set-url` scrub below and `gitAuthed` on the returned
  // Workspace. Backward compatible: a plain (unauthenticated) URL just falls
  // through with no auth header.
  let cleanUrl = authedRepoUrl;
  let gitAuthHeader: string | undefined;
  try {
    const u = new URL(authedRepoUrl);
    if (u.password) {
      const token = decodeURIComponent(u.password);
      gitAuthHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      u.username = '';
      u.password = '';
      cleanUrl = u.toString();
    }
  } catch {
    /* non-URL — leave as-is, no auth header */
  }

  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;

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
  await execShellAsync(
    `docker run -d --name ${containerName} --dns=1.1.1.1 --dns=8.8.8.8 --memory=${WORKSPACE_MEMORY} --cpus=${WORKSPACE_CPUS} --pids-limit=${WORKSPACE_PIDS_LIMIT} --cap-drop=ALL --security-opt=no-new-privileges --add-host=metadata.google.internal:0.0.0.0 --add-host=metadata.gke.internal:0.0.0.0 -- ${shellQuote(image)} sleep infinity`,
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
  if (BLOCK_METADATA) {
    try {
      await execShellAsync(buildMetadataBlockArgs(containerName, METADATA_BLOCK_IMAGE), {
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
  const rootExec = (command: string): Promise<string> =>
    execShellAsync(`docker exec ${containerName} sh -c ${shellQuote(command)}`, {
      heartbeatLabel: 'workspace: provisioning',
    });

  // Wrap provisioning in try/catch — destroy the container if any setup step fails
  // to prevent accumulation of orphaned containers on repeated failures.
  try {
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
      await rootExec(`git clone ${shellQuote(authedRepoUrl)} /workspace/target-repo`);
      await rootExec(
        `cd /workspace/target-repo && git checkout -b ${shellQuote(branch)} ${shellQuote(checkoutSha)}`
      );
    } else if (existingBranch) {
      // Check out an existing remote branch directly (the eval-gate path), so
      // the workspace holds the candidate's pushed code rather than a fresh
      // branch cut from defaultBranch HEAD.
      await rootExec(
        `git clone --depth=50 -b ${shellQuote(branch)} ${shellQuote(authedRepoUrl)} /workspace/target-repo`
      );
    } else {
      await rootExec(
        `git clone --depth=50 -b ${shellQuote(defaultBranch)} ${shellQuote(authedRepoUrl)} /workspace/target-repo`
      );
      await rootExec(`cd /workspace/target-repo && git checkout -b ${shellQuote(branch)}`);
    }

    // Scrub the credential out of the persisted `origin` remote URL — `git
    // clone` bakes whatever URL it was given (including the embedded token)
    // into `.git/config`, where it would sit in plaintext for the rest of the
    // container's life and leak into any `git remote -v`/`cat .git/config`
    // an agent runs. Network git ops going forward use `workspace.gitAuthed`,
    // which injects the credential per-call instead.
    await rootExec(
      `cd /workspace/target-repo && git remote set-url origin ${shellQuote(cleanUrl)}`
    );
  } catch (err) {
    try {
      await execShellAsync(`docker rm -f ${containerName}`);
    } catch {
      /* already gone */
    }
    throw err;
  }

  // Builds a git invocation with the credential injected via
  // `-c http.extraheader` for this call only — never written to disk. When
  // the source URL carried no credential (`gitAuthHeader` unset), this is
  // just a plain `git <subcmd>` against the scrubbed `origin` remote.
  const gitAuthedArgs = (subcmd: string) =>
    gitAuthHeader
      ? `git -c http.extraheader=${shellQuote(gitAuthHeader)} ${subcmd}`
      : `git ${subcmd}`;

  return {
    containerId: containerName,
    destroy: async () => {
      try {
        await execShellAsync(`docker rm -f ${containerName}`);
      } catch {
        // Container may already be gone
      }
    },
    exec: (command: string) =>
      execShellAsync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c ${shellQuote(command)}`,
        { heartbeatLabel: 'workspace: exec' }
      ),
    execCapture: (command: string, options) =>
      spawnCaptureAsync(
        'docker',
        ['exec', '-w', '/workspace/target-repo', containerName, 'sh', '-c', command],
        { heartbeatLabel: 'workspace: exec (capture)', timeoutMs: options?.timeoutMs ?? 600_000 }
      ),
    gitAuthed: (subcommand: string) =>
      execShellAsync(
        `docker exec ${containerName} sh -c ${shellQuote(`cd /workspace/target-repo && ${gitAuthedArgs(subcommand)}`)}`,
        { heartbeatLabel: 'workspace: git' }
      ),
  };
}
