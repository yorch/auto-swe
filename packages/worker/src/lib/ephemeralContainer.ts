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

import crypto from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { type CapturedResult, execShellAsync, spawnCaptureAsync } from './execUtils.js';

export type EphemeralRunResult = CapturedResult;

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
  /** Per-team allowlisted hostnames for DNS-based egress filtering (only used when network === 'egress'). */
  egressAllowlist?: string[];
  /** Docker `--memory` literal, default "512m". */
  memory?: string;
  /** Docker `--cpus` value, default 1.0. */
  cpus?: number;
  /** Wall-clock cap, default 600_000 ms. */
  timeoutMs?: number;
  /** Optional override of the container working directory. Defaults to /workspace. */
  workdir?: string;
}

const MEMORY_RE = /^\d+[bkmg]?$/i;
// Docker volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]+. Host absolute paths start
// with `/`. Either is fine here; the regex rejects anything that could be
// interpreted as a Docker flag (`-`, `--no-...`) when concatenated into the
// `-v src:/workspace:rw` argv slot.
const MOUNT_SOURCE_RE = /^(\/[^:]+|[a-zA-Z0-9][a-zA-Z0-9_.-]+)$/;

/**
 * Build the argv passed to `docker run`. Exposed for testing — the
 * pure-function shape lets us assert flag ordering without invoking docker.
 */
export function buildDockerArgs(input: EphemeralRunInput, containerName: string): string[] {
  if (!DOCKER_IMAGE_REF_RE.test(input.image)) {
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
  const dockerNetwork = network === 'egress' ? 'bridge' : 'none';

  // DNS-based egress filtering: when an allowlist is present, point DNS at an
  // unreachable address so name-based lookups fail for non-allowlisted hosts.
  // --add-host entries for resolved IPs are injected in runEphemeralContainer.
  // Does not block IP-direct connections; wildcard entries are informational only.
  const dnsArgs =
    network === 'egress' && input.egressAllowlist && input.egressAllowlist.length > 0
      ? ['--dns=127.0.0.2']
      : [];

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    `--network=${dockerNetwork}`,
    ...dnsArgs,
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
export async function runEphemeralContainer(input: EphemeralRunInput): Promise<EphemeralRunResult> {
  const containerName = `shellstep-${crypto.randomBytes(8).toString('hex')}`;
  const args = buildDockerArgs(input, containerName);
  const timeoutMs = input.timeoutMs ?? 600_000;

  // DNS-based egress filtering: blocks name-based lookups to non-allowlisted hosts.
  // Does not block IP-direct connections; wildcard entries are informational only.
  if (input.network === 'egress' && input.egressAllowlist && input.egressAllowlist.length > 0) {
    for (const hostname of input.egressAllowlist) {
      if (hostname.startsWith('*')) {
        continue;
      }
      try {
        const { address } = await dnsPromises.lookup(hostname);
        // Insert --add-host flags before the image argument (last 3 args are: image, sh, -c, command)
        const imageIdx = args.indexOf('--');
        args.splice(imageIdx, 0, `--add-host=${hostname}:${address}`);
      } catch {
        console.warn(`[egress-allowlist] DNS lookup failed for ${hostname}; skipping --add-host`);
      }
    }
  }

  try {
    return await spawnCaptureAsync('docker', args, {
      heartbeatLabel: 'shell-step: command running',
      timeoutMs,
    });
  } finally {
    // Defensive cleanup — docker run --rm already removes the container on
    // exit, but if the host process was killed mid-spawn the container may
    // linger. `docker rm -f` is a no-op when the container is already gone.
    try {
      await execShellAsync(`docker rm -f ${containerName}`);
    } catch {
      /* already removed */
    }
  }
}
