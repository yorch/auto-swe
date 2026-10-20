import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { CappedFileResult, CapturedResult, OnTimeout } from '../execUtils.js';

/**
 * What it takes to start an agent workspace container. The caller describes
 * the workload (name, image, resource caps, DNS, network, host aliases); the
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
  network?: string;
  addHosts: string[];
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
  /**
   * Raw driver arguments placed before the driver's own env wiring, so the
   * driver's `-e` entries win any name clash. Docker-only escape hatch.
   */
  leadingArgs?: string[];
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
  readonly kind: 'docker';
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
}
