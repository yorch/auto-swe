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
import { activityCancellationSignal } from './cancellation.js';
import { beginEgressAccess } from './egressWiring.js';
import { type CapturedResult, withHeartbeat } from './execUtils.js';
import { workspaceBackend } from './workspaceBackend/index.js';
import type { EphemeralContainerSpec } from './workspaceBackend/types.js';

export type EphemeralRunResult = CapturedResult;

export interface EphemeralRunInput {
  /** Docker image to run. Caller is expected to have already enforced the allowlist. */
  image: string;
  /**
   * Command passed to `sh -c`. Omit to run the image's own entrypoint (`CMD`),
   * which is the documented contract for a container-contract step whose image
   * knows how to read `CONTAINER_STEP_INPUT` and print its JSON result. A `shell`
   * node always supplies one — its schema requires `command`.
   */
  command?: string;
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
  /** Wall-clock cap, default 600_000 ms; never more than {@link SANDBOX_COMMAND_MAX_MS}. */
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
   * Secret environment variables (name → value) for the container. Delivered as
   * `-e NAME` with the value in the docker client's own environment, so it is on
   * no command line (`ps`) — use it for any credential. Names follow the same
   * rule as {@link EphemeralRunInput.env}.
   */
  secretEnv?: Record<string, string>;
  /**
   * The container must reach the worker's package-registry proxy at the
   * address the deployment advertises (the driver wires the alias).
   */
  reachWorker?: boolean;
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
  // Names only: a secret's value never goes in an argv. The live runners hand it to
  // the driver as `EphemeralContainerSpec.secretEnv`; the argv builders below
  // (`buildDockerArgs`, `buildSidecarDockerArgs`) are not on that path and omit it.
  for (const k of Object.keys(input.secretEnv ?? {})) {
    if (!ENV_KEY_RE.test(k)) {
      throw new Error(`Invalid environment variable name: ${k}`);
    }
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
    // Absent a command, the image's own entrypoint/CMD runs — so a
    // container-contract image can own how it is invoked.
    ...(input.command ? ['sh', '-c', input.command] : []),
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

/** A step's command wall clock when its node sets no `timeoutMs`. */
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Ceiling on a `shell` / `containerStep` command's wall clock, whatever its node's
 * `timeoutMs` says. The spec admits up to an hour, but the step's activity has the
 * same hour as its `startToCloseTimeout` (`shellActivities` / `containerStepActivities`
 * in `workflows/runnableActivities.ts`), and a shell step also clones before the
 * command and commits and pushes after it. A command allowed the whole hour lets
 * the activity time out first, and the sandbox retry policy then starts a second
 * attempt while the first may still push. The cap leaves ten minutes for the rest.
 * Clamped at run time rather than in the schema, so stored specs stay valid.
 */
export const SANDBOX_COMMAND_MAX_MS = 50 * 60_000;

/** The command wall clock a step actually gets: its `timeoutMs`, capped. */
export function sandboxCommandTimeoutMs(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_COMMAND_TIMEOUT_MS, SANDBOX_COMMAND_MAX_MS);
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
  const timeoutMs = sandboxCommandTimeoutMs(input.timeoutMs);
  const backend = workspaceBackend();
  const egress =
    input.network === 'egress' ? await beginEgressAccess(input.egressAllowlist ?? []) : null;
  try {
    const spec = await ephemeralSpec(egressInput(input, egress), containerName);
    return await backend.runEphemeral(spec, {
      heartbeatLabel: 'shell-step: command running',
      ...(input.onStdoutLine ? { onStdoutLine: input.onStdoutLine } : {}),
      timeoutMs,
    });
  } finally {
    await egress?.registration.release();
    // `docker run --rm` removes the container on exit; this only covers a
    // host-process kill mid-run. remove() is a no-op when already gone.
    await backend.remove(containerName);
  }
}

/**
 * The EphemeralRunInput → EphemeralContainerSpec mapping. Every lockdown flag
 * is the driver's; what is left here is validation plus the caller-chosen
 * knobs (mount, env, resource caps, network mode, resolved egress hosts).
 */
async function ephemeralSpecFromInput(
  input: EphemeralRunInput,
  containerName: string
): Promise<EphemeralContainerSpec> {
  // lockdownFlags still does all the input validation (and its return value's
  // network mode feeds the spec); the flag block itself is the driver's.
  const { network } = lockdownFlags(input);
  const addHosts: string[] = [];
  if (network === 'egress' && input.egressAllowlist) {
    for (const hostname of input.egressAllowlist) {
      if (hostname.startsWith('*')) {
        continue;
      }
      try {
        const { address } = await dnsPromises.lookup(hostname);
        addHosts.push(`${hostname}:${address}`);
      } catch {
        console.warn(`[egress-allowlist] DNS lookup failed for ${hostname}; skipping --add-host`);
      }
    }
  }
  return {
    addHosts,
    argv: input.command ? ['sh', '-c', input.command] : undefined,
    cpus: input.cpus,
    dns:
      network === 'egress' && input.egressAllowlist && input.egressAllowlist.length > 0
        ? ['127.0.0.2']
        : [],
    env: Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`),
    image: input.image,
    memory: input.memory,
    name: containerName,
    network,
    reachWorker: input.reachWorker,
    ...(input.secretEnv && Object.keys(input.secretEnv).length > 0
      ? { secretEnv: input.secretEnv }
      : {}),
    volumes: [{ source: input.workspaceMount, target: '/workspace' }],
    workdir: input.workdir ?? '/workspace',
  };
}
const ephemeralSpec = ephemeralSpecFromInput;

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
  stdout?: string;
  stderr?: string;
}

/**
 * Run an image as a detached HTTP **sidecar** (P5 sidecar transport): start it
 * with the full ephemeral lockdown + a loopback-only published port, poll its
 * readiness endpoint, POST the JSON `body`, and return the parsed response. The
 * container is always force-removed in `finally`.
 */
export async function runSidecarContainer(input: SidecarRunInput): Promise<SidecarRunResult> {
  const containerName = `sidecar-${crypto.randomBytes(8).toString('hex')}`;
  const backend = workspaceBackend();
  const requestPath = input.requestPath ?? '/';
  const readinessPath = input.readinessPath ?? requestPath;
  const readyTimeoutMs = input.readyTimeoutMs ?? 30_000;
  const egress = await beginEgressAccess(input.egressAllowlist ?? []);

  try {
    // A non-zero exit means the sidecar never started — surface stderr.
    const spec = await ephemeralSpecFromInput(egressInput(input, egress), containerName);
    spec.publishPort = input.port;
    const started = await backend.startDetached(spec, {
      heartbeatLabel: 'sidecar: starting',
      timeoutMs: 60_000,
    });
    if (started.exitCode !== 0) {
      throw new Error(
        `sidecar failed to start: ${(started.stderr || started.stdout).slice(0, 500)}`
      );
    }
    const baseUrl = await backend.sidecarBaseUrl(containerName, input.port);

    await waitForReady(`${baseUrl}${readinessPath}`, readyTimeoutMs);

    // The sidecar runs author-supplied code: a request it never answers must
    // not hold the activity open forever. The step's wall-clock cap bounds the
    // request, and an activity cancellation aborts it. The request can outlast
    // the activity's heartbeat timeout, so it is heartbeated while it waits.
    const cancellation = activityCancellationSignal();
    const timeout = AbortSignal.timeout(sandboxCommandTimeoutMs(input.timeoutMs));
    const { res, text } = await withHeartbeat(
      'sidecar: request',
      (async () => {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          body: JSON.stringify(input.body ?? {}),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout,
        });
        return { res: response, text: await response.text() };
      })()
    );
    if (!res.ok) {
      throw new Error(`sidecar request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    let result: unknown;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`sidecar did not return JSON: ${text.slice(0, 500)}`);
    }
    const logs = await backend.containerLogs(containerName).catch(() => undefined);
    return { result, status: res.status, stderr: logs?.stderr, stdout: logs?.stdout };
  } catch (err) {
    const logs = await backend.containerLogs(containerName).catch(() => undefined);
    if (err instanceof Error && logs) {
      Object.assign(err, { stderr: logs.stderr, stdout: logs.stdout });
    }
    throw err;
  } finally {
    await egress?.registration.release();
    await backend.remove(containerName);
  }
}

function egressInput<T extends EphemeralRunInput>(
  input: T,
  access: Awaited<ReturnType<typeof beginEgressAccess>>
): T {
  return access
    ? {
        ...input,
        env: { ...input.env, ...Object.fromEntries(access.env.map((pair) => pair.split('='))) },
        reachWorker: true,
        secretEnv: { ...input.secretEnv, ...access.secretEnv },
      }
    : input;
}

/** Upper bound on one readiness probe, so a stalled accept cannot eat the whole deadline. */
const READINESS_PROBE_TIMEOUT_MS = 5_000;

/** Poll a readiness URL until it answers 2xx or the deadline passes. */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      // Each probe is bounded by the shorter of the per-probe cap and what is
      // left of the overall deadline; a sidecar that accepts the connection but
      // never responds otherwise blocks the loop past `timeoutMs`.
      const remaining = Math.max(1, deadline - Date.now());
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(READINESS_PROBE_TIMEOUT_MS, remaining)),
      });
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
