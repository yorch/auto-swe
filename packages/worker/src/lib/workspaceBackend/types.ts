import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { CappedFileResult, CapturedResult, OnTimeout } from '../execUtils.js';
import type { WorkspaceReapResult } from './orphans.js';

/**
 * What it takes to start an agent workspace container. The caller describes
 * the workload (name, image, resource caps, DNS, network, worker reachability); the
 * hardening that makes a workspace safe to hand to an agent — `--init`,
 * `--cap-drop=ALL`, `no-new-privileges`, the metadata-IP add-hosts and the
 * `sleep infinity` keeper — is the driver's job and is not negotiable here.
 */
export interface WorkspaceContainerSpec {
  name: string;
  image: string;
  memory: string;
  cpus: number;
  pidsLimit: number;
  dns: string[];
  /**
   * A named network the workspace joins (`WORKSPACE_NETWORK`, a Docker
   * network the worker is also on). A driver with no such concept ignores it.
   */
  network?: string;
  /**
   * The workspace must reach the worker's proxies (model, registry) at the
   * address the deployment advertises. How that address resolves is the
   * driver's business (Docker maps the host alias to the host gateway).
   */
  reachWorker: boolean;
  /** Non-secret `NAME=value` pairs, passed to the container as `docker run -e`. */
  env?: string[];
}

/**
 * A running workspace. `keeperPid` is the in-container PID of the process
 * keeping the workspace alive (`sleep infinity` under Docker's `--init`);
 * the stray-process sweep needs it to spare the keeper — the driver records
 * it at creation because a Kubernetes pod has no `--init` that would make
 * "the only child of PID 1" a safe way to find it later.
 */
export interface WorkspaceHandle {
  readonly id: string;
  readonly keeperPid: number;
}

export interface WorkspaceExecOptions {
  /** Working directory inside the container. */
  workdir?: string;
  /** Non-secret `NAME=value` pairs for `docker exec -e NAME=value`. */
  env?: string[];
  /** Capture cap on stdout/stderr each (default the capture helper's own). */
  maxOutputBytes?: number;
  /** Streamed to the command's stdin. */
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Label pumped into Temporal heartbeats while the command runs. */
  heartbeatLabel: string;
  /** Kills the in-container process tree when the local client times out. */
  onTimeout?: OnTimeout;
}

export interface WorkspaceSpawnOptions {
  workdir?: string;
  env?: string[];
  /**
   * Secrets by name only: the driver must arrange for the value to reach the
   * process without ever putting it on a command line (Docker reads `-e NAME`
   * from its own environment; a Kubernetes exec API takes argv only, so a
   * driver for it must find another channel — this is why secret values are
   * names here, not pairs).
   */
  secretEnv?: Record<string, string>;
  /** Allocate a stdin pipe on the exec (Docker's `-i`); the caller writes to it. */
  stdin?: boolean;
  signal?: AbortSignal;
  stdio: StdioOptions;
}

/**
 * The execution substrate for agent workspaces. One implementation exists —
 * the local Docker daemon — behind this seam so a second driver (e.g.
 * Kubernetes pods) can be added without the workspace, harness and finalize
 * code learning the substrate.
 *
 * Obligations a driver must meet:
 *  - create() applies the workspace hardening (init, cap-drop, no-new-privileges,
 *    `sleep infinity` keeper) itself and records the keeper's in-container PID.
 *  - exec/spawn never place a `secretEnv` *value* on a command line.
 *  - remove() is idempotent.
 */
export interface WorkspaceBackend {
  readonly kind: 'docker' | 'kubernetes';
  /**
   * Start the container, run the metadata-block sidecar when configured
   * (non-fatal as today) and record the keeper PID. Throws on failure; a
   * partially started container is the caller's to remove() by `spec.name`.
   */
  create(spec: WorkspaceContainerSpec): Promise<WorkspaceHandle>;
  /** Rebuild a handle for a container created earlier (e.g. another activity). */
  attach(id: string, keeperPid?: number): WorkspaceHandle;
  /** Run a command and capture stdout/stderr/exitCode without throwing. */
  exec(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): Promise<CapturedResult>;
  /**
   * Run a command and resolve with stdout, rejecting on a non-zero exit with
   * the same error shape `execShellAsync` produces (message + stdout/stderr).
   */
  execShell(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): Promise<string>;
  /**
   * Start a command and return the local client process for streaming
   * (the harness turns drive their binary and tool calls through this).
   */
  spawn(h: WorkspaceHandle, argv: string[], opts: WorkspaceSpawnOptions): ChildProcess;
  /**
   * Copy `path` out of the container into `destTarFile` on the host (a tar
   * stream, as `docker cp` produces). The cap is enforced while streaming.
   */
  copyOut(
    h: WorkspaceHandle,
    path: string,
    destTarFile: string,
    opts?: { maxBytes?: number; timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CappedFileResult>;
  /** Copy a tar stream file on the host into `path` in the container. */
  copyIn(h: WorkspaceHandle, srcTarFile: string, path: string): Promise<void>;
  /** Copy a regular file on the host to `path` in the container (`docker cp <file> <id>:<path>`). */
  copyFileIn(
    h: WorkspaceHandle,
    srcFile: string,
    path: string,
    opts?: { timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CapturedResult>;
  /** Freeze every process in the container (`docker pause`). */
  pause(h: WorkspaceHandle): Promise<void>;
  /** Remove the container; never throws — it may already be gone. */
  remove(idOrHandle: string | WorkspaceHandle): Promise<void>;

  /**
   * Remove workspaces that carry the auto-swe marker and that no live activity
   * can still own (see `orphans.ts` for each driver's criterion). Selection
   * never depends on this process's memory — a workspace started by another
   * worker sharing the substrate is judged by age alone — and the method
   * reports failures in its result instead of throwing.
   */
  reapOrphans(now: Date): Promise<WorkspaceReapResult>;

  /** Create a workspace volume (`docker volume create`). */
  createVolume(name: string): Promise<void>;
  /** Remove a volume; never throws — it may already be gone. */
  removeVolume(name: string): Promise<void>;
  /**
   * Foreground `run --rm`: resolves to the captured result. The caller owns
   * cleanup — `docker run --rm` removes on exit; `remove` in a finally covers
   * a host-process kill mid-run.
   */
  runEphemeral(spec: EphemeralContainerSpec, opts: EphemeralRunOptions): Promise<CapturedResult>;
  /**
   * Detached `run -d --rm` (sidecar transport): resolves to the captured
   * start result — a non-zero exitCode means it never started.
   */
  startDetached(spec: EphemeralContainerSpec, opts: EphemeralRunOptions): Promise<CapturedResult>;
  /**
   * The platform's own helper containers (shellStep's git clone/finalize
   * runs): `docker run --rm -v … --entrypoint … image argv` with no lockdown,
   * no name, no `--` separator. Deliberately separate from `runEphemeral` so
   * no flag on the sandbox spec can ever turn the lockdown off.
   */
  runHelper(spec: HelperContainerSpec, opts: EphemeralRunOptions): Promise<CapturedResult>;
  /**
   * The base URL (`http://host:port`, no trailing slash) at which the worker
   * reaches a detached container's `publishPort` (Docker: the loopback port
   * the mapping landed on).
   */
  sidecarBaseUrl(name: string, containerPort: number): Promise<string>;
  /**
   * Whether a workspace started with `reachWorker` can reach the worker's
   * proxy at `url`, as the deployment advertises it. A caller that wires a
   * workspace to a proxy checks this first and runs without the proxy when
   * it is false.
   */
  canReachWorkerProxy(url: string): boolean;
}

/** A volume mount on an ephemeral container (`-v source:target[:ro]`). */
export interface EphemeralVolumeMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

/**
 * What it takes to run a throwaway container — the shell/container-step
 * sandbox and shellStep's git-helper prep/finalize runs. Two modes:
 *
 * - the sandbox lockdown is applied by the driver (read-only root,
 *   tmpfs /tmp, cap-drop ALL, no-new-privileges) — a caller cannot weaken it,
 *   the same principle as `create()`'s workspace hardening. Platform helper
 *   containers (the git clone/finalize runs) go through `runHelper` instead.
 *
 * Validation of image refs, mount sources and env keys happens in the caller
 * (`lib/ephemeralContainer.ts`) before a spec reaches the driver.
 */
export interface EphemeralContainerSpec {
  /** Container name (`--name`); only meaningful for sandboxed runs. */
  name?: string;
  image: string;
  /** `--entrypoint` override. */
  entrypoint?: string;
  /** argv appended after the image (e.g. `['sh','-c',cmd]` or `['-c',script]`). */
  argv?: string[];
  volumes?: EphemeralVolumeMount[];
  /** `none` (default) has no network; `egress` allows outbound traffic. */
  network?: 'none' | 'egress';
  dns?: string[];
  /** `host:ip` entries (`--add-host`), already resolved by the caller. */
  addHosts?: string[];
  /** The container must reach the worker's proxies; see {@link WorkspaceContainerSpec.reachWorker}. */
  reachWorker?: boolean;
  /** Non-secret `NAME=value` pairs. */
  env?: string[];
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  workdir?: string;
  /** Publish this container port on an ephemeral loopback host port (sidecars). */
  publishPort?: number;
}

/**
 * shellStep's git prep/finalize runs: platform code, no lockdown flags and no
 * caller knobs beyond the mount, env, entrypoint and argv.
 */
export interface HelperContainerSpec {
  image: string;
  entrypoint?: string;
  argv?: string[];
  volumes?: EphemeralVolumeMount[];
  env?: string[];
}

export interface EphemeralRunOptions {
  timeoutMs?: number;
  heartbeatLabel?: string;
  /** Per-line stdout callback (NDJSON transport). */
  onStdoutLine?: (line: string) => void;
  /** Capture cap for stdout/stderr (the capture helper's default otherwise). */
  maxOutputBytes?: number;
}
