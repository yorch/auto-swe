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
import path from 'node:path';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
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
  /**
   * Extra environment variables (`-e KEY=VALUE`). Keys must match
   * `[A-Za-z_][A-Za-z0-9_]*`. Used by container-contract steps (P4/WS4) to pass
   * the JSON input payload (the value is shell-quoted by the caller).
   */
  env?: Record<string, string>;
  /**
   * Optional per-line stdout callback (P5): the NDJSON containerStep transport
   * consumes the container's output line-by-line as it streams. stdout is still
   * fully buffered into the result regardless.
   */
  onStdoutLine?: (line: string) => void;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MEMORY_RE = /^\d+[bkmg]?$/i;
// Docker volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]+. Host absolute paths start
// with `/`. Either is fine here; the regex rejects anything that could be
// interpreted as a Docker flag (`-`, `--no-...`) when concatenated into the
// `-v src:/workspace:rw` argv slot. A host path is additionally checked by
// `isAllowedHostMountPath` — the regex alone accepted any absolute path.
const MOUNT_SOURCE_RE = /^(\/[^:]+|[a-zA-Z0-9][a-zA-Z0-9_.-]+)$/;

// Host directories that must never be bind-mounted read-write into a
// container running an author-supplied command: the Docker socket and the
// daemon's state (a container escape), the root, and the system trees.
const BLOCKED_HOST_MOUNT_ROOTS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/run',
];

/**
 * Whether an absolute host path may be used as the workspace mount source.
 * Every in-repo caller passes a Docker named volume; this is the guard for the
 * host-path form the interface also accepts. The path must already be in
 * canonical form (no `.`/`..` segments — a normalised `/data/../etc` is `/etc`),
 * must not be `/`, and must not sit under a system root. Exported for tests.
 */
export function isAllowedHostMountPath(hostPath: string): boolean {
  if (!hostPath.startsWith('/') || hostPath === '/') {
    return false;
  }
  if (path.posix.normalize(hostPath) !== hostPath) {
    return false;
  }
  return !BLOCKED_HOST_MOUNT_ROOTS.some(
    (root) => hostPath === root || hostPath.startsWith(`${root}/`)
  );
}

/**
 * Validate the shared inputs and emit the lockdown flag block common to every
 * ephemeral container (foreground or sidecar): network, resource caps,
 * read-only root, dropped capabilities, env, and the workspace mount. Keeping
 * this in one place guarantees the sidecar transport inherits the exact same
 * isolation as the foreground runner.
 */
function lockdownFlags(input: Omit<EphemeralRunInput, 'command'>): {
  network: 'none' | 'egress';
  flags: string[];
} {
  if (!DOCKER_IMAGE_REF_RE.test(input.image)) {
    throw new Error(`Invalid Docker image name: ${input.image}`);
  }
  if (!MOUNT_SOURCE_RE.test(input.workspaceMount)) {
    throw new Error(`Invalid workspace mount source: ${input.workspaceMount}`);
  }
  if (input.workspaceMount.startsWith('/') && !isAllowedHostMountPath(input.workspaceMount)) {
    throw new Error(`Host path not allowed as workspace mount source: ${input.workspaceMount}`);
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
  // --add-host entries for resolved IPs are injected in the runners.
  // Does not block IP-direct connections; wildcard entries are informational only.
  const dnsArgs =
    network === 'egress' && input.egressAllowlist && input.egressAllowlist.length > 0
      ? ['--dns=127.0.0.2']
      : [];

  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!ENV_KEY_RE.test(k)) {
      throw new Error(`Invalid environment variable name: ${k}`);
    }
    envArgs.push('-e', `${k}=${v}`);
  }

  return {
    flags: [
      `--network=${dockerNetwork}`,
      ...dnsArgs,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      '--pids-limit=256',
      '--read-only',
      '--tmpfs=/tmp:size=64m,mode=1777',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      ...envArgs,
      '-v',
      `${input.workspaceMount}:/workspace:rw`,
      '-w',
      workdir,
    ],
    network,
  };
}

/**
 * Build the argv passed to `docker run`. Exposed for testing — the
 * pure-function shape lets us assert flag ordering without invoking docker.
 */
export function buildDockerArgs(input: EphemeralRunInput, containerName: string): string[] {
  const { flags } = lockdownFlags(input);
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    ...flags,
    '--',
    input.image,
    'sh',
    '-c',
    input.command,
  ];
}

const PORT_RE = /^\d{1,5}$/;

/**
 * Build the argv for a detached **sidecar** container (P5 sidecar transport):
 * same lockdown as {@link buildDockerArgs}, but `-d` (detached) and the sidecar
 * port published to an ephemeral port on loopback only (`-p 127.0.0.1::PORT`) so
 * the worker — and nothing off-host — can reach it. A `command` override is
 * optional; absent, the image's own entrypoint serves the HTTP contract.
 */
export function buildSidecarDockerArgs(
  input: Omit<EphemeralRunInput, 'command'> & { port: number; command?: string },
  containerName: string
): string[] {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`Invalid sidecar port: ${input.port}`);
  }
  const { flags } = lockdownFlags(input);
  const portArg = String(input.port);
  if (!PORT_RE.test(portArg)) {
    throw new Error(`Invalid sidecar port: ${input.port}`);
  }
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    ...flags,
    // Loopback-only publish; Docker assigns the ephemeral host port.
    '-p',
    `127.0.0.1::${portArg}/tcp`,
    '--',
    input.image,
    ...(input.command ? ['sh', '-c', input.command] : []),
  ];
}

/**
 * DNS-based egress filtering: resolve each allowlisted hostname and splice an
 * `--add-host` flag in before the `--` image separator so name lookups succeed
 * only for allowlisted hosts (non-allowlisted names fail against the
 * unreachable DNS). Mutates `args` in place. Wildcards are informational only;
 * IP-direct connections are not blocked.
 */
async function injectEgressAddHosts(
  input: Pick<EphemeralRunInput, 'network' | 'egressAllowlist'>,
  args: string[]
): Promise<void> {
  if (!(input.network === 'egress' && input.egressAllowlist && input.egressAllowlist.length > 0)) {
    return;
  }
  for (const hostname of input.egressAllowlist) {
    if (hostname.startsWith('*')) {
      continue;
    }
    try {
      const { address } = await dnsPromises.lookup(hostname);
      const imageIdx = args.indexOf('--');
      args.splice(imageIdx, 0, `--add-host=${hostname}:${address}`);
    } catch {
      console.warn(`[egress-allowlist] DNS lookup failed for ${hostname}; skipping --add-host`);
    }
  }
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

  await injectEgressAddHosts(input, args);

  try {
    return await spawnCaptureAsync('docker', args, {
      heartbeatLabel: 'shell-step: command running',
      ...(input.onStdoutLine ? { onStdoutLine: input.onStdoutLine } : {}),
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

export interface SidecarRunInput extends Omit<EphemeralRunInput, 'command'> {
  /** Optional command override; absent, the image's own entrypoint serves HTTP. */
  command?: string;
  /** Container port the sidecar's HTTP server listens on. */
  port: number;
  /** POST path for the request (default '/'). */
  requestPath?: string;
  /** GET path polled until 2xx before the request is sent (default = requestPath). */
  readinessPath?: string;
  /** Max wall-clock to wait for readiness, default 30_000 ms. */
  readyTimeoutMs?: number;
  /** JSON body POSTed to the sidecar; the parsed JSON response is the result. */
  body?: unknown;
}

export interface SidecarRunResult {
  status: number;
  result: unknown;
}

/** Discover the loopback host port Docker published for `containerPort`. */
async function resolvePublishedPort(containerName: string, containerPort: number): Promise<number> {
  const out = await execShellAsync(`docker port ${containerName} ${containerPort}/tcp`);
  // e.g. "127.0.0.1:49162" (possibly multiple lines); take the first host port.
  const m = /:(\d{1,5})\s*$/m.exec(out.trim());
  if (!m) {
    throw new Error(`could not resolve published port for ${containerName}:${containerPort}`);
  }
  return Number(m[1]);
}

/**
 * Run an image as a detached HTTP **sidecar** (P5 sidecar transport): start it
 * with the full ephemeral lockdown + a loopback-only published port, poll its
 * readiness endpoint, POST the JSON `body`, and return the parsed response. The
 * container is always force-removed in `finally`.
 */
export async function runSidecarContainer(input: SidecarRunInput): Promise<SidecarRunResult> {
  const containerName = `sidecar-${crypto.randomBytes(8).toString('hex')}`;
  const args = buildSidecarDockerArgs(input, containerName);
  await injectEgressAddHosts(input, args);
  const requestPath = input.requestPath ?? '/';
  const readinessPath = input.readinessPath ?? requestPath;
  const readyTimeoutMs = input.readyTimeoutMs ?? 30_000;

  try {
    // `docker run -d` prints the container id; failure (non-zero) means it
    // never started — surface stderr.
    const started = await spawnCaptureAsync('docker', args, {
      heartbeatLabel: 'sidecar: starting',
      timeoutMs: 60_000,
    });
    if (started.exitCode !== 0) {
      throw new Error(
        `sidecar failed to start: ${(started.stderr || started.stdout).slice(0, 500)}`
      );
    }
    const hostPort = await resolvePublishedPort(containerName, input.port);
    const baseUrl = `http://127.0.0.1:${hostPort}`;

    await waitForReady(`${baseUrl}${readinessPath}`, readyTimeoutMs);

    const res = await fetch(`${baseUrl}${requestPath}`, {
      body: JSON.stringify(input.body ?? {}),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`sidecar request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    let result: unknown;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`sidecar did not return JSON: ${text.slice(0, 500)}`);
    }
    return { result, status: res.status };
  } finally {
    try {
      await execShellAsync(`docker rm -f ${containerName}`);
    } catch {
      /* already removed */
    }
  }
}

/** Poll a readiness URL until it answers 2xx or the deadline passes. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    heartbeat('sidecar: awaiting readiness');
    await delay(250);
  }
  throw new Error(`sidecar not ready within ${timeoutMs}ms (${lastErr})`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
