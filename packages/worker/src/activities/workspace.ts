import crypto from 'node:crypto';
import { resolveSettings } from '@auto-swe/shared/config';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { currentRequestContext } from '../lib/config/contextLookup.js';
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
}

/**
 * Split a credential-embedded clone URL (`https://x-access-token:<tok>@host/…`)
 * into a scrubbed URL plus a per-call `http.extraheader` value.
 *
 * This is the single source of truth for "never persist the token in
 * `.git/config`": `createWorkspace` (agent workspaces) and `runShellStep`
 * (ephemeral shell-step volumes) both clone into a filesystem that untrusted
 * code later reads, so both set `origin` to `cleanUrl` right after clone and
 * inject `gitAuthHeader` only on the network calls that need it.
 *
 * Backward compatible: a plain (unauthenticated) or non-URL string falls
 * through unchanged with no auth header.
 */
export function splitCloneCredential(authedRepoUrl: string): SplitCloneCredential {
  try {
    const u = new URL(authedRepoUrl);
    if (u.password) {
      const token = decodeURIComponent(u.password);
      const gitAuthHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      u.username = '';
      u.password = '';
      return { cleanUrl: u.toString(), gitAuthHeader };
    }
  } catch {
    /* non-URL — leave as-is, no auth header */
  }
  return { cleanUrl: authedRepoUrl };
}

/**
 * Build a `git` invocation with the clone credential injected for this call
 * only via `-c http.extraheader`, so it is never written to disk. With no
 * header (unauthenticated remote) this is just a plain `git <subcommand>`.
 *
 * The header is `shellQuote`d here — callers embed the result in a shell
 * script, so this stays the escaping boundary for the credential value.
 */
export function gitWithAuthHeader(subcommand: string, gitAuthHeader?: string): string {
  return gitAuthHeader
    ? `git -c http.extraheader=${shellQuote(gitAuthHeader)} ${subcommand}`
    : `git ${subcommand}`;
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

/**
 * Split an authed clone URL into the credential-free URL and the per-call git
 * auth header, so a token is never persisted in a cloned repo's `.git/config`.
 *
 * Pure. Used by `createWorkspace` for the target repo and by
 * `cloneDependencyRepos` for each dependency clone — both must scrub, so both
 * derive the scrubbed URL the same way. A plain (unauthenticated) URL falls
 * through unchanged with no auth header.
 */
export function splitCloneCredential(authedRepoUrl: string): {
  cleanUrl: string;
  gitAuthHeader?: string;
} {
  try {
    const u = new URL(authedRepoUrl);
    if (u.password) {
      const token = decodeURIComponent(u.password);
      const gitAuthHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      u.username = '';
      u.password = '';
      return { cleanUrl: u.toString(), gitAuthHeader };
    }
  } catch {
    /* non-URL — leave as-is, no auth header */
  }
  return { cleanUrl: authedRepoUrl };
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
  const { cleanUrl, gitAuthHeader } = splitCloneCredential(authedRepoUrl);

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
    // `workspaceMemory` is a DB-backed string, so shell-quote it (the numeric
    // caps can't carry shell metacharacters); defense-in-depth on top of the
    // route-level format validation.
    `docker run -d --name ${containerName} --dns=1.1.1.1 --dns=8.8.8.8 --memory=${shellQuote(cfg.workspaceMemory)} --cpus=${cfg.workspaceCpus} --pids-limit=${cfg.workspacePidsLimit} --cap-drop=ALL --security-opt=no-new-privileges --add-host=metadata.google.internal:0.0.0.0 --add-host=metadata.gke.internal:0.0.0.0 -- ${shellQuote(effectiveImage)} sleep infinity`,
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
  const gitAuthedArgs = (subcmd: string) => gitWithAuthHeader(subcmd, gitAuthHeader);

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
