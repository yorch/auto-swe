/**
 * Phase-6 ephemeral container runtime for user-authored shell steps.
 *
 * Threat model (stricter than the long-lived agent workspace):
 *   - The command and image come from team-authored spec JSON. We trust the
 *     team-admin author to know the command but not the kernel guarantees, so
 *     the host's job is to make a broken/malicious command unable to escape.
 *   - Workspace is bind-mounted at `/workspace` as the only writable path.
 *     `/tmp` is a small tmpfs so the command can scratch without persisting.
 *   - `--network=none` by default. `'egress'` lets the command reach outbound
 *     (e.g. SBOM upload, dependency lookup) but still has no inbound exposure.
 *   - No Docker socket mount, no privileged flags, no capabilities added,
 *     CPU + memory + PID caps. Container is `--rm`'d immediately on exit.
 *
 * Returns an `{exitCode, stdout, stderr, signal?}` shape compatible with
 * `Workspace.execCapture` so callers can reuse the same downstream handling.
 */

import { type ExecSyncOptions, execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export interface EphemeralRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
}

export interface EphemeralRunInput {
  /** Docker image to run. Caller is expected to have already enforced the allowlist. */
  image: string;
  /** Command passed to `sh -c`. */
  command: string;
  /**
   * Mount source for /workspace. Pass either a Docker named volume or an
   * absolute host path. We don't try to autodetect — DinD environments must
   * use a volume because host paths inside the worker container don't
   * resolve on the docker host.
   */
  workspaceMount: string;
  /** 'none' (default) or 'egress'. */
  network?: 'none' | 'egress';
  /** Docker `--memory` literal, default "512m". */
  memory?: string;
  /** Docker `--cpus` value, default 1.0. */
  cpus?: number;
  /** Wall-clock cap, default 600_000 ms. */
  timeoutMs?: number;
  /** Optional override of the container working directory. Defaults to /workspace. */
  workdir?: string;
}

// Reuse the validation regex from workspace.ts. Image names are also checked
// against the allowlist at workflow start; this is a defense-in-depth shell
// injection guard so even an attacker who slips past the allowlist (or the
// allowlist contains a hostile entry) can't smuggle docker flags through the
// image arg.
const DOCKER_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;
const MEMORY_RE = /^\d+[bkmg]?$/i;
// Docker volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]+. Host absolute paths start
// with `/`. Either is fine here; the regex rejects anything that could be
// interpreted as a Docker flag (`-`, `--no-...`) when concatenated into the
// `-v src:/workspace:rw` argv slot.
const MOUNT_SOURCE_RE = /^(\/[^:]+|[a-zA-Z0-9][a-zA-Z0-9_.-]+)$/;

const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  maxBuffer: 10 * 1024 * 1024,
  timeout: 120_000,
};

/**
 * Build the argv passed to `docker run`. Exposed for testing — the
 * pure-function shape lets us assert flag ordering without invoking docker.
 */
export function buildDockerArgs(input: EphemeralRunInput, containerName: string): string[] {
  if (!DOCKER_IMAGE_RE.test(input.image)) {
    throw new Error(`Invalid Docker image name: ${input.image}`);
  }
  if (!MOUNT_SOURCE_RE.test(input.workspaceMount)) {
    throw new Error(`Invalid workspace mount source: ${input.workspaceMount}`);
  }
  const memory = input.memory ?? '512m';
  if (!MEMORY_RE.test(memory)) {
    throw new Error(`Invalid memory literal: ${memory}`);
  }
  const cpus = input.cpus ?? 1.0;
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 8) {
    throw new Error(`Invalid cpus value: ${cpus}`);
  }
  const network = input.network ?? 'none';
  const workdir = input.workdir ?? '/workspace';
  // Use --network=host's negation: 'none' means no network namespace, 'egress'
  // uses the default bridge (we don't whitelist destinations — Docker doesn't
  // expose per-destination egress filtering without iptables, which we'd need
  // to manage out-of-band on the host).
  const dockerNetwork = network === 'egress' ? 'bridge' : 'none';

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    `--network=${dockerNetwork}`,
    `--memory=${memory}`,
    `--cpus=${cpus}`,
    '--pids-limit=256',
    '--read-only',
    '--tmpfs=/tmp:size=64m,mode=1777',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    '-v',
    `${input.workspaceMount}:/workspace:rw`,
    '-w',
    workdir,
    '--',
    input.image,
    'sh',
    '-c',
    input.command,
  ];
}

/**
 * Run a single user-authored shell command inside a fresh container.
 *
 * The container is `--rm`'d by docker itself on exit; the surrounding
 * try/finally only cleans up if the command starts but the host process is
 * killed before docker tears down (`docker rm -f` is idempotent).
 */
export function runEphemeralContainer(input: EphemeralRunInput): EphemeralRunResult {
  const containerName = `shellstep-${crypto.randomBytes(8).toString('hex')}`;
  const args = buildDockerArgs(input, containerName);
  const timeoutMs = input.timeoutMs ?? 600_000;

  try {
    const result = spawnSync('docker', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    const stderr = result.stderr ?? '';
    if (typeof result.status === 'number') {
      return {
        exitCode: result.status,
        stderr,
        stdout: result.stdout ?? '',
        ...(result.signal ? { signal: result.signal } : {}),
      };
    }
    const errMsg = result.error ? `${result.error.name}: ${result.error.message}` : '';
    const spawnErr = errMsg ? `${stderr}\n${errMsg}`.trim() : stderr;
    const isTimeout = !!result.signal || /ETIMEDOUT/.test(errMsg);
    return {
      exitCode: isTimeout ? 124 : 127,
      signal: result.signal ?? (isTimeout ? 'SIGTERM' : 'SPAWN_ERROR'),
      stderr: spawnErr,
      stdout: result.stdout ?? '',
    };
  } finally {
    // Defensive cleanup — docker run --rm already removes the container on
    // exit, but if the host process was killed mid-spawn the container may
    // linger. `docker rm -f` is a no-op when the container is already gone.
    try {
      execSync(`docker rm -f ${containerName}`, EXEC_OPTS);
    } catch {
      /* already removed */
    }
  }
}
